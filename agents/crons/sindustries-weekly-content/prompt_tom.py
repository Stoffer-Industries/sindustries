#!/usr/bin/env python3
"""
Step 1 of sindustries-weekly-content lobster.

Emits the approval prompt text that the lobster runtime presents to Tom.
Tom's answer becomes the raw notes for this week's content file.
"""
from __future__ import annotations

import json
import sys
from datetime import date


def main() -> None:
    today = date.today()
    prompt = (
        f"Weekly SIndustries review — {today}\n\n"
        "What changed this week that SIndustries should remember?\n\n"
        "Think about: experiments, releases, systems, stacks, lessons, or stories worth capturing.\n\n"
        "Any new things you shipped, started, paused, or learned? "
        "Reply with free-form notes — even rough bullet points work. "
        "Quinn will distil them into draft content for your review."
    )
    result = {
        "prompt": prompt,
        "week": str(today),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
