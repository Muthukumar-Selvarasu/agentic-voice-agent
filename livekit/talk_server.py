"""Serve a tiny browser client for testing local LiveKit audio.

Run this after `./start_local_server.sh`, then open http://localhost:5173.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import warnings
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


def _remember_spoken(session_id: str, text: str) -> None:
    with _session_registry_lock:
        _last_spoken[session_id] = text


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


def _browser_tts_payload(agent, trace, text: str) -> dict:
    """Return provider audio for the browser or select its local voice fallback."""
    provider = agent.provider
    backend = getattr(provider, "tts_backend", "provider")
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
    return _finish_response(
        agent,
        trace,
        GREETING,
        None,
        response_sources=[],
        **tts,
    )


def _agent_reply(text: str, session_id: str, turn_id: str | None) -> dict:
    agent, lock = _get_session(session_id)
    trace = _trace(session_id, turn_id)
    trace.event("input.text")
    with lock:
        reply, action = agent.respond(text, trace=trace)
        tts = _browser_tts_payload(agent, trace, reply)
    _remember_spoken(session_id, reply)
    return _finish_response(agent, trace, reply, action, **tts)


def _voice_agent_reply(
    audio: bytes,
    content_type: str,
    session_id: str,
    turn_id: str | None,
    was_barge_in: bool,
    after_playback: bool = False,
) -> dict:
    agent, lock = _get_session(session_id)
    trace = _trace(session_id, turn_id)
    trace.event("audio.received", bytes=len(audio), contentType=content_type)
    with lock:
        if getattr(agent.provider, "name", "") == "mock":
            with trace.span("stt", model=getattr(agent.provider, "stt_model", "unknown")):
                transcript = agent.provider.transcribe(b"")
        else:
            audio_file = BytesIO(audio)
            if "mp4" in content_type:
                audio_file.name = "caller.mp4"
            elif "ogg" in content_type:
                audio_file.name = "caller.ogg"
            else:
                audio_file.name = "caller.webm"
            with trace.span("stt", model=getattr(agent.provider, "stt_model", "unknown")):
                transcription_args = {
                    "model": agent.provider.stt_model,
                    "file": audio_file,
                    "response_format": "text",
                }
                stt_prompt = getattr(agent.provider, "stt_prompt", "")
                if stt_prompt:
                    transcription_args["prompt"] = stt_prompt
                stt = agent.provider.client.audio.transcriptions.create(**transcription_args)
            transcript = (stt if isinstance(stt, str) else stt.text).strip()
        # Speaker bleed often arrives as a normal turn right after TTS ends, not
        # only as an X-Barge-In interrupt. Suppress only clear playback copies —
        # never drop a deliberate barge-in / courtesy like "நன்றி".
        if (was_barge_in or after_playback) and _is_probable_playback_echo(
            transcript,
            _last_spoken_text(session_id),
            barge_in=was_barge_in,
        ):
            trace.event(
                "barge_in.echo_suppressed",
                transcript=transcript,
                afterPlayback=after_playback,
                wasBargeIn=was_barge_in,
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
            )
        if was_barge_in:
            trace.event("barge_in.turn_started")
        reply, action = agent.respond(transcript, trace=trace)
        tts = _browser_tts_payload(agent, trace, reply)
    _remember_spoken(session_id, reply)
    return _finish_response(
        agent,
        trace,
        reply,
        action,
        transcript=transcript,
        sttModel=getattr(agent.provider, "stt_model", "unknown"),
        **tts,
    )


def _normalize_utterance(text: str) -> str:
    stripped = text.lower()
    for mark in ("'", ".", ",", "!", "?", "¡", "¿", "।", "…", ";", ":"):
        stripped = stripped.replace(mark, "")
    return " ".join(stripped.split())


# Whisper / browser-TTS hallucinations only — not real caller courtesies.
_ECHO_HALLUCINATIONS = {
    "thank you for watching",
    "thanks for watching",
    "subtitles by",
    "amara org",
    "amara",
    "see you next time",
}


def _is_probable_playback_echo(
    transcript: str,
    spoken: str = "",
    *,
    barge_in: bool = False,
) -> bool:
    """Ignore audio that is only Aurora's own speaker playback coming back.

    A real interruption such as "Wait, speak Tamil" or a courtesy "நன்றி" is kept.
    Near-duplicate STT of the line Aurora just spoke is treated as echo.
    """
    normalized = _normalize_utterance(transcript)
    if not normalized:
        return True
    if len(normalized) <= 1:
        return True

    # Never treat deliberate barge-ins as hallucination noise.
    if not barge_in:
        if normalized in _ECHO_HALLUCINATIONS:
            return True
        if any(h in normalized for h in ("watching", "subtitles by", "amara.org", "amara org")):
            return True

    spoken_norm = _normalize_utterance(spoken)
    if not spoken_norm:
        return False

    # Exact / near copy of the full reply (true speaker echo).
    if SequenceMatcher(None, normalized, spoken_norm).ratio() >= (0.88 if barge_in else 0.78):
        return True

    # Contiguous fragment of the reply (avoid single shared topic words).
    if len(normalized) >= 8 and normalized in spoken_norm:
        return True

    t_words = [w for w in normalized.split() if len(w) > 1]
    s_words = set(spoken_norm.split())
    if t_words and s_words and len(t_words) <= 10:
        matching = sum(1 for w in t_words if w in s_words)
        # Barge-in needs almost all tokens from the reply; topic words alone must not drop.
        overlap = matching / len(t_words)
        if barge_in:
            if len(t_words) >= 4 and overlap >= 0.9:
                return True
        elif len(t_words) <= 6 and overlap >= 0.85:
            return True

    for piece in spoken_norm.replace("?", ".").split("."):
        piece = piece.strip()
        if len(piece) < 16:
            continue
        ratio = SequenceMatcher(None, normalized, piece).ratio()
        if barge_in:
            if ratio >= 0.9 or (len(normalized) >= 16 and normalized in piece):
                return True
        elif normalized in piece or piece in normalized or ratio >= 0.85:
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
            )
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
            response = _agent_reply(text, session_id, turn_id)
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
    ) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            audio = self.rfile.read(length)
            if not audio:
                raise ValueError("Missing audio")
            response = _voice_agent_reply(
                audio,
                self.headers.get("Content-Type", ""),
                session_id,
                turn_id,
                was_barge_in,
                after_playback,
            )
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        self._send_json(response)

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
