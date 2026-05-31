#!/usr/bin/env python3
"""
Step 2 of sindustries-weekly-review lobster.

Reads Tom's notes from stdin (lobster approval response),
creates the weekly review file at brain/reviews/website-content/YYYY-MM-DD.md,
and passes the file path + raw notes to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]

TEMPLATE = """\
# SIndustries Weekly Review — {date}

## Needs approval from Tom

_Items here require Tom's personal sign-off before becoming content tasks.
These include first-person voice copy, strategic claims, revenue/customer references,
or anything that could be read as a public commitment._

<!-- append items here as bullet points -->

## Needs approval from Quinn

_Items Quinn can approve without escalating to Tom.
Stack additions, factual metadata updates, experiment status changes with task evidence._

<!-- append items here as bullet points -->

## Daily notes

_Raw notes appended by heartbeat. Not yet triaged._

<!-- heartbeat appends here with date stamps -->

## Tom's notes this week

{raw_notes}
"""


def review_date() -> date:
    today = date.today()
    # Most recent Friday (or today if Friday)
    days_since_friday = (today.weekday() - 4) % 7
    return today - timedelta(days=days_since_friday)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reviews-root", default="brain/reviews/website-content")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    stdin_data = json.load(sys.stdin)
    raw_notes = stdin_data.get("approvalResponse", "").strip() or stdin_data.get("prompt", "")
    week = stdin_data.get("week", str(date.today()))

    rd = review_date()
    reviews_root = WORKSPACE / args.reviews_root
    reviews_root.mkdir(parents=True, exist_ok=True)
    review_path = reviews_root / f"{rd}.md"

    if not args.dry_run:
        if review_path.exists():
            # Append Tom's notes to existing file rather than overwriting
            existing = review_path.read_text()
            if "## Tom's notes this week" not in existing:
                review_path.write_text(existing.rstrip() + f"\n\n## Tom's notes this week\n\n{raw_notes}\n")
        else:
            review_path.write_text(TEMPLATE.format(date=rd, raw_notes=raw_notes))

    result = {
        "review_path": str(review_path.relative_to(WORKSPACE)),
        "review_date": str(rd),
        "raw_notes": raw_notes,
        "dry_run": args.dry_run,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
