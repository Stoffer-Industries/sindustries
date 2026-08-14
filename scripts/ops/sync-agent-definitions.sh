#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=${SINDUSTRIES_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
WORKSPACE_ROOT=${OPENCLAW_WORKSPACE_ROOT:-"$HOME/.openclaw/workspace"}
BACKUP_ROOT=${OPENCLAW_AGENT_DEFS_BACKUP_ROOT:-"$HOME/.openclaw/backups/agent-definitions"}
LOCK_DIR=${OPENCLAW_AGENT_DEFS_LOCK_DIR:-"${TMPDIR:-/tmp}/openclaw-agent-definitions-sync.lock"}
SOURCE_ROOT=agents/definitions
SOURCE_REF=${OPENCLAW_AGENT_DEFS_SOURCE_REF:-origin/main}
AGENTS=(quinn rowan lox ivy vara)
# Non-quinn agents also need the canonical AGENTS.md copied from the
# workspace root into their own workspace dir. It is not sourced from
# agents/definitions/<agent>/ (it is shared, not per-agent) and previously
# relied on a workspace-repo-tracked symlink, which is fragile (see
# workspace PR #60 — symlinks get reasserted by any git restore/checkout).
WORKSPACE_AGENTS_MD="$WORKSPACE_ROOT/AGENTS.md"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "agent-definitions sync already running; skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ "$SOURCE_REF" != "WORKTREE" && ( "$SOURCE_REF" == origin/* || "$SOURCE_REF" == */* ) ]]; then
  git -C "$REPO_ROOT" fetch --quiet origin main
fi

backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_dir="$BACKUP_ROOT/$backup_stamp"
changed=0

for agent in "${AGENTS[@]}"; do
  source_dir="$SOURCE_ROOT/$agent"
  if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
    if [[ ! -d "$REPO_ROOT/$source_dir" ]]; then
      echo "missing source directory in worktree: $source_dir" >&2
      exit 1
    fi
  else
    if ! git -C "$REPO_ROOT" cat-file -e "$SOURCE_REF:$source_dir" 2>/dev/null; then
      echo "missing source directory on $SOURCE_REF: $source_dir" >&2
      exit 1
    fi
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
    if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
      cat "$REPO_ROOT/$source_path" > "$staged"
    else
      git -C "$REPO_ROOT" show "$SOURCE_REF:$source_path" > "$staged"
    fi

    # A symlink is never an acceptable runtime destination. OpenClaw's
    # bootstrap security boundary can reject a definition that resolves
    # outside the agent workspace, even when its contents match origin/main.
    # Materialise symlinks as regular files instead of treating cmp as a
    # no-op.
    if [[ ! -L "$destination" && -f "$destination" ]] && cmp -s "$staged" "$destination"; then
      rm -f "$staged"
      continue
    fi

    if [[ -e "$destination" || -L "$destination" ]]; then
      mkdir -p "$backup_dir/$agent"
      cp -pL "$destination" "$backup_dir/$agent/$filename"
      rm -f "$destination"
    fi
    install -m 0644 "$staged" "$destination"
    rm -f "$staged"
    echo "synced $source_path -> $destination"
    changed=$((changed + 1))
  done < <(
    if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
      find "$REPO_ROOT/$source_dir" -type f -name '*.md' | sed "s#^$REPO_ROOT/##" | sort
    else
      git -C "$REPO_ROOT" ls-tree -r --name-only "$SOURCE_REF" -- "$source_dir" | grep -E '\.md$'
    fi
  )

  # AGENTS.md: canonical copy lives at the workspace root and is shared
  # across all agents (not agent-specific, so it is not part of
  # agents/definitions/<agent>/ on origin/main). Copy it into every
  # non-quinn agent's workspace dir here so it can never silently go
  # missing or drift to a stale copy.
  if [[ "$agent" != quinn && -f "$WORKSPACE_AGENTS_MD" ]]; then
    agents_destination="$destination_dir/AGENTS.md"
    if [[ ! -L "$agents_destination" && -f "$agents_destination" ]] && cmp -s "$WORKSPACE_AGENTS_MD" "$agents_destination"; then
      :
    else
      if [[ -e "$agents_destination" || -L "$agents_destination" ]]; then
        mkdir -p "$backup_dir/$agent"
        cp -pL "$agents_destination" "$backup_dir/$agent/AGENTS.md"
        rm -f "$agents_destination"
      fi
      install -m 0644 "$WORKSPACE_AGENTS_MD" "$agents_destination"
      echo "synced $WORKSPACE_AGENTS_MD -> $agents_destination"
      changed=$((changed + 1))
    fi
  fi
done

echo "agent-definitions sync complete: $changed file(s) changed"
if [[ -d "$backup_dir" ]]; then
  echo "backups: $backup_dir"
fi
