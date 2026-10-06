"""Unit tests for spoken FDE session auditing."""

from __future__ import annotations

import unittest

from audit_spoken_session import audit_session


def _turn(session_id: str, language: str, sources=None, events=None, **extra):
    attrs = {
        "language": language,
        "locale": f"{language}-IN" if language == "ta" else "en-US",
        "provider": "groq",
        "model": "test-model",
        "sources": sources or [],
    }
    attrs.update(extra.pop("attributes", {}))
    return {
        "schemaVersion": "1.0",
        "traceId": "trace",
        "sessionId": session_id,
        "turnId": "turn",
        "timings": {"llm": 1.0},
        "attributes": attrs,
        "events": events or [{"name": "turn.completed", "attributes": {}}],
        **extra,
    }


class AuditSpokenSessionTests(unittest.TestCase):
    def test_tamil_browser_sequence_passes_227_and_229(self):
        sid = "browser-test-tamil"
        rows = [
            _turn(sid, "ta"),
            _turn(sid, "ta", sources=["hotel_policies.md#Cancellation"]),
            _turn(sid, "ta"),
            _turn(sid, "en"),
            _turn(sid, "en", sources=["hotel_policies.md#Check-In And Check-Out"]),
        ]
        report = audit_session(rows, sid)
        self.assertTrue(report["FDE-227"]["pass"])
        self.assertTrue(report["FDE-229"]["pass"])
        self.assertFalse(report["FDE-228"]["pass"])  # no barge yet

    def test_barge_turn_unlocks_228(self):
        sid = "browser-test-barge"
        rows = [
            _turn(
                sid,
                "ta",
                sources=["hotel_policies.md#Cancellation"],
                events=[
                    {"name": "barge_in.turn_started", "attributes": {}},
                    {"name": "turn.completed", "attributes": {}},
                ],
            ),
            _turn(sid, "ta"),
        ]
        report = audit_session(rows, sid)
        self.assertTrue(report["FDE-228"]["pass"])

    def test_text_preflight_fails_connected_call_gate(self):
        sid = "preflight-tamil-1"
        rows = [
            _turn(sid, "ta"),
            _turn(sid, "ta", sources=["hotel_policies.md#Cancellation"]),
            _turn(sid, "ta"),
            _turn(sid, "en"),
            _turn(sid, "en"),
        ]
        report = audit_session(rows, sid)
        self.assertFalse(report["FDE-227"]["pass"])
        self.assertFalse(report["FDE-227"]["connected_browser_call"])


if __name__ == "__main__":
    unittest.main()
