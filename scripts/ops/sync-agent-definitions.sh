#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKSPACE_ROOT=${OPENCLAW_WORKSPACE_ROOT:-"$HOME/.openclaw/workspace"}
BACKUP_ROOT=${OPENCLAW_AGENT_DEFS_BACKUP_ROOT:-"$HOME/.openclaw/backups/agent-definitions"}
LOCK_DIR=${OPENCLAW_AGENT_DEFS_LOCK_DIR:-"${TMPDIR:-/tmp}/openclaw-agent-definitions-sync.lock"}
SOURCE_ROOT=agents/definitions
AGENTS=(quinn rowan lox ivy)

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "agent-definitions sync already running; skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

git -C "$REPO_ROOT" fetch --quiet origin main

backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_dir="$BACKUP_ROOT/$backup_stamp"
changed=0

for agent in "${AGENTS[@]}"; do
  source_dir="$SOURCE_ROOT/$agent"
  if ! git -C "$REPO_ROOT" cat-file -e "origin/main:$source_dir" 2>/dev/null; then
    echo "missing source directory on origin/main: $source_dir" >&2
    exit 1
  fi

  if [[ "$agent" == quinn ]]; then
    destination_dir="$WORKSPACE_ROOT"
  else
    destination_dir="$WORKSPACE_ROOT/agents/$agent"
  fi
  mkdir -p "$destination_dir"

  while IFS= read -r source_path; do
    filename=${source_path##*/}
    [[ "$filename" == "AGENTS.md" ]] && continue
    destination="$destination_dir/$filename"
    staged=$(mktemp "${TMPDIR:-/tmp}/agent-definition.XXXXXX")
    git -C "$REPO_ROOT" show "origin/main:$source_path" > "$staged"

    if [[ -f "$destination" ]] && cmp -s "$staged" "$destination"; then
      rm -f "$staged"
      continue
    fi

    if [[ -e "$destination" ]]; then
      mkdir -p "$backup_dir/$agent"
      cp -p "$destination" "$backup_dir/$agent/$filename"
    fi
    install -m 0644 "$staged" "$destination"
    rm -f "$staged"
    echo "synced $source_path -> $destination"
    changed=$((changed + 1))
  done < <(git -C "$REPO_ROOT" ls-tree -r --name-only origin/main -- "$source_dir" | grep -E '\.md$')
done

echo "agent-definitions sync complete: $changed file(s) changed"
if [[ -d "$backup_dir" ]]; then
  echo "backups: $backup_dir"
fi
