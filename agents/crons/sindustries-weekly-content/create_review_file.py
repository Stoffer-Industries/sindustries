#!/usr/bin/env python3
"""
Step 2 of sindustries-weekly-content lobster.

Reads Tom's notes from stdin (lobster approval response),
creates the weekly content file at brain/content/sindustries-weekly-content/YYYY-MM-DD.md,
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
# SIndustries Weekly Content — {date}

## Needs approval from Tom

_First-person voice, strategic claims, revenue/customer references, public commitments._

<!-- append items here as bullet points -->

## Needs approval from Quinn

_Factual updates, stack/status changes, experiment status with supporting evidence._

<!-- append items here as bullet points -->
"""


def review_date() -> date:
    today = date.today()
    days_since_friday = (today.weekday() - 4) % 7
    return today - timedelta(days=days_since_friday)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reviews-root", default="brain/content/sindustries-weekly-content")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    stdin_data = json.load(sys.stdin)
    raw_notes = stdin_data.get("approvalResponse", "").strip()

    rd = review_date()
    reviews_root = WORKSPACE / args.reviews_root
    reviews_root.mkdir(parents=True, exist_ok=True)
    review_path = reviews_root / f"{rd}.md"

    if not args.dry_run:
        if not review_path.exists():
            review_path.write_text(TEMPLATE.format(date=rd))

    result = {
        "review_path": str(review_path.relative_to(WORKSPACE)),
        "review_date": str(rd),
        "raw_notes": raw_notes,
        "dry_run": args.dry_run,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
