#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any

from common import STATE_PATH, TRANSITIONS_PATH, dump_json, load_state, transition_log_path


def parse_time(value: Any) -> dt.datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def load_latest_transitions(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    latest: dict[str, dict[str, Any]] = {}
    invalid: list[dict[str, Any]] = []
    if not path.exists():
        return latest, invalid

    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError as exc:
                invalid.append({"line": line_number, "error": str(exc)})
                continue
            key = str(event.get("key") or "").strip()
            at = parse_time(event.get("at"))
            if not key or not at:
                invalid.append({"line": line_number, "error": "missing key or parseable at"})
                continue
            previous = latest.get(key)
            if previous is None or at >= previous["at"]:
                latest[key] = {"at": at, "event": event, "line": line_number}
    return latest, invalid


def check_state(state_path: Path, transitions_path: Path) -> dict[str, Any]:
    state = load_state(state_path)
    latest, invalid = load_latest_transitions(transitions_path)
    missing = []
    drift = []
    unparseable = []

    for key, item in sorted((state.get("items") or {}).items()):
        last_updated = parse_time(item.get("lastUpdatedAt"))
        if not last_updated:
            unparseable.append({"key": key, "lastUpdatedAt": item.get("lastUpdatedAt")})
            continue
        transition = latest.get(str(key))
        if transition is None:
            missing.append({
                "key": key,
                "reviewStatus": item.get("reviewStatus"),
                "lastUpdatedAt": item.get("lastUpdatedAt"),
            })
            continue
        if last_updated > transition["at"]:
            drift.append({
                "key": key,
                "reviewStatus": item.get("reviewStatus"),
                "lastUpdatedAt": item.get("lastUpdatedAt"),
                "lastTransitionAt": transition["event"].get("at"),
                "lastTransition": f"{transition['event'].get('from')} -> {transition['event'].get('to')}",
                "line": transition["line"],
            })

    return {
        "ok": not drift and not invalid and not unparseable,
        "statePath": str(state_path),
        "transitionsPath": str(transitions_path),
        "checked": len(state.get("items") or {}),
        "drift": drift,
        "missingTransitionHistory": missing,
        "invalidTransitionLines": invalid,
        "unparseableStateTimestamps": unparseable,
    }


def print_report(result: dict[str, Any]) -> None:
    print("Bookmark transition drift check")
    print(f"State: {result['statePath']}")
    print(f"Transitions: {result['transitionsPath']}")
    print(f"Checked: {result['checked']} item(s)")
    print()

    if result["drift"]:
        print("DRIFT")
        for entry in result["drift"]:
            print(
                f"- {entry['key']}: state lastUpdatedAt={entry['lastUpdatedAt']} "
                f"newer than transition at={entry['lastTransitionAt']} ({entry['lastTransition']})"
            )
        print()

    if result["invalidTransitionLines"]:
        print("INVALID TRANSITION LINES")
        for entry in result["invalidTransitionLines"]:
            print(f"- line {entry['line']}: {entry['error']}")
        print()

    if result["unparseableStateTimestamps"]:
        print("UNPARSEABLE STATE TIMESTAMPS")
        for entry in result["unparseableStateTimestamps"]:
            print(f"- {entry['key']}: lastUpdatedAt={entry['lastUpdatedAt']}")
        print()

    if result["missingTransitionHistory"]:
        print("MISSING TRANSITION HISTORY (warning only for pre-log state)")
        for entry in result["missingTransitionHistory"]:
            print(f"- {entry['key']}: {entry['reviewStatus']} lastUpdatedAt={entry['lastUpdatedAt']}")
        print()

    if result["ok"]:
        warning_count = len(result["missingTransitionHistory"])
        suffix = f" ({warning_count} historical item(s) have no transition history)" if warning_count else ""
        print(f"OK: no drift found{suffix}")
    else:
        print("FAILED: transition log drift or malformed data found")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check bookmark state against the append-only transition log")
    parser.add_argument("--state", default=str(STATE_PATH))
    parser.add_argument("--transitions", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    state_path = Path(args.state)
    transitions_path = Path(args.transitions) if args.transitions else transition_log_path(state_path)
    result = check_state(state_path, transitions_path)
    if args.json:
        dump_json(result)
    else:
        print_report(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
