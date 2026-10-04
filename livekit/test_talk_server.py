"""Offline tests for browser TTS payload selection and hosted bind rules."""

from __future__ import annotations

import base64
import os
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from talk_server import _browser_tts_payload, hosted_config_errors, listen_address


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
        payload = _browser_tts_payload(FakeAgent(provider), FakeTrace(), "Hello")

        self.assertEqual(payload, {"ttsBackend": "browser"})
        self.assertEqual(provider.calls, [])

    def test_provider_failure_falls_back_without_exposing_error(self):
        provider = FakeProvider(error=RuntimeError("secret provider response"))
        trace = FakeTrace()
        payload = _browser_tts_payload(FakeAgent(provider), trace, "Hello")

        self.assertEqual(payload, {"ttsBackend": "browser", "ttsFallback": True})
        self.assertEqual(trace.events[0][0], "tts.fallback")
        self.assertNotIn("secret provider response", str(payload))


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


if __name__ == "__main__":
    unittest.main()
