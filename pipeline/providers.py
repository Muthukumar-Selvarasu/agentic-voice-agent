"""
providers.py  -  one adaptor, two backends: Groq and OpenAI.

Groq speaks the OpenAI API dialect, so a single code path covers both  -  only
base_url, api_key, and model names differ. Switch with PROVIDER=groq|openai in
.env; move to your OpenAI key later by flipping that one value.

Exposes three stages the voice loop needs:
    chat(messages, tools)        -> LLM turn (OpenAI-style tool calling)
    transcribe(pcm_int16, rate)  -> STT (Whisper)
    synthesize(text)             -> TTS; returns WAV bytes, or None if it
                                    already played via the system voice command
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import wave
from types import SimpleNamespace as NS

# Sensible defaults per backend. Any of these can be overridden in .env.
PRESETS = {
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        # Current Groq catalog (llama-3.3-70b-versatile retired on free keys).
        "llm_model": "openai/gpt-oss-120b",
        "stt_model": "whisper-large-v3-turbo",
        "tts_model": "canopylabs/orpheus-v1-english",
        "tts_voice": "troy",
    },
    "openai": {
        "base_url": None,                # SDK default endpoint
        "api_key_env": "OPENAI_API_KEY",
        "llm_model": "gpt-4o-mini",
        "stt_model": "whisper-1",
        "tts_model": "tts-1",
        "tts_voice": "alloy",
    },
}

DEFAULT_STT_PROMPT = (
    "Aurora Hotel reservations conversation in English, Spanish, or Tamil. "
    "Hotel vocabulary: Standard Queen, Deluxe King, Harbor Suite, Family Double Queen, "
    "Accessible Queen, reservation, booking, check-in, check-out, cancellation policy, "
    "pet policy, parking, breakfast, buffet, confirmation number, "
    "habitación, reserva, política de cancelación, mascotas, estacionamiento, desayuno, "
    "முன்பதிவு, அறை, நன்றி, காலை உணவு."
)

STT_PROMPTS = {
    "en": (
        "Aurora Hotel reservations conversation in English. "
        "Hotel vocabulary: Standard Queen, Deluxe King, Harbor Suite, Family Double Queen, "
        "Accessible Queen, reservation, booking, check-in, check-out, cancellation policy, "
        "pet policy, parking, breakfast, buffet, confirmation number."
    ),
    "es": (
        "Conversación de reservas del Hotel Aurora en español. "
        "Vocabulario: Standard Queen, Deluxe King, Harbor Suite, habitación, reserva, "
        "check-in, check-out, política de cancelación, mascotas, estacionamiento, desayuno, accesibilidad."
    ),
    "ta": (
        "Aurora Hotel reservations conversation in Tamil. "
        "ஹோட்டல் முன்பதிவு உரையாடல்: முன்பதிவு, அறை, ஸ்டாண்டர்ட் குயின், டீலக்ஸ் கிங், "
        "ஹார்பர் சூட், செக்-இன், செக்-அவுட், காலை உணவு, பஃபேட், ரத்து கொள்கை, உறுதிப்படுத்தல் எண், நன்றி."
    ),
}


def _env_or_default(key: str, default: str) -> str:
    """Return a non-empty environment override or the provider preset.

    A copied .env template can leave a comment after an empty assignment.
    Some dotenv versions preserve that comment as the value, which would send
    an invalid model ID to the provider.
    """
    value = os.getenv(key, "").strip()
    if not value or value.startswith("#"):
        return default
    return value


class Provider:
    """Configured client for one backend. Read from .env on construction."""

    def __init__(self, name: str | None = None):
        name = (name or os.getenv("PROVIDER", "groq")).lower()
        if name not in PRESETS:
            raise ValueError(f"Unknown PROVIDER {name!r}; use one of {list(PRESETS)}")
        self.name = name
        p = PRESETS[name]

        api_key = os.getenv(p["api_key_env"])
        if not api_key:
            raise RuntimeError(f"Set {p['api_key_env']} in your .env (PROVIDER={name})")
        from openai import OpenAI  # lazy: the mock path needs no SDK installed
        self.client = OpenAI(api_key=api_key, base_url=p["base_url"])

        # Per-stage overrides fall back to the preset.
        self.llm_model = _env_or_default("LLM_MODEL", p["llm_model"])
        self.stt_model = _env_or_default("STT_MODEL", p["stt_model"])
        self.stt_prompt = _env_or_default("STT_PROMPT", DEFAULT_STT_PROMPT)
        self.tts_model = _env_or_default("TTS_MODEL", p["tts_model"])
        self.tts_voice = _env_or_default("TTS_VOICE", p["tts_voice"])
        self.tts_instructions = os.getenv("TTS_INSTRUCTIONS")
        # "provider" = cloud TTS; "system" = local system voice command.
        self.tts_backend = os.getenv("TTS_BACKEND", "provider").lower()

    # --- LLM ---
    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice=None,
    ):
        """One chat-completion call. Returns the raw SDK response."""
        try:
            return self.client.chat.completions.create(
                model=self.llm_model,
                messages=messages,
                tools=tools or None,
                tool_choice=(tool_choice or "auto") if tools else None,
                temperature=0.3,
            )
        except Exception as exc:
            # If rate limit exceeded on 120b, fall back to 20b
            if ("rate_limit" in str(exc).lower() or getattr(exc, "status_code", None) == 429) and "120b" in self.llm_model:
                try:
                    return self.client.chat.completions.create(
                        model="openai/gpt-oss-20b",
                        messages=messages,
                        tools=tools or None,
                        tool_choice=(tool_choice or "auto") if tools else None,
                        temperature=0.3,
                    )
                except Exception:
                    pass
            # Groq (and some OpenAI-compatible hosts) return 400 tool_use_failed when
            # a forced tool is required but the model answers in free text. Recover by
            # synthesizing the forced tool call so grounding still runs.
            forced = _tool_choice_name(tool_choice)
            if forced and _is_tool_use_failed(exc):
                args = (
                    {"query": _last_user_text(messages)}
                    if forced == "search_hotel_knowledge"
                    else {}
                )
                return _mk_tool(forced, args)
            raise

    def get_stt_prompt(self, language: str = "en") -> str:
        if os.getenv("STT_PROMPT"):
            return self.stt_prompt
        return STT_PROMPTS.get(language, self.stt_prompt)

    # --- STT ---
    def transcribe(self, pcm_int16: bytes, sample_rate: int = 16000, language: str | None = None) -> str:
        """Transcribe raw 16-bit mono PCM via Whisper."""
        wav = _pcm_to_wav(pcm_int16, sample_rate)
        wav.name = "turn.wav"  # SDK infers format from the filename
        transcription_args = {
            "model": self.stt_model,
            "file": wav,
            "response_format": "text",
        }
        if language in ("en", "es", "ta"):
            transcription_args["language"] = language
        prompt = self.get_stt_prompt(language or "en")
        if prompt:
            transcription_args["prompt"] = prompt
        resp = self.client.audio.transcriptions.create(
            **transcription_args,
        )
        return (resp if isinstance(resp, str) else resp.text).strip()

    # --- TTS ---
    def synthesize(self, text: str) -> bytes | None:
        """Return WAV bytes for `text`, or None if played directly by the OS."""
        if self.tts_backend == "system":
            subprocess.run([os.getenv("SYSTEM_TTS_CMD", "say"), text], check=False)
            return None
        speech_args = {
            "model": self.tts_model,
            "voice": self.tts_voice,
            "input": text,
            "response_format": "wav",
        }
        if self.tts_instructions:
            speech_args["instructions"] = self.tts_instructions
        resp = self.client.audio.speech.create(
            **speech_args,
        )
        return resp.content


# --- audio helpers ---

def _pcm_to_wav(pcm_int16: bytes, sample_rate: int) -> io.BytesIO:
    """Wrap raw 16-bit mono PCM samples into an in-memory WAV file."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm_int16)
    buf.seek(0)
    return buf


# --- Mock backend: full offline end-to-end, no network / key / SDK ---

class MockProvider:
    """Drop-in stand-in for Provider. Rule-based LLM, scripted STT, no-op TTS.

    Same interface (chat / transcribe / synthesize) so voice_loop.py and
    agent.py can't tell the difference. Use for rehearsals, CI, and testing the
    loop without touching Groq/OpenAI. Enable with PROVIDER=mock.
    """

    name = "mock"

    def __init__(self):
        self.llm_model = "mock-llm"
        self.stt_model = "mock-stt"
        self.tts_model = "mock-tts"
        self.tts_voice = "mock"
        self.tts_backend = os.getenv("TTS_BACKEND", "print").lower()
        # Scripted transcripts for mic mode (there's no offline STT); cycles.
        self._stt_script = [
            "I need a room from August 12 to August 14 for two guests.",
            "Book it for Priya Shah, priya@example.com.",
            "Can I speak to a person?",
            "Goodbye",
        ]
        self._stt_i = 0

    def chat(self, messages: list[dict], tools=None, tool_choice=None):
        """Rule-based reply mimicking OpenAI-style tool calling."""
        last = messages[-1]
        language = _session_language(messages)
        spanish = language == "es"
        forced_tool = _tool_choice_name(tool_choice)
        if forced_tool == "search_hotel_knowledge" and last.get("role") == "user":
            return _mk_tool(forced_tool, {"query": last.get("content") or ""})
        # After a tool ran, speak a reply built from its result.
        if last.get("role") == "tool":
            result = last["content"]
            if result.lower().startswith("response language set to spanish"):
                original = _last_user_text(messages).lower()
                if _mock_knowledge_request(original):
                    return _mk_tool("search_hotel_knowledge", {"query": original})
                if _mock_off_topic(original):
                    return _mk_text("Solo puedo ayudar con reservas de hotel. ¿Quiere reservar, cambiar o cancelar una estancia?")
                return _mk_text("Claro. Puedo ayudarle con una reserva en Aurora Hotel.")
            if result.lower().startswith("response language set to tamil"):
                original = _last_user_text(messages).lower()
                if _mock_knowledge_request(original):
                    return _mk_tool("search_hotel_knowledge", {"query": original})
                if _mock_off_topic(original):
                    return _mk_text("ஹோட்டல் முன்பதிவுக்கு மட்டுமே உதவ முடியும். அறை பதிவு செய்ய வேண்டுமா?")
                return _mk_text("சரி. அரோரா ஹோட்டல் முன்பதிவில் உதவ முடியும்.")
            if result.lower().startswith("response language set to english"):
                original = _last_user_text(messages).lower()
                if _mock_knowledge_request(original):
                    return _mk_tool("search_hotel_knowledge", {"query": original})
                if _mock_off_topic(original):
                    return _mk_text("I can only help with hotel reservations. Are you looking to book, change, or cancel a stay?")
                return _mk_text("Of course. I can continue in English with your Aurora Hotel reservation.")
            if result.lower().startswith("available rooms"):
                if spanish:
                    return _mk_text(f"{result} ¿Quiere que reserve una de estas habitaciones?")
                return _mk_text(f"{result} Would you like me to book one of these?")
            if result.lower().startswith("booking confirmed"):
                if spanish:
                    confirmation = re.search(r"AH-\d+", result)
                    code = confirmation.group(0) if confirmation else "confirmada"
                    return _mk_text(f"La reserva está confirmada. Su número de confirmación es {code}.")
                return _mk_text(result)
            if result.lower().startswith("grounded hotel knowledge"):
                tool_args = _previous_tool_arguments(messages)
                return _mk_text(_grounded_policy_reply(result, language, tool_args.get("query", "")))
            if result.lower().startswith("transferring") and spanish:
                return _mk_text("Le transfiero a la recepción.")
            if result.lower().startswith("ending") and spanish:
                return _mk_text("Gracias por llamar a Aurora Hotel. Adiós.")
            return _mk_text(result)  # transfer / hangup / not-found: speak as-is

        text = (last.get("content") or "").lower()
        tokens = set(re.findall(r"[\wáéíóúüñ]+", text, flags=re.UNICODE))
        if any(phrase in text for phrase in (
            "speak spanish", "switch to spanish", "spanish please", "habla español",
            "hable español", "en español",
        )):
            return _mk_tool("set_language", {"language": "es"})
        if any(phrase in text for phrase in (
            "speak english", "switch to english", "switch back to english",
            "back to english", "return to english", "english please", "english again",
            "habla inglés", "hable inglés", "en inglés", "habla ingles",
        )):
            return _mk_tool("set_language", {"language": "en"})
        if any(phrase in text for phrase in (
            "speak tamil", "switch to tamil", "tamil please", "in tamil", "தமிழ",
        )):
            return _mk_tool("set_language", {"language": "ta"})
        if _mock_knowledge_request(text):
            return _mk_tool("search_hotel_knowledge", {"query": last.get("content") or ""})
        if any(w in text for w in ("bye", "goodbye", "that's all", "thats all",
                                   "nothing else", "no thanks", "hang up", "adiós", "adios")):
            return _mk_tool("end_call", {})
        if _mock_off_topic(text):
            if spanish:
                return _mk_text("Solo puedo ayudar con reservas de hotel. ¿Quiere reservar, cambiar o cancelar una estancia?")
            return _mk_text("I can only help with hotel reservations. Are you looking to book, change, or cancel a stay?")
        if any(phrase in text for phrase in (
            "another reservation", "another guest", "other guest", "someone else's",
        )):
            if spanish:
                return _mk_text("No puedo revelar datos de otro huésped. Solo puedo ayudar con su propia reserva de hotel.")
            return _mk_text("I cannot disclose another guest's information. I can only help with your own hotel reservation.")
        if tokens & {"human", "person", "representative", "agent", "operator", "persona", "recepción"}:
            return _mk_tool("transfer_to_human", {})
        if any(w in text for w in ("change", "cancel", "modify", "front desk")):
            return _mk_tool("transfer_to_human", {})
        if any(w in text for w in ("book", "reserve", "yes", "confirm", "reservar", "confirmo")) and any(
            w in text for w in ("name", "email", "@", "phone", "priya", "shah", "nombre")
        ):
            return _mk_tool("create_booking", {
                "check_in": "August 12",
                "check_out": "August 14",
                "guests": 2,
                "room_type": "standard",
                "guest_name": "Priya Shah",
                "contact": "priya@example.com",
            })
        if any(w in text for w in (
            "room", "hotel", "stay", "book", "reservation", "guests", "guest",
            "habitación", "habitacion", "reserva", "personas", "huéspedes", "huespedes",
        )):
            return _mk_tool("check_availability", {
                "check_in": "August 12",
                "check_out": "August 14",
                "guests": 2,
                "room_type": "standard",
            })
        if spanish:
            return _mk_text("Solo puedo ayudar con reservas de hotel. ¿Quiere reservar, cambiar o cancelar una estancia?")
        if language == "ta":
            return _mk_text("ஹோட்டல் முன்பதிவுக்கு மட்டுமே உதவ முடியும். அறை பதிவு செய்ய வேண்டுமா?")
        return _mk_text("I can help with hotel reservations only. Would you like to book, change, or cancel a stay?")

    def transcribe(self, pcm_int16: bytes, sample_rate: int = 16000) -> str:
        """No offline STT  -  return the next scripted phrase (rehearsal mode)."""
        phrase = self._stt_script[self._stt_i % len(self._stt_script)]
        self._stt_i += 1
        return phrase

    def synthesize(self, text: str) -> bytes | None:
        """No cloud TTS. Optionally use a local voice command; else print-only."""
        if self.tts_backend == "system":
            subprocess.run([os.getenv("SYSTEM_TTS_CMD", "say"), text], check=False)
        return None  # voice_loop already prints the agent's text


def _mk_text(content: str):
    return NS(choices=[NS(message=NS(content=content, tool_calls=None))])


def _mk_tool(name: str, args: dict):
    tc = NS(id=f"call_{name}", type="function",
            function=NS(name=name, arguments=json.dumps(args)))
    return NS(choices=[NS(message=NS(content=None, tool_calls=[tc]))])


def _tool_choice_name(tool_choice) -> str | None:
    if not isinstance(tool_choice, dict):
        return None
    function = tool_choice.get("function") or {}
    return function.get("name")


def _is_tool_use_failed(exc: BaseException) -> bool:
    text = str(exc).lower()
    if "tool_use_failed" in text or "tool choice is required" in text:
        return True
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error") or {}
        code = str(err.get("code") or "").lower()
        message = str(err.get("message") or "").lower()
        if code == "tool_use_failed" or "tool choice is required" in message:
            return True
    return False


def _last_user_text(messages: list[dict]) -> str:
    return next(
        (message.get("content") or "" for message in reversed(messages) if message.get("role") == "user"),
        "",
    )


def _mock_knowledge_request(text: str) -> bool:
    return any(word in text for word in (
        "cancellation policy", "cancel policy", "check-in", "check in", "check-out",
        "check out", "parking", "pets", "pet policy", "breakfast", "accessible",
        "accessibility", "policy", "estacionamiento", "mascotas", "desayuno",
        "ரத்து", "செல்லப்பிராணி", "பார்க்கிங்", "காலை உணவு", "செக் இன்",
    ))


def _mock_off_topic(text: str) -> bool:
    return any(word in text for word in (
        "weather", "news", "sports", "stock", "joke", "trivia", "clima", "noticias",
    ))


def _previous_tool_arguments(messages: list[dict]) -> dict:
    if len(messages) < 2:
        return {}
    calls = messages[-2].get("tool_calls") or []
    if not calls:
        return {}
    try:
        return json.loads(calls[0]["function"].get("arguments") or "{}")
    except (json.JSONDecodeError, KeyError, TypeError):
        return {}


def _session_language(messages: list[dict]) -> str:
    content = messages[0].get("content", "") if messages else ""
    if "Current response language: Spanish" in content:
        return "es"
    if "Current response language: Tamil" in content:
        return "ta"
    return "en"


def _grounded_policy_reply(result: str, language: str, query: str) -> str:
    topic = query.lower()
    if "cancel" in topic or "ரத்து" in topic:
        if language == "es":
            return "Puede cancelar sin cargo hasta las 6:00 PM, hora local del hotel, dos días antes de la llegada. Las tarifas promocionales prepagadas no son reembolsables."
        if language == "ta":
            return "வருகைக்கு இரண்டு நாட்களுக்கு முன்பு, உள்ளூர் நேரம் மாலை 6 மணி வரை கட்டணமின்றி ரத்து செய்யலாம். முன்பண விளம்பர கட்டணங்கள் திரும்ப வராது."
        return "You may cancel without charge until 6:00 PM local hotel time two days before arrival. Prepaid promotional rates are non-refundable."
    if "parking" in topic or "estacionamiento" in topic or "பார்க்கிங்" in topic:
        if language == "es":
            return "El estacionamiento cuesta $28 por noche y el servicio de valet cuesta $42 por noche."
        if language == "ta":
            return "சுய பார்க்கிங் இரவுக்கு $28. வேலட் பார்க்கிங் இரவுக்கு $42."
        return "Self-parking is $28 per night, and valet parking is $42 per night."
    if "pet" in topic or "dog" in topic or "mascota" in topic or "செல்லப்பிராணி" in topic:
        if language == "es":
            return "Se permiten hasta dos perros por habitación, con un límite de 50 libras por perro y una tarifa de limpieza de $75 por estancia."
        if language == "ta":
            return "ஒரு அறைக்கு இரண்டு நாய்கள் வரை அனுமதி. ஒரு நாய்க்கு 50 பவுண்டு வரம்பு. தங்கும் முழு நேரத்திற்கும் $75 சுத்தம் கட்டணம்."
        return "Up to two dogs are allowed per room, with a 50-pound limit per dog and a $75 cleaning fee per stay."
    if "breakfast" in topic or "desayuno" in topic or "காலை உணவு" in topic:
        if language == "es":
            return "El desayuno se sirve de 6:30 AM a 10:30 AM y solo está incluido cuando la tarifa lo indica."
        if language == "ta":
            return "காலை உணவு காலை 6:30 முதல் 10:30 வரை. தேர்ந்தெடுத்த கட்டணத்தில் சேர்க்கப்பட்டால் மட்டுமே இலவசம்."
        return "Breakfast is served from 6:30 AM to 10:30 AM and is included only when the selected rate says so."
    if language == "es":
        return "Encontré la política de Aurora Hotel y puedo ayudarle con los detalles de su reserva."
    if language == "ta":
        return "அரோரா ஹோட்டல் கொள்கையை கண்டேன். முன்பதிவு விவரங்களுக்கு உதவ முடியும்."
    return "I found the relevant Aurora Hotel policy and can help apply it to your reservation."


def make_provider(name: str | None = None):
    """Factory: returns MockProvider for PROVIDER=mock, else a live Provider."""
    name = (name or os.getenv("PROVIDER", "groq")).lower()
    if name == "mock":
        return MockProvider()
    return Provider(name)
