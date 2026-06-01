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

    client = WORKSPACE / "codebases" / "sindustries" / "agents" / "skills" / "tasks-api-ops" / "tasks_api_client.py"
    subprocess.run(
        [
            "python3", str(client), "create",
            "--title", f"Weekly content review — {review_date}",
            "--description", f"Weekly SIndustries content notes ready for triage: {review_path}",
            "--status", "ready",
            "--priority", "medium",
            "--tags", "content", "weekly-review", f"review-{review_date}",
        ],
        env=env,
        check=True,
    )

    print(json.dumps(data))


if __name__ == "__main__":
    main()
