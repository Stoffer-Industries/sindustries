#!/usr/bin/env python3
"""Thin wrapper that invokes the CTO Craft workflow CLI.

The cron prompt and ``run_once`` calls invoke this script via
``uv run --frozen python run.py <command>``. The actual implementation
lives in ``cto_craft_workflow.cli:main``.
"""

from __future__ import annotations

import sys

from cto_craft_workflow.cli import main


if __name__ == "__main__":
    sys.exit(main())
