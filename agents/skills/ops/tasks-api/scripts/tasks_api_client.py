#!/usr/bin/env python3
"""Deprecated location shim for the Tasks API client.

The maintained client is a single file at the skill root:

    agents/skills/ops/tasks-api/tasks_api_client.py

This file exists only so the old
``agents/skills/ops/tasks-api/scripts/tasks_api_client.py`` path keeps
working. It forwards every argument and the exit code to the maintained
client and prints a deprecation notice on stderr, so a caller using the old
path no longer fails with an opaque "No such file or directory" (exit 2).
"""
from __future__ import annotations

import os
import pathlib
import sys

CANONICAL = pathlib.Path(__file__).resolve().parent.parent / "tasks_api_client.py"


def main() -> int:
    print(
        "DEPRECATED: tasks_api_client.py moved to the skill root.\n"
        f"Use: {CANONICAL}\n"
        "This path forwards to the maintained client and will be removed.",
        file=sys.stderr,
    )
    if not CANONICAL.is_file():
        print(
            f"FATAL: maintained client not found at {CANONICAL}", file=sys.stderr
        )
        return 2
    os.execv(sys.executable, [sys.executable, str(CANONICAL), *sys.argv[1:]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
