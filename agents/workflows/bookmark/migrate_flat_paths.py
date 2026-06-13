#!/usr/bin/env python3
"""
One-shot migration: flatten bookmark and summary file paths.

Before:
  brain/bookmarks/x/<topic>/filename.md
  brain/reviews/<topic>/filename.md

After:
  brain/bookmarks/x/filename.md
  brain/bookmarks/summaries/filename.md

Updates state (path, summaryDoc, reviewDoc) for all items.
Run with --dry-run first.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

_env = __import__("os").environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env).resolve() if _env else Path(__file__).resolve().parents[5]

STATE_PATH = WORKSPACE / "brain" / "state" / "bookmark-review-state.json"
OLD_BOOKMARKS_ROOT = WORKSPACE / "brain" / "bookmarks" / "x"
NEW_BOOKMARKS_ROOT = WORKSPACE / "brain" / "bookmarks" / "x"
OLD_REVIEWS_ROOT = WORKSPACE / "brain" / "reviews"
NEW_SUMMARIES_ROOT = WORKSPACE / "brain" / "bookmarks" / "summaries"


def move(src: Path, dst: Path, dry_run: bool) -> bool:
    if not src.exists():
        return False
    if dst.exists():
        print(f"  SKIP (exists): {dst.relative_to(WORKSPACE)}")
        return False
    if dry_run:
        print(f"  WOULD MOVE: {src.relative_to(WORKSPACE)} -> {dst.relative_to(WORKSPACE)}")
        return True
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    print(f"  MOVED: {src.relative_to(WORKSPACE)} -> {dst.relative_to(WORKSPACE)}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry_run = args.dry_run

    if dry_run:
        print("DRY RUN — no files or state will be changed\n")

    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    items = state.get("items", {})

    bookmark_moves = 0
    summary_moves = 0
    state_updates = 0

    # --- Move bookmark files (bookmarks/x/<topic>/file -> bookmarks/x/file) ---
    print("=== Bookmark files ===")
    for topic_dir in sorted(OLD_BOOKMARKS_ROOT.iterdir()):
        if not topic_dir.is_dir():
            continue
        for f in sorted(topic_dir.glob("*.md")):
            dst = NEW_BOOKMARKS_ROOT / f.name
            if move(f, dst, dry_run):
                bookmark_moves += 1

    # --- Move summary files (reviews/<topic>/file -> bookmarks/summaries/file) ---
    print("\n=== Summary files ===")
    for topic_dir in sorted(OLD_REVIEWS_ROOT.iterdir()):
        if not topic_dir.is_dir():
            continue
        for f in sorted(topic_dir.glob("*.md")):
            dst = NEW_SUMMARIES_ROOT / f.name
            if move(f, dst, dry_run):
                summary_moves += 1

    # Also handle any loose .md files at reviews root
    for f in sorted(OLD_REVIEWS_ROOT.glob("*.md")):
        dst = NEW_SUMMARIES_ROOT / f.name
        if move(f, dst, dry_run):
            summary_moves += 1

    # --- Update state paths ---
    print("\n=== State updates ===")
    for key, item in items.items():
        changed = False

        # path: brain/bookmarks/x/<topic>/filename -> brain/bookmarks/x/filename
        old_path = item.get("path", "")
        if old_path and old_path.startswith("brain/bookmarks/x/"):
            parts = old_path[len("brain/bookmarks/x/"):].split("/")
            if len(parts) == 2:  # topic/filename
                new_path = f"brain/bookmarks/x/{parts[1]}"
                if old_path != new_path:
                    if dry_run:
                        print(f"  WOULD UPDATE path [{key}]: {old_path} -> {new_path}")
                    else:
                        item["path"] = new_path
                        print(f"  UPDATE path [{key}]: {old_path} -> {new_path}")
                    changed = True

        # summaryDoc: brain/reviews/<topic>/filename -> brain/bookmarks/summaries/filename
        for field in ("summaryDoc", "reviewDoc"):
            old_doc = item.get(field, "")
            if old_doc and old_doc.startswith("brain/reviews/"):
                filename = Path(old_doc).name
                new_doc = f"brain/bookmarks/summaries/{filename}"
                if old_doc != new_doc:
                    if dry_run:
                        print(f"  WOULD UPDATE {field} [{key}]: {old_doc} -> {new_doc}")
                    else:
                        item[field] = new_doc
                        print(f"  UPDATE {field} [{key}]: {old_doc} -> {new_doc}")
                    changed = True

        if changed:
            state_updates += 1

    if not dry_run:
        STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nState saved.")

    print(f"\n{'DRY RUN ' if dry_run else ''}Summary:")
    print(f"  Bookmark files {'would move' if dry_run else 'moved'}: {bookmark_moves}")
    print(f"  Summary files {'would move' if dry_run else 'moved'}: {summary_moves}")
    print(f"  State items {'would update' if dry_run else 'updated'}: {state_updates}")

    if dry_run:
        print("\nRe-run without --dry-run to apply.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
