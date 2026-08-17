#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# Bootstrap `agents.lib` so `from agents.lib import safe_run` works under plain
# `python3 <this>.py` invocations. Walks up from `__file__` looking for a
# directory containing `agents/lib/`.
import sys as _sys
from pathlib import Path as _p
_w = next(
    (a for a in [_p(__file__).resolve().parent, *_p(__file__).resolve().parents]
     if (a / "agents" / "lib").is_dir()), None)
if _w is not None and str(_w) not in _sys.path:
    _sys.path.insert(0, str(_w))
del _sys, _p, _w

from agents.lib import safe_run

_env_ws = os.environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env_ws).resolve() if _env_ws else Path.home() / ".openclaw" / "workspace"
SCRIPT = Path(__file__).resolve().parent / "x" / "run.cjs"
BRAIN_ROOT = WORKSPACE / "brain"
TRANSITIONS_PATH = BRAIN_ROOT / "state" / "bookmark-transitions.jsonl"
BOOKMARKS_ROOT = BRAIN_ROOT / "bookmarks"


def _md_snapshot() -> set[Path]:
    if not BOOKMARKS_ROOT.exists():
        return set()
    return set(BOOKMARKS_ROOT.rglob("*.md"))


def _file_key(path: Path) -> str:
    rel = path.relative_to(BRAIN_ROOT.parent)
    return hashlib.md5(str(rel).encode()).hexdigest()[:16]


def _file_at(path: Path) -> str:
    st = path.stat()
    ts = getattr(st, "st_birthtime", None) or st.st_mtime
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log_new_files(new_files: set[Path]) -> None:
    TRANSITIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with TRANSITIONS_PATH.open("a") as fh:
        for path in sorted(new_files):
            entry = {
                "at": _file_at(path),
                "key": _file_key(path),
                "from": None,
                "to": "ingested",
                "reason": "x_ingest",
            }
            fh.write(json.dumps(entry) + "\n")


def main() -> int:
    p = argparse.ArgumentParser(description="Thin wrapper around existing X bookmark ingest flow")
    p.add_argument("--force", action="store_true", help="Process pending only")
    p.add_argument("--max-items", type=int, help="Maximum number of bookmarks to fetch from X")
    args = p.parse_args()

    cmd = ["node", str(SCRIPT)]
    if args.force:
        cmd.append("--force")
    max_items = args.max_items if args.max_items is not None else 20
    cmd.extend(["--max-items", str(max_items)])

    env = os.environ.copy()
    env.setdefault("OPENCLAW_WORKSPACE", str(WORKSPACE))

    before = _md_snapshot()
    result = safe_run(cmd, cwd=str(WORKSPACE), env=env)

    if result.returncode == 0:
        after = _md_snapshot()
        new_files = after - before
        if new_files:
            _log_new_files(new_files)

    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
