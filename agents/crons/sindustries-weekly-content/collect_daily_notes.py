#!/usr/bin/env python3
"""
Step 1 of sindustries-weekly-content lobster.

Collects raw ops notes from brain/ops/notes/ for the current week
(Friday–Thursday) and emits them as JSON for the llm.invoke distil step.
"""
from __future__ import annotations

import datetime
import json
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]


def review_date() -> datetime.date:
    today = datetime.date.today()
    days_since_friday = (today.weekday() - 4) % 7
    return today - datetime.timedelta(days=days_since_friday)


def collect_weekly_notes(workspace: Path) -> list[str]:
    notes_root = workspace / "brain" / "ops" / "notes"
    rd = review_date()
    week_start = rd - datetime.timedelta(days=6)

    notes: list[str] = []
    if not notes_root.exists():
        return notes

    for day_offset in range(7):
        day = week_start + datetime.timedelta(days=day_offset)
        notes_file = notes_root / f"{day}.md"
        if notes_file.exists():
            for line in notes_file.read_text().splitlines():
                stripped = line.strip()
                if stripped.startswith("- ["):
                    notes.append(stripped)
    return notes


def main() -> None:
    notes = collect_weekly_notes(WORKSPACE)
    print(json.dumps({
        "daily_notes": notes,
        "daily_notes_count": len(notes),
        "review_date": str(review_date()),
    }))


if __name__ == "__main__":
    main()
