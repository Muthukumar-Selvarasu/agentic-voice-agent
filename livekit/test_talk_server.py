"""Offline tests for browser TTS payload selection and hosted bind rules."""

from __future__ import annotations

import base64
import os
import unittest
import threading
import wave
from pathlib import Path
from io import BytesIO
from types import SimpleNamespace
from contextlib import contextmanager
from unittest.mock import ANY, Mock, patch

from talk_server import (
    _browser_tts_payload,
    _system_tts_audio,
    _is_correlated_residual_echo,
    _is_probable_playback_echo,
    _is_correlated_numeric_echo,
    _is_confident_no_speech,
    _is_weak_truncated_playback_echo,
    _speech_evidence,
    _speech_activity_reply,
    _voice_agent_reply,
    hosted_config_errors,
    listen_address,
    static_no_store,
)


class FakeTrace:
    def __init__(self):
        self.events = []

    @contextmanager
    def span(self, name, **attributes):
        yield

    def event(self, name, **attributes):
        self.events.append((name, attributes))


class FakeProvider:
    name = "openai"
    tts_model = "tts-test"
    tts_voice = "voice-test"

    def __init__(self, backend="provider", error=None):
        self.tts_backend = backend
        self.error = error
        self.calls = []

    def synthesize(self, text):
        self.calls.append(text)
        if self.error:
            raise self.error
        return b"RIFFtest-wave"


class FakeAgent:
    def __init__(self, provider):
        self.provider = provider


class BrowserTtsPayloadTests(unittest.TestCase):
    def test_provider_backend_returns_audio(self):
        provider = FakeProvider()
        payload = _browser_tts_payload(FakeAgent(provider), FakeTrace(), "Hello")

        self.assertEqual(payload["ttsBackend"], "provider")
        self.assertEqual(base64.b64decode(payload["audioBase64"]), b"RIFFtest-wave")
        self.assertEqual(payload["ttsVoice"], "voice-test")
        self.assertEqual(provider.calls, ["Hello"])

    def test_system_backend_selects_browser_voice_without_provider_call(self):
        provider = FakeProvider(backend="system")
        with patch("talk_server._system_tts_audio", return_value=None):
            payload = _browser_tts_payload(FakeAgent(provider), FakeTrace(), "Hello")

        self.assertEqual(payload, {"ttsBackend": "browser", "ttsFallback": True})
        self.assertEqual(provider.calls, [])

    def test_system_backend_returns_local_audio_without_switching_provider(self):
        provider = FakeProvider(backend="system")
        agent = FakeAgent(provider)
        agent.current_locale = "ta-IN"
        with patch("talk_server._system_tts_audio", return_value=(b"RIFFlocal-wave", "Vani")) as render:
            payload = _browser_tts_payload(agent, FakeTrace(), "வணக்கம்")
        render.assert_called_once_with("வணக்கம்", "ta-IN")
        self.assertEqual(payload["ttsBackend"], "system")
        self.assertEqual(payload["ttsVoice"], "Vani")
        self.assertEqual(base64.b64decode(payload["audioBase64"]), b"RIFFlocal-wave")
        self.assertEqual(provider.calls, [])

    def test_system_render_failure_keeps_browser_fallback_without_exposing_error(self):
        trace = FakeTrace()
        with patch("talk_server._system_tts_audio", side_effect=RuntimeError("private error")):
            payload = _browser_tts_payload(FakeAgent(FakeProvider(backend="system")), trace, "Hello")
        self.assertEqual(payload, {"ttsBackend": "browser", "ttsFallback": True})
        self.assertEqual(trace.events[0][0], "tts.fallback")
        self.assertNotIn("private error", str(payload))

    def test_provider_failure_falls_back_without_exposing_error(self):
        provider = FakeProvider(error=RuntimeError("secret provider response"))
        trace = FakeTrace()
        payload = _browser_tts_payload(FakeAgent(provider), trace, "Hello")

        self.assertEqual(payload, {"ttsBackend": "browser", "ttsFallback": True})
        self.assertEqual(trace.events[0][0], "tts.fallback")
        self.assertNotIn("secret provider response", str(payload))


class SystemSpeechRenderingTests(unittest.TestCase):
    def test_renders_localized_wave_to_file_with_text_on_stdin_and_removes_temp_file(self):
        for locale, expected_voice in (("en-US", "Samantha"), ("es-ES", "Mónica"), ("ta-IN", "Vani")):
            with self.subTest(locale=locale):
                outputs = []

                def render(command, **kwargs):
                    output = Path(command[command.index("-o") + 1])
                    outputs.append(output)
                    self.assertEqual(command[command.index("-v") + 1], expected_voice)
                    self.assertIn("--file-format=WAVE", command)
                    self.assertIn("--data-format=LEI16@24000", command)
                    self.assertEqual(kwargs["input"], "Caller-controlled text $(not a shell command)")
                    self.assertTrue(kwargs["check"])
                    self.assertEqual(kwargs["timeout"], 20)
                    with wave.open(str(output), "wb") as recording:
                        recording.setnchannels(1)
                        recording.setsampwidth(2)
                        recording.setframerate(24000)
                        recording.writeframes(b"\x01\x00" * 480)

                with patch("talk_server.sys.platform", "darwin"), \
                     patch("talk_server.shutil.which", return_value="/usr/bin/say"), \
                     patch("talk_server.subprocess.run", side_effect=render) as run:
                    audio, voice = _system_tts_audio("Caller-controlled text $(not a shell command)", locale)
                self.assertEqual(voice, expected_voice)
                self.assertEqual(audio[:4], b"RIFF")
                run.assert_called_once()
                self.assertFalse(outputs[0].parent.exists())

    def test_empty_wave_is_rejected_and_cleaned_up(self):
        outputs = []

        def render(command, **kwargs):
            output = Path(command[command.index("-o") + 1])
            outputs.append(output)
            with wave.open(str(output), "wb") as recording:
                recording.setnchannels(1)
                recording.setsampwidth(2)
                recording.setframerate(24000)

        with patch("talk_server.sys.platform", "darwin"), \
             patch("talk_server.shutil.which", return_value="/usr/bin/say"), \
             patch("talk_server.subprocess.run", side_effect=render):
            with self.assertRaisesRegex(ValueError, "Empty system speech"):
                _system_tts_audio("Hello", "en-US")
        self.assertFalse(outputs[0].parent.exists())

    def test_unsupported_host_or_missing_renderer_never_invokes_speech(self):
        with patch("talk_server.subprocess.run") as run:
            with patch("talk_server.sys.platform", "linux"):
                self.assertIsNone(_system_tts_audio("Hello", "en-US"))
            with patch("talk_server.sys.platform", "darwin"), \
                 patch("talk_server.shutil.which", return_value=None):
                self.assertIsNone(_system_tts_audio("Hello", "en-US"))
            run.assert_not_called()


class NoSpeechTests(unittest.TestCase):
    def test_live_activity_endpoint_is_local_only_and_reports_last_speech(self):
        audio = (Path(__file__).parent / "test_audio" / "synthetic_no_16k.wav").read_bytes()
        with patch("talk_server._get_session") as session, patch.dict(os.environ, {"TELEMETRY_JSONL": ""}):
            result = _speech_activity_reply(audio, "test", "activity-1")
        session.assert_not_called()
        self.assertGreater(result["speechEvidence"]["lastSpeechMs"], 0)
        self.assertEqual(set(result["trace"]["timings"]), {"vad"})

    def test_local_noise_evidence_overrides_even_confident_hallucinated_text(self):
        stt = SimpleNamespace(segments=[{"no_speech_prob": 0.0, "avg_logprob": -0.2}])
        evidence = {"maxSpeechProbability": 0.155, "speechThreshold": 0.3}
        self.assertTrue(_is_confident_no_speech(stt, evidence))
        self.assertFalse(_is_confident_no_speech(stt))

    def test_local_speech_keeps_faint_no_or_tamil_even_with_bad_stt_metadata(self):
        evidence = {"maxSpeechProbability": 0.92, "speechThreshold": 0.3}
        for text in ("No.", "நன்றி", "Standard Queen"):
            with self.subTest(text=text):
                stt = SimpleNamespace(text=text, segments=[{"no_speech_prob": 0.99, "avg_logprob": -2.0}])
                self.assertFalse(_is_confident_no_speech(stt, evidence))

    def test_even_one_positive_frame_keeps_brief_input(self):
        stt = SimpleNamespace(segments=[{"no_speech_prob": 0.0, "avg_logprob": -1.5}])
        for duration in (32, 300, 4800):
            with self.subTest(duration=duration):
                self.assertFalse(_is_confident_no_speech(stt, {
                    "durationMs": duration, "voicedMs": 32,
                    "maxSpeechProbability": 0.3, "speechThreshold": 0.3}))

    def test_real_detector_classifies_pcm_silence_without_external_decoder(self):
        buffer = BytesIO()
        with wave.open(buffer, "wb") as recording:
            recording.setnchannels(1)
            recording.setsampwidth(2)
            recording.setframerate(16000)
            recording.writeframes(b"\x00\x00" * 16000)
        with patch("speech_detector.subprocess.run") as decoder:
            evidence = _speech_evidence(buffer.getvalue())
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence["detector"], "silero")
        self.assertEqual(evidence["durationMs"], 1000)
        self.assertEqual(evidence["voicedMs"], 0)
        self.assertLess(evidence["maxSpeechProbability"], evidence["speechThreshold"])
        decoder.assert_not_called()

    def test_unavailable_decoder_preserves_transcription_path(self):
        with patch("speech_detector.shutil.which", return_value=None):
            self.assertIsNone(_speech_evidence(b"encoded audio" * 10))

    def test_noise_never_reaches_external_stt_or_agent(self):
        create = Mock(return_value=SimpleNamespace(text="So, let's go.", segments=[
            {"no_speech_prob": 0.0, "avg_logprob": -1.029}]))
        provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
        agent = SimpleNamespace(provider=provider, respond=Mock())
        evidence = {"maxSpeechProbability": 0.155, "speechThreshold": 0.3}
        with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
             patch("talk_server._trace", return_value=FakeTrace()), \
             patch("talk_server._speech_evidence", return_value=evidence), \
             patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
            result = _voice_agent_reply(b"captured noise", "audio/webm", "test", "turn", False)
        self.assertTrue(result["ignored"])
        self.assertEqual(result["ignoreReason"], "no_speech")
        create.assert_not_called()
        agent.respond.assert_not_called()

    def test_real_faint_no_passes_detector_and_preserves_original_stt_audio(self):
        audio = (Path(__file__).parent / "test_audio" / "synthetic_no_16k.wav").read_bytes()
        create = Mock(return_value=SimpleNamespace(text="No.", segments=[
            {"no_speech_prob": 0.99, "avg_logprob": -2.0}]))
        provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
        agent = SimpleNamespace(provider=provider, respond=Mock(return_value=("Reply", None)))
        with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
             patch("talk_server._trace", return_value=FakeTrace()), \
             patch("talk_server._last_spoken_text", return_value="Welcome to Aurora Hotel"), \
             patch("talk_server._remember_spoken"), \
             patch("talk_server._browser_tts_payload", return_value={}), \
             patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
            result = _voice_agent_reply(audio, "audio/wav", "test", "turn", True)
        self.assertEqual(create.call_args.kwargs["file"].getvalue(), audio)
        agent.respond.assert_called_once_with("No.", trace=ANY)
        self.assertNotIn("ignored", result)

    def test_silence_requires_both_high_probability_and_weak_text(self):
        self.assertTrue(_is_confident_no_speech(SimpleNamespace(segments=[
            {"no_speech_prob": 0.95, "avg_logprob": -1.8},
        ])))
        self.assertFalse(_is_confident_no_speech(SimpleNamespace(segments=[
            {"no_speech_prob": 0.95, "avg_logprob": -0.2},
        ])))
        self.assertFalse(_is_confident_no_speech(SimpleNamespace(segments=[
            {"no_speech_prob": 0.1, "avg_logprob": -1.8},
        ])))

    def test_missing_metadata_and_mixed_speech_are_kept(self):
        self.assertFalse(_is_confident_no_speech("yes"))
        self.assertFalse(_is_confident_no_speech(SimpleNamespace(segments=[])))
        self.assertFalse(_is_confident_no_speech(SimpleNamespace(segments=[{}])))
        self.assertFalse(_is_confident_no_speech(SimpleNamespace(segments=[
            SimpleNamespace(no_speech_prob=0.99, avg_logprob=-2.0),
            SimpleNamespace(no_speech_prob=0.01, avg_logprob=-0.2),
        ])))

    def test_confident_silence_never_reaches_agent(self):
        create = Mock(return_value=SimpleNamespace(text="Thank you.", segments=[
            {"no_speech_prob": 0.98, "avg_logprob": -1.8},
        ]))
        provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
        agent = SimpleNamespace(provider=provider, respond=Mock())
        trace = FakeTrace()
        with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
             patch("talk_server._trace", return_value=trace), \
             patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
            result = _voice_agent_reply(b"test audio", "audio/webm", "test", "turn", False)
        self.assertEqual(create.call_args.kwargs["response_format"], "verbose_json")
        agent.respond.assert_not_called()
        self.assertTrue(result["ignored"])
        self.assertEqual(result["ignoreReason"], "no_speech")

    def test_short_real_replies_and_non_whisper_transcription_are_kept(self):
        for model, text, expected_format in (
            ("whisper-large-v3-turbo", "yes", "verbose_json"),
            ("whisper-large-v3-turbo", "நன்றி", "verbose_json"),
            ("gpt-4o-mini-transcribe", "wait", "text"),
        ):
            with self.subTest(model=model, text=text):
                stt = SimpleNamespace(text=text, segments=[
                    {"no_speech_prob": 0.8, "avg_logprob": -0.3},
                ]) if model.startswith("whisper-") else text
                create = Mock(return_value=stt)
                provider = SimpleNamespace(name="groq", stt_model=model, tts_backend="system",
                    client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
                agent = SimpleNamespace(provider=provider, respond=Mock(return_value=("Reply", None)))
                trace = FakeTrace()
                with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
                     patch("talk_server._trace", return_value=trace), \
                     patch("talk_server._last_spoken_text", return_value="Welcome to Aurora Hotel"), \
                     patch("talk_server._remember_spoken"), \
                     patch("talk_server._system_tts_audio", return_value=None), \
                     patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
                    result = _voice_agent_reply(b"test audio", "audio/webm", "test", "turn", True)
                self.assertEqual(create.call_args.kwargs["response_format"], expected_format)
                agent.respond.assert_called_once_with(text, trace=trace)
                self.assertNotIn("ignored", result)


class PlaybackCheckTests(unittest.TestCase):
    def test_checks_filter_echo_without_running_agent_or_changing_last_reply(self):
        spoken = "Thanks for calling Aurora Hotel reservations. Please say yes or no. We have a Standard Queen room."
        for transcript, confirmed in (
            ("calling Aurora Hotel reservations", False),
            ("We have a Standard Queen room", False),
            ("no", True),
            ("wait", True),
            ("Standard Queen", True),
            ("Thanks for calling Aurora Hotel reservations. Wait, speak Tamil", True),
        ):
            with self.subTest(transcript=transcript):
                create = Mock(return_value=SimpleNamespace(text=transcript, segments=[]))
                provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
                    client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
                agent = SimpleNamespace(provider=provider, respond=Mock())
                trace = FakeTrace()
                with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
                     patch("talk_server._trace", return_value=trace), \
                     patch("talk_server._last_spoken_text", return_value=spoken), \
                     patch("talk_server._remember_spoken") as remember, \
                     patch("talk_server._browser_tts_payload") as synthesize, \
                     patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
                    result = _voice_agent_reply(b"preview", "audio/webm", "test", "check", True, check_only=True)
                self.assertEqual(bool(result.get("inputConfirmed")), confirmed)
                self.assertEqual(bool(result.get("ignored")), not confirmed)
                agent.respond.assert_not_called()
                remember.assert_not_called()
                synthesize.assert_not_called()


class GenerationAdmissionTests(unittest.TestCase):
    def test_ignored_echo_does_not_supersede_a_pending_typed_reply(self):
        create = Mock(return_value=SimpleNamespace(text="So I'm just going to be calling.", segments=[]))
        provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
        agent = SimpleNamespace(provider=provider, respond=Mock())
        with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
             patch("talk_server._trace", return_value=FakeTrace()), \
             patch("talk_server._speech_evidence", return_value={
                 "maxSpeechProbability": .99, "speechThreshold": .3,
             }), \
             patch("talk_server._last_spoken_text", return_value="Thanks for calling Aurora Hotel reservations."), \
             patch("talk_server._is_probable_playback_echo", return_value=True), \
             patch("talk_server._admit_generation") as admit, \
             patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
            result = _voice_agent_reply(b"echo clip", "audio/wav", "test", "echo", True,
                                        generation=8)
        self.assertTrue(result["ignored"])
        self.assertEqual(result["ignoreReason"], "probable_playback_echo")
        admit.assert_not_called()
        agent.respond.assert_not_called()

    def test_confirmed_caller_input_admits_its_generation(self):
        create = Mock(return_value=SimpleNamespace(text="No.", segments=[]))
        provider = SimpleNamespace(name="groq", stt_model="whisper-large-v3-turbo",
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create))))
        agent = SimpleNamespace(provider=provider, respond=Mock(return_value=("Okay.", None)))
        with patch("talk_server._get_session", return_value=(agent, threading.Lock())), \
             patch("talk_server._trace", return_value=FakeTrace()), \
             patch("talk_server._speech_evidence", return_value=None), \
             patch("talk_server._last_spoken_text", return_value="Thanks for calling."), \
             patch("talk_server._is_probable_playback_echo", return_value=False), \
             patch("talk_server._admit_generation") as admit, \
             patch("talk_server._remember_spoken"), \
             patch("talk_server._browser_tts_payload", return_value={}), \
             patch("talk_server._remember_audio"), \
             patch("talk_server._finish_response", side_effect=lambda *args, **extra: extra):
            _voice_agent_reply(b"caller speech", "audio/wav", "test", "caller", True,
                               generation=9)
        admit.assert_called_once_with("test", 9)


class TruncatedPlaybackEchoTests(unittest.TestCase):
    def setUp(self):
        self.evidence = {
            "correlation": .8541, "residualEnergyFraction": .450843,
            "residualGain": 1.709, "matchedMs": 289.0,
            "truncatedPlayback": True,
        }
        self.speech = {"voicedFraction": .2514}

    def test_weak_short_residual_stt_does_not_become_a_caller_turn(self):
        stt = SimpleNamespace(segments=[{"no_speech_prob": 0.0, "avg_logprob": -1.415}])
        self.assertTrue(_is_weak_truncated_playback_echo(self.evidence, self.speech, stt))

    def test_confident_caller_speech_and_untruncated_audio_are_preserved(self):
        confident = SimpleNamespace(segments=[{"no_speech_prob": 0.0, "avg_logprob": -0.3}])
        self.assertFalse(_is_weak_truncated_playback_echo(self.evidence, self.speech, confident))
        weak = SimpleNamespace(segments=[{"no_speech_prob": 0.0, "avg_logprob": -1.5}])
        self.assertFalse(_is_weak_truncated_playback_echo(
            self.evidence, {"voicedFraction": .42}, weak,
        ))
        self.assertFalse(_is_weak_truncated_playback_echo(
            {**self.evidence, "truncatedPlayback": False}, self.speech, weak,
        ))


class PlaybackEchoTests(unittest.TestCase):
    def test_numeric_price_echo_with_short_lead_in_is_rejected(self):
        spoken = "We have a Standard Queen for $189 per night, and a Deluxe King for $229."
        evidence = {"correlation": .8832, "residualEnergyFraction": .22,
                    "residualGain": 1.086}
        self.assertTrue(_is_correlated_numeric_echo("For 189.", spoken, evidence))
        self.assertTrue(_is_correlated_numeric_echo("For $200.", spoken, evidence))
        self.assertTrue(_is_correlated_numeric_echo("$9.", spoken, evidence))
        self.assertFalse(_is_correlated_numeric_echo("No, $200.", spoken, evidence))
        self.assertFalse(_is_correlated_numeric_echo("Deluxe King for $200", spoken, evidence))

    def test_quiet_correlated_residual_echo_fragments_are_rejected(self):
        spoken = "We have a Deluxe King for $229 per night."
        evidence = {"correlation": .9938, "residualEnergyFraction": .01233,
                    "residualGain": 4.0}
        residual_speech = {"voicedFraction": .75}
        self.assertTrue(_is_correlated_residual_echo("A delight.", spoken,
                                                     evidence, residual_speech))
        self.assertTrue(_is_correlated_residual_echo("For $200.", spoken,
                                                     evidence, residual_speech))
        self.assertTrue(_is_correlated_residual_echo("$9.", spoken,
                                                     evidence, {"voicedFraction": .87}))
        self.assertTrue(_is_correlated_residual_echo(
            "Aurora Hotel", spoken,
            {"correlation": .9972, "residualEnergyFraction": .005493, "residualGain": 4.0},
            {"voicedFraction": .96},
        ))
        self.assertTrue(_is_correlated_residual_echo(
            "I'm sorry, I can only help with the right.",
            "I'm sorry, I can only help with Aurora Hotel reservations. Would you like to book?",
            evidence, {"voicedFraction": .77},
        ))

    def test_distinct_short_caller_answers_and_explicit_corrections_survive(self):
        spoken = "We have a Deluxe King for $229 per night."
        evidence = {"correlation": .9958, "residualEnergyFraction": .008302,
                    "residualGain": 4.0}
        self.assertFalse(_is_correlated_residual_echo(
            "No.", spoken, evidence, {"voicedFraction": .498}))
        self.assertFalse(_is_correlated_residual_echo(
            "No, for $200.", spoken, evidence, {"voicedFraction": .675}))
        self.assertFalse(_is_correlated_residual_echo(
            "Deluxe King", spoken, evidence, {"voicedFraction": .87}))
        self.assertFalse(_is_correlated_residual_echo(
            "For $200.", spoken, {**evidence, "residualEnergyFraction": .07},
            {"voicedFraction": .675}))

    def test_live_partial_echo_variations_are_suppressed(self):
        for transcript, spoken in (
            ("Hotel reservations.", "Thanks for calling Aurora Hotel reservations. How can I help?"),
            ("I have your check-in date.", "May I have your check‑in date, check‑out date, and the number of guests, please?"),
            ("Check-out date and how many get", "Could you tell me your check‑out date and how many guests will be staying?"),
            ("Could you let me know your name?", "Could you let me know your check‑out date and the total number of guests, please?"),
            ("Time is 11 a.m.", "Our standard check‑out time is 11:00 AM."),
            ("Sure thing. Just let...", "Sure thing—just let me know your desired check‑in date."),
            ("I'm ready when you are.", "I’m ready when you are—just let me know your check‑in date."),
        ):
            with self.subTest(transcript=transcript):
                self.assertTrue(_is_probable_playback_echo(transcript, spoken, barge_in=True))

    def test_greeting_fragment_is_echo(self):
        spoken = "Thanks for calling Aurora Hotel reservations. How can I help?"
        self.assertTrue(_is_probable_playback_echo("Thanks for", spoken))

    def test_welcome_fragment_of_the_last_reply_is_echo(self):
        spoken = "You're welcome! Is there anything else I can help you with?"
        self.assertTrue(_is_probable_playback_echo("Welcome.", spoken))

    def test_real_interruption_is_kept(self):
        spoken = (
            "You may cancel without charge until 6:00 PM local hotel time "
            "two days before arrival."
        )
        self.assertFalse(_is_probable_playback_echo("Wait, speak Tamil.", spoken))

    def test_check_in_question_is_kept(self):
        spoken = "Puede cancelar sin cargo hasta las 6:00 PM."
        self.assertFalse(_is_probable_playback_echo("What time is check-in?", spoken))

    def test_near_duplicate_reply_is_echo(self):
        spoken = "Check-in starts at 3:00 PM and check-out is at 11:00 AM."
        self.assertTrue(
            _is_probable_playback_echo(
                "Check-in starts at 3 PM and check-out is at 11 AM",
                spoken,
            )
        )

    def test_whisper_hallucination_is_echo(self):
        spoken = "Thanks for calling Aurora Hotel reservations. How can I help?"
        self.assertTrue(_is_probable_playback_echo("Thank you for watching.", spoken))
        self.assertTrue(_is_probable_playback_echo("Subtitles by the Amara.org community", spoken))
        # Real caller closings / courtesies must not be dropped as echo.
        self.assertFalse(_is_probable_playback_echo("Goodbye", spoken))
        self.assertFalse(_is_probable_playback_echo("நன்றி", spoken))
        self.assertFalse(_is_probable_playback_echo("nandri", spoken))

    def test_token_overlap_fragment_is_echo(self):
        spoken = "We have a Standard Queen for $189 per night and a Deluxe King for $229. Which would you like?"
        self.assertTrue(_is_probable_playback_echo("Standard Queen night", spoken))
        self.assertTrue(_is_probable_playback_echo("Deluxe King which would you like", spoken))

    def test_correlated_stt_near_match_is_filtered_but_short_answers_survive(self):
        spoken = "We have a Standard Queen for $189 per night and a Deluxe King for $229."
        evidence = {'correlation': .9671, 'residualEnergyFraction': .064738,
                    'residualGain': 2.892}
        self.assertFalse(_is_probable_playback_echo(
            "We have a stand-up.", spoken, barge_in=True))
        self.assertTrue(_is_probable_playback_echo(
            "We have a stand-up.", spoken, barge_in=True, echo_evidence=evidence))
        self.assertFalse(_is_probable_playback_echo(
            "Standard Queen", spoken, barge_in=True, echo_evidence=evidence))
        self.assertFalse(_is_probable_playback_echo(
            "What about cancellation?", spoken, barge_in=True, echo_evidence=evidence))

    def test_tamil_real_interruption_is_kept(self):
        spoken = "அரோரா ஹோட்டல் முன்பதிவில் உதவ முடியும்."
        self.assertFalse(_is_probable_playback_echo("ரத்து கொள்கை என்ன?", spoken))

    def test_barge_in_keeps_topic_followups(self):
        spoken = (
            "You may cancel without charge until 6:00 PM local hotel time "
            "two days before arrival."
        )
        self.assertFalse(
            _is_probable_playback_echo("Wait, speak Tamil.", spoken, barge_in=True)
        )
        self.assertFalse(
            _is_probable_playback_echo("What about cancellation?", spoken, barge_in=True)
        )

        options = (
            "We have a Standard Queen for $189 per night and a Deluxe King for $229. "
            "Which would you like?"
        )
        # Caller interrupting to answer must never be dropped as echo
        self.assertFalse(_is_probable_playback_echo("Standard Queen", options, barge_in=True))
        self.assertFalse(_is_probable_playback_echo("Deluxe King", options, barge_in=True))
        self.assertFalse(_is_probable_playback_echo("Yes", options, barge_in=True))
        self.assertFalse(_is_probable_playback_echo("No", options, barge_in=True))

    def test_barge_in_suppresses_whisper_fillers(self):
        spoken = "Sure, what can I assist you with today at Aurora Hotel?"
        for filler in ("Thanks.", "Well,", "So...", "Hotel", "Um"):
            self.assertTrue(
                _is_probable_playback_echo(filler, spoken, barge_in=True),
                filler,
            )
        self.assertFalse(_is_probable_playback_echo("Wait", spoken, barge_in=True))
        self.assertFalse(_is_probable_playback_echo("Yes", spoken, barge_in=True))


class StaticCacheTests(unittest.TestCase):
    def test_web_assets_are_uncached(self):
        self.assertTrue(static_no_store("/"))
        self.assertTrue(static_no_store("/web/talk.js"))
        self.assertTrue(static_no_store("/web/index.html?v=1"))
        self.assertFalse(static_no_store("/token"))
        self.assertFalse(static_no_store("/state"))


class ListenAddressTests(unittest.TestCase):
    def test_local_default_stays_on_localhost(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PORT", None)
            os.environ.pop("TALK_PORT", None)
            os.environ.pop("TALK_HOST", None)
            self.assertEqual(listen_address(), ("localhost", 5173))

    def test_railway_port_binds_all_interfaces(self):
        with patch.dict(os.environ, {"PORT": "8080"}, clear=False):
            os.environ.pop("TALK_PORT", None)
            os.environ.pop("TALK_HOST", None)
            self.assertEqual(listen_address(), ("0.0.0.0", 8080))

    def test_explicit_talk_port_keeps_the_local_demo(self):
        with patch.dict(
            os.environ,
            {"PORT": "8080", "TALK_PORT": "5173", "TALK_HOST": "localhost"},
        ):
            self.assertEqual(listen_address(), ("localhost", 5173))


class HostedConfigTests(unittest.TestCase):
    def test_public_bind_rejects_local_defaults_without_echoing_them(self):
        with patch.dict(
            os.environ,
            {
                "LIVEKIT_URL": "ws://localhost:7880",
                "LIVEKIT_API_KEY": "devkey",
                "LIVEKIT_API_SECRET": "secret",
                "PROVIDER": "mock",
                "GROQ_API_KEY": "not-a-real-key",
                "TELEMETRY_INCLUDE_CONTENT": "true",
            },
        ):
            errors = hosted_config_errors()
            report = "\n".join(errors)
            self.assertIn("LIVEKIT_URL", report)
            self.assertIn("LIVEKIT_API_KEY", report)
            self.assertIn("PROVIDER", report)
            self.assertIn("TELEMETRY_INCLUDE_CONTENT", report)
            self.assertNotIn("devkey", report)
            self.assertNotIn("not-a-real-key", report)
            self.assertNotIn("ws://localhost:7880", report)

    def test_cloud_settings_pass_without_printing_credentials(self):
        with patch.dict(
            os.environ,
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "cloud-key",
                "LIVEKIT_API_SECRET": "cloud-secret-value",
                "PROVIDER": "groq",
                "GROQ_API_KEY": "present",
                "TELEMETRY_INCLUDE_CONTENT": "false",
            },
        ):
            self.assertEqual(hosted_config_errors(), [])


class LanguageAwareSttTests(unittest.TestCase):
    def test_stt_receives_active_session_language_and_tamil_prompt(self):
        fake_client = Mock()
        fake_client.audio.transcriptions.create.return_value = "வணக்கம்"

        class DummyProvider:
            stt_model = "whisper-large-v3-turbo"
            client = fake_client

            def get_stt_prompt(self, language):
                return "தமிழ் ஹோட்டல் முன்பதிவு"

        dummy_agent = SimpleNamespace(
            current_language="ta",
            current_locale="ta-IN",
            provider=DummyProvider(),
            last_sources=[],
            respond=lambda transcript, trace=None: ("பதில்", None),
        )

        with patch("talk_server._get_session", return_value=(dummy_agent, threading.Lock())):
            with patch("talk_server._speech_evidence", return_value={"maxSpeechProbability": 0.9, "speechThreshold": 0.3}):
                with patch("talk_server._browser_tts_payload", return_value={"ttsBackend": "browser"}):
                    # 16-bit mono wav audio
                    buffer = BytesIO()
                    with wave.open(buffer, "wb") as wav_file:
                        wav_file.setnchannels(1)
                        wav_file.setsampwidth(2)
                        wav_file.setframerate(16000)
                        wav_file.writeframes(b"\x00\x00" * 3200)
                    audio_data = buffer.getvalue()

                    response = _voice_agent_reply(
                        audio=audio_data,
                        content_type="audio/wav",
                        session_id="test-session-ta",
                        turn_id="turn-1",
                        was_barge_in=False,
                    )

        call_kwargs = fake_client.audio.transcriptions.create.call_args.kwargs
        self.assertEqual(call_kwargs.get("language"), "ta")
        self.assertEqual(call_kwargs.get("prompt"), "தமிழ் ஹோட்டல் முன்பதிவு")
        self.assertEqual(response["transcript"], "வணக்கம்")


class VerbalizeTtsTests(unittest.TestCase):
    def test_verbalize_tamil_iso_dates_and_codes_and_currency(self):
        from talk_server import _verbalize_for_tts

        input_text = "முன்பதிவு AH-4827 உறுதிப்படுத்தப்பட்டது. தேதி 2026-08-12 முதல் 2026-08-18 வரை. கட்டணம் $24."
        verbalized = _verbalize_for_tts(input_text, "ta-IN")
        self.assertIn("A H 4 8 2 7", verbalized)
        self.assertIn("ஆகஸ்ட் 12, 2026", verbalized)
        self.assertIn("ஆகஸ்ட் 18, 2026", verbalized)
        self.assertIn("24 டாலர்", verbalized)
        self.assertNotIn("2026-08-12", verbalized)
        self.assertNotIn("AH-4827", verbalized)

    def test_verbalize_english_and_spanish(self):
        from talk_server import _verbalize_for_tts

        en_text = _verbalize_for_tts("Confirmed AH-4827 from 2026-08-12 to 2026-08-18 at $189.", "en-US")
        self.assertIn("August 12, 2026", en_text)
        self.assertIn("A H 4 8 2 7", en_text)
        self.assertIn("189 dollars", en_text)

        es_text = _verbalize_for_tts("Confirmado AH-4827 del 2026-08-12 por $229.", "es-ES")
        self.assertIn("12 de agosto de 2026", es_text)
        self.assertIn("A H 4 8 2 7", es_text)
        self.assertIn("229 dólares", es_text)


if __name__ == "__main__":
    unittest.main()
