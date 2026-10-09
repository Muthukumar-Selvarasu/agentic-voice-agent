"""Serve a tiny browser client for testing local LiveKit audio.

Run this after `./start_local_server.sh`, then open http://localhost:5173.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import warnings
import unicodedata
import wave
from difflib import SequenceMatcher
from io import BytesIO
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import jwt
from livekit import api

from env_loader import load_env_files

ROOT = Path(__file__).resolve().parent
ASSIGNMENT_ROOT = ROOT.parent
PIPELINE_ROOT = ASSIGNMENT_ROOT / "pipeline"

_session_registry_lock = threading.Lock()
_agent_sessions: dict[str, object] = {}
_session_locks: dict[str, threading.Lock] = {}
_last_spoken: dict[str, str] = {}
_request_generations: dict[str, int] = {}
_response_deliveries: dict[str, dict[str, dict]] = {}
_playback_references: dict[str, dict[str, bytes]] = {}

GREETING = "Thanks for calling Aurora Hotel reservations. How can I help?"


def _load_env_files() -> None:
    load_env_files((PIPELINE_ROOT / ".env", ROOT / ".env"))


def _agent_provider_name() -> str:
    return os.getenv("PROVIDER", "mock").lower()


def _livekit_url() -> str:
    raw = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
    if raw.startswith("http://"):
        return "ws://" + raw[len("http://"):]
    if raw.startswith("https://"):
        return "wss://" + raw[len("https://"):]
    return raw


def _livekit_api_key() -> str:
    return os.getenv("LIVEKIT_API_KEY", "devkey")


def _livekit_api_secret() -> str:
    return os.getenv("LIVEKIT_API_SECRET", "secret")


def _livekit_room() -> str:
    return os.getenv("LIVEKIT_ROOM", "aurora-demo-room")


def listen_address() -> tuple[str, int]:
    """Keep the local workshop on localhost:5173.

    Railway injects PORT and does not set TALK_PORT. That path must bind all
    interfaces. An explicit TALK_PORT keeps the local demo on its own port.
    """
    railway_port = os.getenv("PORT", "").strip()
    talk_port = os.getenv("TALK_PORT", "").strip()
    if railway_port and not talk_port:
        host = os.getenv("TALK_HOST", "0.0.0.0").strip() or "0.0.0.0"
        return host, int(railway_port)
    host = os.getenv("TALK_HOST", "localhost").strip() or "localhost"
    return host, int(talk_port or "5173")


def hosted_bind(host: str) -> bool:
    return host not in {"localhost", "127.0.0.1", "::1"}


def hosted_config_errors() -> list[str]:
    """Refuse a public bind that is still using the local workshop defaults.

    Error text names the missing settings and never includes secret values.
    """
    errors: list[str] = []
    url = _livekit_url()
    if url.startswith("ws://") or "localhost" in url or "127.0.0.1" in url:
        errors.append("Set LIVEKIT_URL to a wss LiveKit Cloud endpoint.")
    key = _livekit_api_key()
    secret = _livekit_api_secret()
    if key in {"", "devkey"} or secret in {"", "secret"}:
        errors.append(
            "Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET to LiveKit Cloud credentials."
        )
    provider = _agent_provider_name()
    if provider not in {"groq", "openai"}:
        errors.append("Set PROVIDER to groq or openai.")
    elif provider == "groq" and not os.getenv("GROQ_API_KEY", "").strip():
        errors.append("Set GROQ_API_KEY in the host environment.")
    elif provider == "openai" and not os.getenv("OPENAI_API_KEY", "").strip():
        errors.append("Set OPENAI_API_KEY in the host environment.")
    if os.getenv("TELEMETRY_INCLUDE_CONTENT", "false").strip().lower() == "true":
        errors.append("Keep TELEMETRY_INCLUDE_CONTENT=false.")
    return errors


def _new_agent():
    if str(PIPELINE_ROOT) not in sys.path:
        sys.path.insert(0, str(PIPELINE_ROOT))
    from agent import Agent
    from providers import make_provider

    return Agent(make_provider(_agent_provider_name()))


def _get_session(session_id: str):
    with _session_registry_lock:
        if session_id not in _agent_sessions:
            _agent_sessions[session_id] = _new_agent()
            _session_locks[session_id] = threading.Lock()
        return _agent_sessions[session_id], _session_locks[session_id]


def _reset_session(session_id: str) -> None:
    with _session_registry_lock:
        _agent_sessions.pop(session_id, None)
        _session_locks.pop(session_id, None)
        _last_spoken.pop(session_id, None)
        _request_generations.pop(session_id, None)
        _response_deliveries.pop(session_id, None)
        _playback_references.pop(session_id, None)


def _admit_generation(session_id: str, generation: int | None) -> None:
    if generation is not None:
        with _session_registry_lock:
            _request_generations[session_id] = max(generation, _request_generations.get(session_id, 0))
            for record in _response_deliveries.get(session_id, {}).values():
                if record.get("generation") is not None and record["generation"] < generation and record.get("state") is None:
                    # Conservative fallback if the browser's delivery feedback
                    # was lost: an older prepared reply is never assumed heard.
                    record["state"] = "discarded"


def _superseded(session_id: str, generation: int | None) -> bool:
    with _session_registry_lock:
        return generation is not None and generation < _request_generations.get(session_id, 0)


def _playback_feedback(
    session_id: str,
    turn_id: str,
    state: str,
    generation: int | None = None,
    heard_through_ms: float | None = None,
    playback_duration_ms: float | None = None,
) -> dict:
    if state not in {"completed", "interrupted", "discarded"}:
        raise ValueError("Invalid playback state")
    for value in (heard_through_ms, playback_duration_ms):
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0 or value > 3600000):
            raise ValueError("Invalid playback position")
    if (heard_through_ms is None) != (playback_duration_ms is None):
        raise ValueError("Incomplete playback position")
    _admit_generation(session_id, generation)
    with _session_registry_lock:
        record = _response_deliveries.setdefault(session_id, {}).setdefault(turn_id, {})
        # Out-of-order interruption must not overwrite a completed delivery.
        if record.get("state") != "completed":
            record["state"] = state
            if state in {"interrupted", "completed"} and playback_duration_ms:
                record["heard_through_ms"] = min(heard_through_ms, playback_duration_ms)
                record["playback_duration_ms"] = playback_duration_ms
    return {"acknowledged": True}


def _register_delivery(agent, session_id: str, turn_id: str | None, reply: str, generation: int | None = None) -> None:
    if turn_id is None:
        return
    messages = getattr(agent, "messages", [])
    message = messages[-1] if isinstance(messages, list) and messages else None
    if not isinstance(message, dict) or message.get("role") != "assistant" or message.get("content") != reply:
        message = None
    with _session_registry_lock:
        records = _response_deliveries.setdefault(session_id, {})
        record = records.setdefault(turn_id, {})
        record.update(message=message, original=reply, generation=generation)
        # Keep only recent delivery metadata; conversation messages remain intact.
        while len(records) > 32:
            records.pop(next(iter(records)))


def _interrupted_playback_note(record: dict) -> str:
    heard_ms = record.get("heard_through_ms")
    duration_ms = record.get("playback_duration_ms")
    original = record.get("original", "")
    if not isinstance(heard_ms, (int, float)) or not isinstance(duration_ms, (int, float)) or duration_ms <= 0 or not original:
        return ("[Playback note: Aurora's voice reply was interrupted. "
                "Do not assume the caller heard the full reply or agreed to anything in it.]")

    fraction = min(1.0, max(0.0, heard_ms / duration_ms))
    prefix_end = round(len(original) * fraction)
    if prefix_end < len(original):
        word_end = original.rfind(" ", 0, prefix_end + 1)
        if word_end > 0:
            prefix_end = word_end
    heard = original[:prefix_end].strip()
    if len(heard) > 1200:
        heard = heard[:heard.rfind(" ", 0, 1200)].rstrip()
    if not heard:
        return ("[Playback note: Aurora's voice reply was interrupted near the start. "
                "Do not assume the caller heard the full reply or agreed to anything in it.]")
    return (f"[Playback note: Aurora's voice reply was interrupted at about {fraction:.0%} of its audio. "
            f"Approximate portion already spoken: {heard!r}. The caller may not have heard the rest. "
            "Do not repeat the approximate portion unless asked, do not resume or complete the unspoken remainder of this reply, and do not assume the caller heard or agreed to the remainder. Respond directly to the caller's newest input.]")


def _apply_delivery_feedback(agent, session_id: str) -> None:
    messages = getattr(agent, "messages", None)
    if not isinstance(messages, list):
        return
    with _session_registry_lock:
        records = list(_response_deliveries.get(session_id, {}).values())
        for record in records:
            message = record.get("message")
            if message is None:
                continue
            index = next((i for i, item in enumerate(messages) if item is message), None)
            if index is None:
                continue
            state = record.get("state")
            if state == "discarded":
                messages.pop(index)
            elif state == "interrupted":
                message["content"] = _interrupted_playback_note(record)
            elif state == "completed":
                message["content"] = record["original"]


def _discard_superseded(agent, trace, session_id, turn_id, generation) -> dict | None:
    if not _superseded(session_id, generation):
        return None
    if turn_id is not None:
        _playback_feedback(session_id, turn_id, "discarded")
    _apply_delivery_feedback(agent, session_id)
    trace.event("response.superseded")
    return _finish_response(agent, trace, "", None, ignored=True,
                            ignoreReason="superseded", response_sources=[])


def _remember_spoken(session_id: str, text: str) -> None:
    with _session_registry_lock:
        _last_spoken[session_id] = text


def _remember_audio(session_id: str, turn_id: str | None, tts: dict) -> None:
    encoded = tts.get("audioBase64")
    if not turn_id or not encoded or len(encoded) > 12 * 1024 * 1024:
        return
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        return
    with _session_registry_lock:
        references = _playback_references.setdefault(session_id, {})
        references[turn_id] = audio
        while len(references) > 2:
            references.pop(next(iter(references)))
        while len(_playback_references) > 8:
            _playback_references.pop(next(iter(_playback_references)))


def _playback_residual(
    audio: bytes,
    session_id: str,
    reference_id: str | None,
    offset_ms: float | None,
    playback_through_ms: float | None = None,
):
    if not reference_id:
        return None
    with _session_registry_lock:
        reference = _playback_references.get(session_id, {}).get(reference_id)
    if not reference:
        return None
    with _session_registry_lock:
        delivery = _response_deliveries.get(session_id, {}).get(reference_id, {})
        playback_end_ms = playback_through_ms
        if playback_end_ms is None and delivery.get("state") in {"interrupted", "completed"}:
            playback_end_ms = delivery.get("heard_through_ms")
    try:
        from echo_detector import residual_audio
        result = residual_audio(audio, reference, offset_ms, playback_end_ms)
        if result is None and offset_ms is not None:
            result = residual_audio(audio, reference, None)
            if result is not None:
                result[1]["offsetSearchFallback"] = True
        return result
    except Exception:
        # Missing optional local dependencies keep the existing speech/text path.
        return None


def _last_spoken_text(session_id: str) -> str:
    with _session_registry_lock:
        return _last_spoken.get(session_id, "")


def _trace(session_id: str, turn_id: str | None = None):
    if str(PIPELINE_ROOT) not in sys.path:
        sys.path.insert(0, str(PIPELINE_ROOT))
    from telemetry import TurnTrace

    return TurnTrace(session_id=session_id, turn_id=turn_id)


def _finish_response(agent, trace, reply: str, action: str | None, **extra) -> dict:
    from telemetry import write_trace

    sources = extra.pop("response_sources", agent.last_sources)
    payload = trace.finish(action=action, sources=sources)
    write_trace(payload)
    return {
        "reply": reply,
        "action": action,
        "provider": getattr(agent.provider, "name", _agent_provider_name()),
        "model": getattr(agent.provider, "llm_model", "unknown"),
        "language": agent.current_language,
        "locale": agent.current_locale,
        "sources": sources,
        "trace": payload,
        **extra,
    }


_MONTHS_TA = {
    1: "ஜனவரி", 2: "பிப்ரவரி", 3: "மார்ச்", 4: "ஏப்ரல்", 5: "மே", 6: "ஜூன்",
    7: "ஜூலை", 8: "ஆகஸ்ட்", 9: "செப்டம்பர்", 10: "அக்டோபர்", 11: "நவம்பர்", 12: "டிசம்பர்",
}
_MONTHS_EN = {
    1: "January", 2: "February", 3: "March", 4: "April", 5: "May", 6: "June",
    7: "July", 8: "August", 9: "September", 10: "October", 11: "November", 12: "December",
}
_MONTHS_ES = {
    1: "enero", 2: "febrero", 3: "marzo", 4: "abril", 5: "mayo", 6: "junio",
    7: "julio", 8: "agosto", 9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre",
}


def _verbalize_for_tts(text: str, locale: str = "en-US") -> str:
    """Normalize written text into natural spoken forms for TTS (dates, codes, currency)."""
    lang = locale.split("-")[0].lower()

    # 1. ISO dates: YYYY-MM-DD -> spoken month, day, year
    def _replace_date(match):
        year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
        if 1 <= month <= 12:
            if lang == "ta":
                return f"{_MONTHS_TA[month]} {day}, {year}"
            elif lang == "es":
                return f"{day} de {_MONTHS_ES[month]} de {year}"
            else:
                return f"{_MONTHS_EN[month]} {day}, {year}"
        return match.group(0)

    text = re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b", _replace_date, text)

    # 2. Confirmation/reservation codes like AH-4827 -> A H 4 8 2 7
    def _replace_code(match):
        letters = " ".join(match.group(1))
        digits = " ".join(match.group(2))
        return f"{letters} {digits}"

    text = re.sub(r"\b([A-Z]{2,4})-(\d{3,6})\b", _replace_code, text)

    # 3. Currency symbols: $24 -> 24 dollars / 24 dólares / 24 டாலர்
    if lang == "ta":
        text = re.sub(r"\$(\d+(?:\.\d+)?)", r"\1 டாலர்", text)
        # Detach hyphenated Tamil grammatical suffixes from times/numbers (e.g. 3PM-இல் -> 3 PM இல்)
        text = re.sub(r"(\d+)\s*(AM|PM)-([அ-ஹ]+)", r"\1 \2 \3", text, flags=re.IGNORECASE)
    elif lang == "es":
        text = re.sub(r"\$(\d+(?:\.\d+)?)", r"\1 dólares", text)
    else:
        text = re.sub(r"\$(\d+(?:\.\d+)?)", r"\1 dollars", text)

    return text


def _system_tts_audio(text: str, locale: str) -> tuple[bytes, str] | None:
    """Render the configured macOS system voice without playing it on the host.

    Browser audio gives capture processing a browser playout source and supports
    exact pause/resume. Native speechSynthesis failed to pause in the live embed.
    Other hosts keep the existing browser voice fallback.
    """
    if sys.platform != "darwin":
        return None
    command = shutil.which(os.getenv("SYSTEM_TTS_CMD", "say"))
    if not command:
        return None
    spoken_text = _verbalize_for_tts(text, locale)
    voice = {"en": "Samantha", "es": "Mónica", "ta": "Vani"}.get(locale.split("-")[0], "Samantha")
    with tempfile.TemporaryDirectory(prefix="aurora-system-tts-") as directory:
        output = Path(directory) / "speech.wav"
        subprocess.run(
            [command, "-v", voice, "-r", "176", "-o", str(output),
             "--file-format=WAVE", "--data-format=LEI16@24000"],
            input=spoken_text, text=True, capture_output=True, check=True, timeout=20,
        )
        with wave.open(str(output)) as recording:
            if recording.getnframes() == 0:
                raise ValueError("Empty system speech")
        return output.read_bytes(), voice


def _browser_tts_payload(agent, trace, text: str) -> dict:
    """Return provider audio for the browser or select its local voice fallback."""
    provider = agent.provider
    backend = getattr(provider, "tts_backend", "provider")
    if backend == "system" and getattr(provider, "name", "") != "mock":
        try:
            with trace.span("tts", backend="system"):
                rendered = _system_tts_audio(text, getattr(agent, "current_locale", "en-US"))
            if rendered:
                audio, voice = rendered
                return {
                    "ttsBackend": "system", "ttsVoice": voice,
                    "audioContentType": "audio/wav",
                    "audioBase64": base64.b64encode(audio).decode("ascii"),
                }
        except Exception as exc:
            trace.event("tts.fallback", errorType=type(exc).__name__)
        return {"ttsBackend": "browser", "ttsFallback": True}
    if backend != "provider" or getattr(provider, "name", "") == "mock":
        return {"ttsBackend": "browser"}

    model = getattr(provider, "tts_model", "unknown")
    voice = getattr(provider, "tts_voice", "unknown")
    try:
        with trace.span("tts", model=model, voice=voice):
            audio = provider.synthesize(text)
    except Exception as exc:
        trace.event("tts.fallback", errorType=type(exc).__name__)
        return {"ttsBackend": "browser", "ttsFallback": True}

    if not audio:
        trace.event("tts.fallback", errorType="EmptyAudio")
        return {"ttsBackend": "browser", "ttsFallback": True}
    return {
        "ttsBackend": "provider",
        "ttsModel": model,
        "ttsVoice": voice,
        "audioContentType": "audio/wav",
        "audioBase64": base64.b64encode(audio).decode("ascii"),
    }


def _greeting_reply(session_id: str) -> dict:
    agent, lock = _get_session(session_id)
    trace = _trace(session_id, "greeting")
    trace.event("greeting.requested")
    with lock:
        tts = _browser_tts_payload(agent, trace, GREETING)
    _remember_spoken(session_id, GREETING)
    _remember_audio(session_id, "greeting", tts)
    return _finish_response(
        agent,
        trace,
        GREETING,
        None,
        responseTurnId="greeting",
        response_sources=[],
        **tts,
    )


def _agent_reply(text: str, session_id: str, turn_id: str | None, generation: int | None = None) -> dict:
    _admit_generation(session_id, generation)
    agent, lock = _get_session(session_id)
    trace = _trace(session_id, turn_id)
    trace.event("input.text")
    with lock:
        _apply_delivery_feedback(agent, session_id)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        reply, action = agent.respond(text, trace=trace)
        _register_delivery(agent, session_id, turn_id, reply, generation)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        tts = _browser_tts_payload(agent, trace, reply)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        _remember_spoken(session_id, reply)
        _remember_audio(session_id, turn_id, tts)
        return _finish_response(agent, trace, reply, action, responseTurnId=turn_id, **tts)


def _speech_evidence(audio: bytes) -> dict | None:
    """Classify locally; keep unverified input when dependencies are unavailable."""
    if len(audio) < 32:
        return None
    try:
        from speech_detector import classify_audio
        return classify_audio(audio)
    except Exception:
        return None


def _is_confident_no_speech(stt, speech_evidence: dict | None = None) -> bool:
    """Use local speech evidence, falling back to conservative STT metadata.

    Without local evidence, missing metadata and any confident speech segment
    keep the transcript, including short replies and non-English speech.
    """
    if speech_evidence is not None:
        # Neural speech evidence takes precedence over STT confidence. Whisper
        # confidently invents text for transient noise and even digital silence.
        return speech_evidence["maxSpeechProbability"] < speech_evidence["speechThreshold"]
    segments = getattr(stt, "segments", None)
    if not segments:
        return False
    for segment in segments:
        value = segment.get if isinstance(segment, dict) else lambda key: getattr(segment, key, None)
        silence = value("no_speech_prob")
        confidence = value("avg_logprob")
        if not isinstance(silence, (int, float)) or not isinstance(confidence, (int, float)):
            return False
        if not (silence > 0.6 and confidence < -1.0):
            return False
    return True


def _speech_activity_reply(audio: bytes, session_id: str, turn_id: str | None) -> dict:
    """Local endpoint evidence only: never acquire an agent or invoke STT/TTS."""
    trace = _trace(session_id, turn_id)
    with trace.span("vad"):
        evidence = _speech_evidence(audio)
    trace.event("vad.activity", available=evidence is not None, **(evidence or {}))
    from telemetry import write_trace
    payload = trace.finish()
    write_trace(payload)
    return {"speechEvidence": evidence, "trace": payload}


def _voice_agent_reply(
    audio: bytes,
    content_type: str,
    session_id: str,
    turn_id: str | None,
    was_barge_in: bool,
    after_playback: bool = False,
    check_only: bool = False,
    client_timings: dict | None = None,
    generation: int | None = None,
    reference_id: str | None = None,
    playback_offset_ms: float | None = None,
    playback_through_ms: float | None = None,
) -> dict:
    agent, lock = _get_session(session_id)
    trace = _trace(session_id, turn_id)
    trace.event("audio.received", bytes=len(audio), contentType=content_type)
    if client_timings:
        trace.event("client.timing", **client_timings)
    no_speech = False
    stt = None
    speech_evidence = None
    echo_evidence = None
    if getattr(agent.provider, "name", "") == "mock":
        with trace.span("stt", model=getattr(agent.provider, "stt_model", "unknown")):
            transcript = agent.provider.transcribe(b"")
    else:
        with _session_registry_lock:
            reference_available = bool(
                reference_id and _playback_references.get(session_id, {}).get(reference_id)
            )
        trace.event("playback.reference", provided=bool(reference_id),
                    available=reference_available, offsetProvided=playback_offset_ms is not None,
                    offsetMs=round(playback_offset_ms, 1) if playback_offset_ms is not None else None,
                    throughProvided=playback_through_ms is not None,
                    throughMs=round(playback_through_ms, 1) if playback_through_ms is not None else None)
        with trace.span("echo"):
            residual = _playback_residual(
                audio, session_id, reference_id, playback_offset_ms, playback_through_ms,
            )
        if residual is None and reference_id and reference_available:
            trace.event("playback.reference_unmatched")
        if residual is not None:
            clean_audio, echo_evidence = residual
            if echo_evidence.get("residualEnergyFraction", 1.0) <= 0.0001:
                # Only a practically empty residue can bypass speech detection.
                # Quiet caller speech beneath playback can have less than 2%
                # of its energy and still contain a clearly detectable answer.
                trace.event("playback.echo_suppressed", reason="low_residual_energy", **echo_evidence)
                return _finish_response(agent, trace, "", None, transcript="",
                    sttModel=getattr(agent.provider, "stt_model", "unknown"),
                    ignored=True, ignoreReason="probable_playback_echo", response_sources=[],
                    echoEvidence=echo_evidence)
            with trace.span("vad"):
                residual_speech = _speech_evidence(clean_audio)
            trace.event("playback.residual", **echo_evidence, speechEvidence=residual_speech)
            if residual_speech is not None and _is_confident_no_speech(None, residual_speech):
                return _finish_response(agent, trace, "", None, transcript="",
                    sttModel=getattr(agent.provider, "stt_model", "unknown"),
                    ignored=True, ignoreReason="probable_playback_echo", response_sources=[],
                    speechEvidence=residual_speech, echoEvidence=echo_evidence)
            if residual_speech is not None:
                audio, content_type = clean_audio, "audio/wav"
                speech_evidence = residual_speech
        if speech_evidence is None:
            with trace.span("vad"):
                speech_evidence = _speech_evidence(audio)
        trace.event("vad.evidence", available=speech_evidence is not None, **(speech_evidence or {}))
        if speech_evidence is not None and _is_confident_no_speech(None, speech_evidence):
            trace.event("stt.no_speech_suppressed", detector="silero")
            return _finish_response(
                agent, trace, "", None, transcript="",
                sttModel=getattr(agent.provider, "stt_model", "unknown"),
                ignored=True, ignoreReason="no_speech", response_sources=[],
                speechEvidence=speech_evidence,
            )
        audio_file = BytesIO(audio)
        if "wav" in content_type:
            audio_file.name = "caller.wav"
        elif "mp4" in content_type:
            audio_file.name = "caller.mp4"
        elif "ogg" in content_type:
            audio_file.name = "caller.ogg"
        else:
            audio_file.name = "caller.webm"
        current_lang = getattr(agent, "current_language", "en") or "en"
        with trace.span("stt", model=getattr(agent.provider, "stt_model", "unknown"), language=current_lang):
            transcription_args = {
                "model": agent.provider.stt_model,
                "file": audio_file,
                # Whisper exposes silence/confidence metadata without
                # changing the configured model. Other STT APIs keep text.
                "response_format": "verbose_json" if agent.provider.stt_model.startswith("whisper-") else "text",
            }
            if current_lang in ("en", "es", "ta"):
                transcription_args["language"] = current_lang
            if hasattr(agent.provider, "get_stt_prompt"):
                stt_prompt = agent.provider.get_stt_prompt(current_lang)
            else:
                stt_prompt = getattr(agent.provider, "stt_prompt", "")
            if stt_prompt:
                transcription_args["prompt"] = stt_prompt
            stt = agent.provider.client.audio.transcriptions.create(**transcription_args)
        transcript = (stt if isinstance(stt, str) else stt.text).strip()
        no_speech = _is_confident_no_speech(stt, speech_evidence)
        segments = getattr(stt, "segments", None) or []
        trace.event("stt.confidence", segments=[
            {key: segment.get(key) if isinstance(segment, dict) else getattr(segment, key, None)
             for key in ("no_speech_prob", "avg_logprob")}
            for segment in segments
        ])
    if no_speech:
        trace.event("stt.no_speech_suppressed")
        return _finish_response(
            agent, trace, "", None,
            transcript=transcript,
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            ignored=True, ignoreReason="no_speech", response_sources=[],
        )
    if _is_weak_truncated_playback_echo(echo_evidence, speech_evidence, stt):
        trace.event("playback.echo_suppressed", reason="weak_truncated_residual", **echo_evidence)
        return _finish_response(
            agent, trace, "", None, transcript="",
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            ignored=True, ignoreReason="probable_playback_echo", response_sources=[],
            speechEvidence=speech_evidence, echoEvidence=echo_evidence,
        )
    if ((was_barge_in or after_playback or check_only)
            and _is_correlated_residual_echo(
                transcript, _last_spoken_text(session_id), echo_evidence, speech_evidence,
            )):
        trace.event("playback.echo_suppressed", reason="correlated_spoken_fragment", **(echo_evidence or {}))
        return _finish_response(
            agent, trace, "", None, transcript="",
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            ignored=True, ignoreReason="probable_playback_echo", response_sources=[],
            speechEvidence=speech_evidence, echoEvidence=echo_evidence,
        )
    # Speaker bleed often arrives as a normal turn right after TTS ends, not
    # only as an X-Barge-In interrupt. Suppress only clear playback copies —
    # never drop a deliberate barge-in / courtesy like "நன்றி".
    last_spoken = _last_spoken_text(session_id)
    probable_echo = _is_probable_playback_echo(
        transcript, last_spoken, barge_in=was_barge_in or check_only,
        echo_evidence=echo_evidence,
    )
    numeric_echo = ((was_barge_in or check_only)
                    and _is_correlated_numeric_echo(transcript, last_spoken, echo_evidence))
    if (was_barge_in or after_playback or check_only) and (probable_echo or numeric_echo):
        trace.event(
            "barge_in.echo_suppressed",
            transcript=transcript,
            afterPlayback=after_playback,
            wasBargeIn=was_barge_in,
            correlatedNumericFragment=numeric_echo,
        )
        return _finish_response(
            agent,
            trace,
            "",
            None,
            transcript=transcript,
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            ignored=True,
            ignoreReason="probable_playback_echo",
            response_sources=[],
            speechEvidence=speech_evidence,
        )
    if check_only:
        trace.event("barge_in.input_confirmed")
        return _finish_response(
            agent, trace, "", None, transcript=transcript,
            inputConfirmed=True, response_sources=[],
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            speechEvidence=speech_evidence,
        )
    # Do not let noise or playback echo supersede a useful response that is
    # still being prepared. A generation becomes active only after speech has
    # passed local VAD, transcription, and playback-echo checks.
    _admit_generation(session_id, generation)
    with lock:
        _apply_delivery_feedback(agent, session_id)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        if was_barge_in:
            trace.event("barge_in.turn_started")
        reply, action = agent.respond(transcript, trace=trace)
        _register_delivery(agent, session_id, turn_id, reply, generation)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        tts = _browser_tts_payload(agent, trace, reply)
        stale = _discard_superseded(agent, trace, session_id, turn_id, generation)
        if stale is not None:
            return stale
        _remember_spoken(session_id, reply)
        _remember_audio(session_id, turn_id, tts)
        return _finish_response(
            agent,
            trace,
            reply,
            action,
            transcript=transcript,
            responseTurnId=turn_id,
            sttModel=getattr(agent.provider, "stt_model", "unknown"),
            **tts,
        )


def _normalize_utterance(text: str) -> str:
    stripped = unicodedata.normalize("NFKC", text.lower()).replace("’", "'")
    stripped = "".join(" " if unicodedata.category(char) == "Pd" else char for char in stripped)
    for mark in ("'", ".", ",", "!", "?", "¡", "¿", "।", "…", ";", ":"):
        stripped = stripped.replace(mark, "")
    return " ".join(stripped.split())


def _is_correlated_numeric_echo(transcript: str, spoken: str, evidence: dict | None) -> bool:
    """Catch short numeric STT fragments from a strong, loud playback residual."""
    if not evidence:
        return False
    try:
        correlation = float(evidence.get("correlation", 0))
        residual_fraction = float(evidence.get("residualEnergyFraction", 1))
        residual_gain = float(evidence.get("residualGain", 4))
    except (TypeError, ValueError):
        return False
    if correlation < 0.70 or residual_fraction < 0.15 or residual_gain > 1.5:
        return False
    transcript_numbers = re.findall(r"\d+", transcript)
    spoken_numbers = re.findall(r"\d+", spoken)
    if not transcript_numbers or not spoken_numbers:
        return False
    # Whisper commonly attaches a one-word lead-in to a clipped price
    # ("for 189" from "$189 per night"). Treat it as a numeric fragment only
    # when the rest of the transcript is an acoustic stub; explicit caller
    # corrections and complete room selections remain eligible.
    normalized = _normalize_utterance(transcript)
    context_words = re.findall(r"[a-z]+", normalized)
    if {"no", "not", "actually", "instead", "rather", "change", "correct",
            "said", "meant", "should", "make", "want", "need", "how", "about"}.intersection(context_words):
        return False
    if {"standard", "queen", "king", "deluxe", "suite", "family", "accessible",
            "harbor", "view", "room"}.intersection(context_words):
        return False
    if len(context_words) > 3:
        return False
    if any(len(number) >= 2 and len(spoken_number) > len(number) and number in spoken_number
           for number in transcript_numbers for spoken_number in spoken_numbers):
        return True
    # A loud correlated residue can add or replace a digit as well as drop
    # one (the browser reproduced "$1,999" from a spoken "$199").
    digits = "".join(transcript_numbers)
    for number in spoken_numbers:
        if len(digits) == 1 and digits in number:
            return True
        if (min(len(digits), len(number)) >= 2
                and abs(len(digits) - len(number)) <= 1
                and SequenceMatcher(None, digits, number).ratio() >= .34):
            return True
        if min(len(digits), len(number)) < 3:
            continue
        if len(digits) == len(number) and sum(a != b for a, b in zip(digits, number)) <= 2:
            return True
        longer, shorter = sorted((digits, number), key=len, reverse=True)
        if len(longer) == len(shorter) + 1 and any(
                longer[:index] + longer[index + 1:] == shorter for index in range(len(longer))):
            return True
    return False


def _is_correlated_residual_echo(
    transcript: str, spoken: str, evidence: dict | None, speech: dict | None,
) -> bool:
    """Reject ASR fragments that track playback but survive imperfect subtraction.

    Residual Silero can still report speech on a loud speaker copy because tiny
    alignment errors retain the reply's voiced envelope. Strong correlation,
    small residual energy, and a close match to the reply identify that case;
    very short independent answers and named room choices remain eligible.
    """
    if not evidence or not speech:
        return False
    try:
        correlation = float(evidence.get("correlation", 0))
        residual_fraction = float(evidence.get("residualEnergyFraction", 1))
        residual_gain = float(evidence.get("residualGain", 1))
        if (correlation < .98 or residual_fraction > .03 or residual_gain < 3
                or float(speech.get("voicedFraction", 0)) < .7):
            return False
    except (TypeError, ValueError):
        return False

    candidate = _normalize_utterance(transcript)
    spoken_norm = _normalize_utterance(spoken)
    if not candidate or not spoken_norm:
        return False
    words = candidate.split()
    if any(marker in words for marker in (
        "no", "not", "actually", "instead", "rather", "change", "correct",
    )):
        return False

    # Preserve meaningful room selections even when the agent is saying the
    # same options; the fixture repeatedly heard these while presenting them.
    selections = {
        "standard queen", "king room", "standard room", "queen room",
        "deluxe king", "family room", "accessible room", "ocean view", "garden view",
    }
    caller_words = [word for word in words if word not in {"a", "an", "the", "please", "i", "want", "need"}]
    if any(selection in " ".join(caller_words) for selection in selections):
        return False

    candidate_numbers = re.findall(r"\d+", candidate)
    spoken_numbers = re.findall(r"\d+", spoken_norm)
    if candidate_numbers and spoken_numbers:
        # Whisper may turn the last audible digit into a short numeric stub or
        # substitute digits while the speaker is still dominant. Explicit
        # corrections above remain caller turns.
        for number in candidate_numbers:
            for source in spoken_numbers:
                if number in source or source in number:
                    return True
                if min(len(number), len(source)) >= 2:
                    longer, shorter = sorted((number, source), key=len, reverse=True)
                    if len(longer) - len(shorter) <= 1 and sum(a != b for a, b in zip(longer, shorter)) <= 2:
                        return True

    # When subtraction leaves less than 1% of the mic energy and the 1 kHz
    # reference still correlates above .995, residual Silero can report speech
    # on playback artifacts that Whisper turns into unrelated short phrases
    # (observed as "Aurora Hotel" during a room-rate list). Clear corrections,
    # choices and numbers above remain caller input.
    if correlation >= .995 and residual_fraction <= .008 and residual_gain >= 3:
        return True

    # Small deterministic spelling confusion observed for the spoken room
    # option: “a Deluxe King” is often heard as “a delight.” Only apply it
    # under the strict acoustic evidence gate above.
    if "deluxe king" in spoken_norm and candidate in {"a delight", "delight", "a deluxe", "deluxe"}:
        return True
    # Whisper can replace several words in a residual fragment while keeping
    # its timing and surrounding phrase. Compare local windows rather than
    # requiring the whole assistant response to match.
    tokens = candidate.split()
    if len(tokens) >= 4:
        source = spoken_norm.split()
        for start in range(len(source)):
            for width in range(max(3, len(tokens) - 2), len(tokens) + 3):
                fragment = " ".join(source[start:start + width])
                if fragment and SequenceMatcher(None, candidate, fragment).ratio() >= .78:
                    return True
    return False


def _is_weak_truncated_playback_echo(
    evidence: dict | None, speech_evidence: dict | None, stt,
) -> bool:
    """Reject weak Whisper fragments after only a tiny interrupted audio prefix."""
    if not evidence or not speech_evidence or not getattr(stt, "segments", None):
        return False
    try:
        if (not evidence.get("truncatedPlayback")
                or float(evidence.get("correlation", 0)) < .82
                or float(evidence.get("matchedMs", 0)) > 350
                or float(evidence.get("residualEnergyFraction", 1)) < .35
                or float(evidence.get("residualGain", 4)) > 2.5
                or float(speech_evidence.get("voicedFraction", 1)) > .3):
            return False
    except (TypeError, ValueError):
        return False
    for segment in stt.segments:
        value = segment.get if isinstance(segment, dict) else lambda key: getattr(segment, key, None)
        silence = value("no_speech_prob")
        confidence = value("avg_logprob")
        if not isinstance(silence, (int, float)) or not isinstance(confidence, (int, float)):
            return False
        if silence > .4 or confidence > -1.0:
            return False
    return True


# Whisper / browser-TTS hallucinations only — not real caller courtesies.
_ECHO_HALLUCINATIONS = {
    "thank you for watching",
    "thanks for watching",
    "subtitles by",
    "amara org",
    "amara",
    "see you next time",
}

# Short Whisper fillers from speaker bleed mid-playback. Keep real answers like yes/wait/stop.
_BARGE_ECHO_FILLERS = {
    "thanks",
    "thank you",
    "thank",
    "well",
    "so",
    "the",
    "a",
    "um",
    "uh",
    "hmm",
    "hm",
    "you",
    "i",
    "and",
    "hotel",
    "okay so",
    "oh",
}


def _is_probable_playback_echo(
    transcript: str,
    spoken: str = "",
    *,
    barge_in: bool = False,
    echo_evidence: dict | None = None,
) -> bool:
    """Ignore audio that is only Aurora's own speaker playback coming back.

    A real interruption such as "Wait, speak Tamil", "Standard Queen", or "Yes" is kept.
    Only near-duplicate STT of the line Aurora spoke without caller input is treated as echo.
    """
    normalized = _normalize_utterance(transcript)
    if not normalized:
        return True
    if len(normalized) <= 1:
        return True

    if normalized in _ECHO_HALLUCINATIONS:
        return True
    if any(h in normalized for h in ("watching", "subtitles by", "amara.org", "amara org")):
        return True

    spoken_norm = _normalize_utterance(spoken)
    if not spoken_norm:
        return False

    if barge_in:
        if normalized in _BARGE_ECHO_FILLERS:
            return True
        # Single-token bleed of a word Aurora just said (e.g. "hotel", "assist", "today").
        tokens = normalized.split()
        spoken_words = set(spoken_norm.split())
        short_answers = {
            "yes", "no", "wait", "stop", "tamil", "english", "hello", "hi",
            "standard", "king", "queen", "suite", "family", "accessible",
            "standard queen", "standard room", "king room", "family room",
            "accessible room", "standard queen room", "deluxe king", "deluxe king room",
            "ocean view", "garden view",
        }
        if normalized in short_answers:
            return False
        # A recorded preview is usually only part of the playing reply. The
        # previous whole-reply-only comparison accepted those echo fragments.
        # Novel interruption words must survive even when mixed with echo.
        if any(word in {"wait", "stop", "tamil", "english"} and word not in spoken_words for word in tokens):
            return False
        # Strong reference correlation can leave a speech-like residual that
        # Whisper hears as a near-match (for example, "stand-up" for "standard").
        # Preserve short answers and topic questions, but reject longer phrases
        # that closely track playback when the residual was not boosted like
        # quiet caller speech.
        if echo_evidence and len(tokens) >= 4:
            try:
                correlated = float(echo_evidence.get("correlation", 0)) >= 0.9
                residual_gain = float(echo_evidence.get("residualGain", 4))
            except (TypeError, ValueError):
                correlated, residual_gain = False, 4
            if correlated and residual_gain <= 3.2:
                spoken_tokens = spoken_norm.split()
                for start in range(len(spoken_tokens)):
                    for width in range(max(3, len(tokens) - 1), len(tokens) + 3):
                        fragment = " ".join(spoken_tokens[start:start + width])
                        if fragment and SequenceMatcher(None, normalized, fragment).ratio() >= 0.80:
                            return True
        if len(tokens) >= 2 and normalized in spoken_norm:
            return True
        if len(tokens) >= 3:
            spoken_tokens = spoken_norm.split()
            # Compare with local windows of the reply, including punctuation,
            # number formatting and a small STT substitution. Comparing only
            # with the complete reply missed partial echo such as "time is
            # 11 a.m." and "could you let me know your name?".
            for start in range(len(spoken_tokens)):
                for width in range(max(2, len(tokens) - 2), len(tokens) + 3):
                    fragment = " ".join(spoken_tokens[start:start + width])
                    if fragment and SequenceMatcher(None, normalized, fragment).ratio() >= 0.88:
                        return True
        if len(tokens) == 1 and tokens[0] in spoken_words and tokens[0] not in {
            "yes", "no", "wait", "stop", "tamil", "english", "hello", "hi",
        }:
            return True
        # Deliberate barge-in: Caller answers/interrupts with choices like "Standard Queen",
        # "ocean view", "yes", "stop", "wait". Never drop answers or short phrases.
        if len(normalized) < 30 or len(normalized.split()) < 6:
            return False
        # Only suppress if the caller audio was pure speaker bleed matching the entire reply:
        return SequenceMatcher(None, normalized, spoken_norm).ratio() >= 0.88

    # Non-barge-in turns:
    # Exact / near copy of the full reply (true speaker echo).
    if SequenceMatcher(None, normalized, spoken_norm).ratio() >= 0.78:
        return True

    # Contiguous fragment of the reply (avoid single shared topic words).
    if len(normalized) >= 12 and normalized in spoken_norm:
        return True

    t_words = [w for w in normalized.split() if len(w) > 1]
    s_words = set(spoken_norm.split())
    if t_words and s_words and len(t_words) <= 6:
        matching = sum(1 for w in t_words if w in s_words)
        overlap = matching / len(t_words)
        if overlap >= 0.85:
            return True

    for piece in spoken_norm.replace("?", ".").split("."):
        piece = piece.strip()
        if len(piece) < 16:
            continue
        ratio = SequenceMatcher(None, normalized, piece).ratio()
        if normalized in piece or piece in normalized or ratio >= 0.85:
            return True
    return False


def _token(identity: str, name: str, room: str) -> str:
    if _livekit_api_secret() == "secret":
        warnings.filterwarnings("ignore", category=jwt.InsecureKeyLengthWarning)
    return (
        api.AccessToken(_livekit_api_key(), _livekit_api_secret())
        .with_identity(identity)
        .with_name(name)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )


def static_no_store(path: str) -> bool:
    """Local demo iterates on talk.js often; avoid sticky cached playback logic."""
    parsed = urlparse(path).path
    return parsed == "/" or parsed.startswith("/web/")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        if static_no_store(self.path):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.path = "/web/index.html"
            return super().do_GET()
        if parsed.path == "/state":
            return self._send_json({
                "livekitRoom": _livekit_room(),
                "livekitUrl": _livekit_url(),
                "agentProvider": _agent_provider_name(),
                "languages": ["en", "es", "ta"],
            })
        if parsed.path != "/token":
            return super().do_GET()

        query = parse_qs(parsed.query)
        identity = query.get("identity", ["caller-demo"])[0]
        name = query.get("name", [identity])[0]
        room = query.get("room", [_livekit_room()])[0]

        payload = {
            "url": _livekit_url(),
            "room": room,
            "identity": identity,
            "token": _token(identity, name, room),
        }
        self._send_json(payload)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        session_id = self.headers.get("X-Session-ID", "browser-demo")
        turn_id = self.headers.get("X-Turn-ID")
        if parsed.path == "/playback-state":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    raise ValueError("Invalid playback state length")
                payload = json.loads(self.rfile.read(length))
                generation = payload.get("generation")
                if generation is not None and (type(generation) is not int or not 0 <= generation <= 1000000):
                    raise ValueError("Invalid request generation")
                heard_through_ms = payload.get("heardThroughMs")
                playback_duration_ms = payload.get("playbackDurationMs")
                result = _playback_feedback(session_id, str(payload.get("turnId", "")),
                                            payload.get("state"), generation,
                                            heard_through_ms, playback_duration_ms)
                return self._send_json(result)
            except (ValueError, TypeError):
                return self._send_json({"error": "Invalid playback state"}, status=400)
        if parsed.path == "/reset":
            _reset_session(session_id)
            return self._send_json({"reset": True, "sessionId": session_id})
        if parsed.path == "/greeting":
            try:
                return self._send_json(_greeting_reply(session_id))
            except Exception as exc:
                return self._send_json({"error": str(exc)}, status=500)
        if parsed.path == "/voice-agent":
            return self._handle_voice_agent(
                session_id,
                turn_id,
                self.headers.get("X-Barge-In", "false").lower() == "true",
                self.headers.get("X-After-Playback", "false").lower() == "true",
                self.headers.get("X-Playback-Check", "false").lower() == "true",
            )
        if parsed.path == "/speech-activity":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError("Invalid speech activity clip size")
                return self._send_json(_speech_activity_reply(self.rfile.read(length), session_id, turn_id))
            except Exception as exc:
                return self._send_json({"error": str(exc)}, status=500)
        if parsed.path != "/agent":
            self.send_error(404, "File not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            payload = json.loads(body or b"{}")
            text = str(payload.get("text", "")).strip()
            if not text:
                raise ValueError("Missing text")
            response = _agent_reply(text, session_id, turn_id, self._request_generation())
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        self._send_json(response)

    def _handle_voice_agent(
        self,
        session_id: str,
        turn_id: str | None,
        was_barge_in: bool = False,
        after_playback: bool = False,
        check_only: bool = False,
    ) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            audio = self.rfile.read(length)
            if not audio:
                raise ValueError("Missing audio")
            client_timings = {}
            for name, header in (
                ("captureMs", "X-Capture-Ms"),
                ("onsetToCheckMs", "X-Onset-To-Check-Ms"),
                ("onsetToPauseMs", "X-Onset-To-Pause-Ms"),
                ("endpointAfterLastSpeechMs", "X-Endpoint-After-Speech-Ms"),
            ):
                try:
                    value = float(self.headers.get(header, ""))
                    if math.isfinite(value) and 0 <= value <= 120000:
                        client_timings[name] = round(value, 1)
                except ValueError:
                    pass
            method = self.headers.get("X-Endpoint-Method")
            if method in {"silero", "energy"}:
                client_timings["endpointMethod"] = method
            response = _voice_agent_reply(
                audio,
                self.headers.get("Content-Type", ""),
                session_id,
                turn_id,
                was_barge_in,
                after_playback,
                check_only,
                client_timings,
                self._request_generation(),
                self.headers.get("X-Playback-Reference-ID"),
                self._playback_offset(),
                self._playback_through(),
            )
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        self._send_json(response)

    def _playback_offset(self) -> float | None:
        try:
            value = float(self.headers.get("X-Playback-Offset-Ms", ""))
            return value if math.isfinite(value) and -1000 <= value <= 180000 else None
        except ValueError:
            return None

    def _playback_through(self) -> float | None:
        try:
            value = float(self.headers.get("X-Playback-Through-Ms", ""))
            return value if math.isfinite(value) and 0 <= value <= 180000 else None
        except ValueError:
            return None

    def _request_generation(self) -> int | None:
        value = self.headers.get("X-Request-Generation")
        if value is None:
            return None
        generation = int(value)
        if not 0 <= generation <= 1000000:
            raise ValueError("Invalid request generation")
        return generation

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    _load_env_files()
    os.environ.setdefault(
        "TELEMETRY_JSONL",
        str(ASSIGNMENT_ROOT / "logs" / "voice-events.jsonl"),
    )
    host, port = listen_address()
    if hosted_bind(host):
        errors = hosted_config_errors()
        if errors:
            raise SystemExit("Hosted talk server refused to start:\n- " + "\n- ".join(errors))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Open http://{host}:{port}")
    print(f"LiveKit URL: {_livekit_url()}")
    print(f"Room: {_livekit_room()}")
    print(f"Agent provider: {_agent_provider_name()}")
    print(f"TTS backend: {os.getenv('TTS_BACKEND', 'provider').lower()}")
    print("Use the two panes for LiveKit audio. Use the conversation panel for the hotel agent.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
