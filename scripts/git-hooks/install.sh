#!/usr/bin/env bash
# Installs repo-local git hooks (scripts/git-hooks/*) into .git/hooks for the
# current checkout. Safe to re-run. Idempotent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_SRC="$ROOT_DIR/scripts/git-hooks"
HOOKS_DEST="$ROOT_DIR/.git/hooks"

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  echo "not a git checkout (no .git dir) — skipping hook install: $ROOT_DIR" >&2
  exit 0
fi

mkdir -p "$HOOKS_DEST"

for hook in "$HOOKS_SRC"/*; do
  name=$(basename "$hook")
  [[ "$name" == "install.sh" ]] && continue
  [[ -f "$hook" ]] || continue
  cp "$hook" "$HOOKS_DEST/$name"
  chmod +x "$HOOKS_DEST/$name"
  echo "installed hook: $name"
done
