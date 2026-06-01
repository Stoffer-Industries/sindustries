#!/usr/bin/env python3
"""
Step 3 of sindustries-weekly-content lobster.

Reads classified notes JSON from stdin (output of llm_task.invoke distil step),
writes the weekly content review file, and passes the file path to stdout.

Expected stdin JSON:
  {
    "tom_approval": ["- bullet ...", ...],
    "quinn_approval": ["- bullet ...", ...],
    "review_date": "YYYY-MM-DD"   # optional, calculated locally if absent
  }
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]

TEMPLATE = """\
# SIndustries Weekly Content — {date}

## Needs approval from Tom

_First-person voice, strategic claims, revenue/customer references, public commitments._

{tom_section}

## Needs approval from Quinn

_Factual updates, stack/status changes, experiment status with supporting evidence._

{quinn_section}
"""

EMPTY_SECTION = "<!-- no items this week -->"


def review_date() -> date:
    today = date.today()
    days_since_friday = (today.weekday() - 4) % 7
    return today - timedelta(days=days_since_friday)


def strip_markdown_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reviews-root", default="brain/content/sindustries-weekly-content")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    raw = sys.stdin.read()
    data = json.loads(strip_markdown_fences(raw))

    tom_items: list[str] = data.get("tom_approval") or []
    quinn_items: list[str] = data.get("quinn_approval") or []

    rd_str = data.get("review_date")
    rd = date.fromisoformat(rd_str) if rd_str else review_date()

    tom_section = "\n".join(tom_items) if tom_items else EMPTY_SECTION
    quinn_section = "\n".join(quinn_items) if quinn_items else EMPTY_SECTION

    content = TEMPLATE.format(date=rd, tom_section=tom_section, quinn_section=quinn_section)

    reviews_root = WORKSPACE / args.reviews_root
    review_path = reviews_root / f"{rd}.md"

    if not args.dry_run:
        reviews_root.mkdir(parents=True, exist_ok=True)
        review_path.write_text(content)

    print(json.dumps({
        "review_path": str(review_path.relative_to(WORKSPACE)),
        "review_date": str(rd),
        "tom_count": len(tom_items),
        "quinn_count": len(quinn_items),
        "dry_run": args.dry_run,
    }))


if __name__ == "__main__":
    main()
