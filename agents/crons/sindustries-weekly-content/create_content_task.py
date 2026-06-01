#!/usr/bin/env python3
"""
Final step of sindustries-weekly-content lobster.

Reads review metadata from stdin and creates a content task in the Tasks API.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]


def main() -> None:
    data = json.load(sys.stdin)
    review_path = data.get("review_path", "")
    review_date = data.get("review_date", "")

    env = {
        **os.environ,
        "TASKS_API_BASE_URL": os.environ.get("TASKS_API_BASE_URL", "http://localhost:4001/api/v1"),
    }

    subprocess.run(
        [
            "python3", str(WORKSPACE / "scripts" / "tasks_api_client.py"), "create",
            "--title", f"Weekly content review — {review_date}",
            "--type", "content",
            "--description", f"Weekly SIndustries content notes ready for triage: {review_path}",
            "--priority", "normal",
        ],
        env=env,
        check=True,
    )

    print(json.dumps(data))


if __name__ == "__main__":
    main()
