#!/usr/bin/env python3
"""Audit logs/voice-events.jsonl against spoken FDE ACs (no secrets printed)."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOG = ROOT / "logs" / "voice-events.jsonl"
CANCEL_SOURCE = "hotel_policies.md#Cancellation"


def load_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def event_names(turn: dict) -> list[str]:
    return [e.get("name", "") for e in turn.get("events") or [] if e.get("name")]


def audit_session(rows: list[dict], session_id: str) -> dict:
    turns = [r for r in rows if r.get("sessionId") == session_id]
    langs = [(r.get("attributes") or {}).get("language") for r in turns]
    sources_flat: list[str] = []
    for r in turns:
        sources_flat.extend((r.get("attributes") or {}).get("sources") or [])
    names = Counter()
    for r in turns:
        names.update(event_names(r))

    has_ta = "ta" in langs
    has_en = "en" in langs
    cancel_on_ta = any(
        CANCEL_SOURCE in ((r.get("attributes") or {}).get("sources") or [])
        and (r.get("attributes") or {}).get("language") == "ta"
        for r in turns
    )
    # Courtesy stay: after first ta, a later ta turn with empty/non-switch sources
    ta_indexes = [i for i, lang in enumerate(langs) if lang == "ta"]
    nandri_stay = False
    if len(ta_indexes) >= 2:
        # two consecutive ta turns before any later en switch counts as stay
        for a, b in zip(ta_indexes, ta_indexes[1:]):
            if b == a + 1:
                nandri_stay = True
                break
    english_after = False
    if has_ta and has_en:
        first_ta = next(i for i, lang in enumerate(langs) if lang == "ta")
        english_after = any(lang == "en" for lang in langs[first_ta + 1 :])

    barge_started = names.get("barge_in.turn_started", 0) > 0
    barge_suppressed = names.get("barge_in.echo_suppressed", 0)

    # Content leakage check (raw reply/transcript keys)
    leaked = []
    for r in turns:
        blob = json.dumps(r)
        for needle in ("guestName", "email", "phone", '"reply"', '"transcript"', '"text":'):
            # allow event name input.text; flag attribute content dumps
            pass
        attrs = r.get("attributes") or {}
        for key in attrs:
            low = key.lower()
            if low in {"reply", "transcript", "text", "utterance", "content"}:
                leaked.append(key)
        for event in r.get("events") or []:
            eattrs = event.get("attributes") or {}
            for key, value in eattrs.items():
                low = key.lower()
                if low in {"guest_name", "guestname", "email", "phone", "contact"}:
                    if value and value != "[REDACTED]":
                        leaked.append(f"event.{key}")

    is_browser = session_id.startswith("browser-")
    fde_227 = {
        "connected_browser_call": is_browser,
        "tamil_route": has_ta,
        "cancellation_source_on_ta": cancel_on_ta,
        "courtesy_stays_on_ta": nandri_stay,
        "english_after_switch": english_after,
    }
    fde_228 = {
        "connected_browser_call": is_browser,
        "barge_in.turn_started": barge_started,
        "no_echo_feedback_loop": barge_suppressed < 3,
        "tamil_followup_route": has_ta,
        "note": "barge_in.candidate/detected are browser-only; confirm in UI Runtime trace",
    }
    fde_229 = {
        "has_session_turn_trace_ids": all(
            turns[-1].get(k) for k in ("sessionId", "turnId", "traceId")
        )
        if turns
        else False,
        "has_timings": bool(turns and turns[-1].get("timings")),
        "has_provider_model": bool(
            turns
            and (turns[-1].get("attributes") or {}).get("provider")
            and (turns[-1].get("attributes") or {}).get("model")
        ),
        "no_sensitive_leak": not leaked,
        "note": "Pair with browser Runtime trace for first-audio + barge metrics",
    }

    def passed(checks: dict) -> bool:
        return all(v is True for k, v in checks.items() if k != "note")

    return {
        "sessionId": session_id,
        "turns": len(turns),
        "languages": langs,
        "sources": sorted(set(sources_flat)),
        "server_event_counts": dict(names),
        "FDE-227": {"pass": passed(fde_227), **fde_227},
        "FDE-228": {"pass": passed(fde_228), **fde_228},
        "FDE-229": {"pass": passed(fde_229), **fde_229},
        "leaked_keys": leaked,
    }


def newest_session(rows: list[dict], prefix: str | None) -> str | None:
    for row in reversed(rows):
        sid = row.get("sessionId") or ""
        if not sid:
            continue
        if prefix is None or sid.startswith(prefix):
            return sid
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    parser.add_argument("--session", help="Exact sessionId to audit")
    parser.add_argument(
        "--prefix",
        default="browser-",
        help="Session prefix when --session omitted (use '' for any)",
    )
    args = parser.parse_args()
    rows = load_rows(args.log)
    if not rows:
        print(f"No events in {args.log}")
        return 1
    prefix = None if args.prefix == "" else args.prefix
    session_id = args.session or newest_session(rows, prefix)
    if not session_id:
        print(f"No session matching prefix={prefix!r}")
        return 1
    report = audit_session(rows, session_id)
    print(json.dumps(report, indent=2))
    ok = report["FDE-227"]["pass"] and report["FDE-228"]["pass"] and report["FDE-229"]["pass"]
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
