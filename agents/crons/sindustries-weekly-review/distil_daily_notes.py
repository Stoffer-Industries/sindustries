#!/usr/bin/env python3
"""
Step 3 of sindustries-weekly-review lobster.

Reads the weekly review file, extracts any accumulated daily notes,
and asks the agent (Quinn/Ivy) to distil them into the Tom/Quinn approval sections.

This script outputs the review file path and distilled content for the PR step.
The actual distillation happens via the agent invoking content-notes skill logic.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]

HEARTBEAT_MARKER = "<!-- heartbeat appends here with date stamps -->"


def extract_daily_notes(content: str) -> list[str]:
    section_match = re.search(r"## Daily notes\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if not section_match:
        return []
    section_text = section_match.group(1)
    lines = [l.strip() for l in section_text.splitlines() if l.strip() and not l.strip().startswith("<!--") and not l.strip().startswith("_")]
    return lines


def main() -> None:
    stdin_data = json.load(sys.stdin)
    review_path_str = stdin_data.get("review_path", "")
    review_path = WORKSPACE / review_path_str

    daily_notes: list[str] = []
    if review_path.exists():
        content = review_path.read_text()
        daily_notes = extract_daily_notes(content)

    result = {
        **stdin_data,
        "daily_notes": daily_notes,
        "daily_notes_count": len(daily_notes),
        "ready_for_pr": True,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
