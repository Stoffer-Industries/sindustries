#!/usr/bin/env python3
"""
Step 3 of sindustries-weekly-content lobster.

Reads the daily notes from brain/ops/notes/ for the current week and passes
them alongside the review file path to stdout. The lobster agent uses this
output to triage notes into the Tom/Quinn approval sections before the
create_content_task step.
"""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]


def collect_weekly_notes(workspace: Path) -> list[str]:
    notes_root = workspace / "brain" / "ops" / "notes"
    today = datetime.date.today()
    days_since_friday = (today.weekday() - 4) % 7
    week_start = today - datetime.timedelta(days=days_since_friday + 6)

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
    stdin_data = json.load(sys.stdin)

    daily_notes = collect_weekly_notes(WORKSPACE)

    result = {
        **stdin_data,
        "daily_notes": daily_notes,
        "daily_notes_count": len(daily_notes),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
