#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=${SINDUSTRIES_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
WORKSPACE_ROOT=${OPENCLAW_WORKSPACE_ROOT:-"$HOME/.openclaw/workspace"}
BACKUP_ROOT=${OPENCLAW_AGENT_DEFS_BACKUP_ROOT:-"$HOME/.openclaw/backups/agent-definitions"}
LOCK_DIR=${OPENCLAW_AGENT_DEFS_LOCK_DIR:-"${TMPDIR:-/tmp}/openclaw-agent-definitions-sync.lock"}
SOURCE_ROOT=agents/definitions
SOURCE_REF=${OPENCLAW_AGENT_DEFS_SOURCE_REF:-origin/main}
AGENTS=(quinn rowan lox ivy vara ash)
# Per-agent GitHub CLI shim (task b0d1b42e). The shim lives in the repo
# (`agents/lib/gh-with-agent-token.sh`) and needs to be sourced from each
# affected agent's shell with `AGENT_ID` set so the wrapper resolves the
# per-agent token. Quinn and Lox are intentionally absent — see the shim's
# allow-list header.
SHIM_SOURCE_RELPATH=agents/lib/gh-with-agent-token.sh
SHIM_AGENTS=(rowan ash ivy)
SHIM_DEST_DIR="$WORKSPACE_ROOT/agents/lib"
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

# ---------------------------------------------------------------------------
# Per-agent GitHub CLI shim wiring (task b0d1b42e).
#
# The shim at `agents/lib/gh-with-agent-token.sh` (PR #718) is a no-op until
# it is sourced from a shell that has `AGENT_ID` (or `GH_SHIM_AGENT`) set.
# Without sourcing, the ambient `GITHUB_TOKEN` keeps overriding each agent's
# `GH_CONFIG_DIR` identity (see retro pattern
# `ambient-gh-token-overrides-profile`).
#
# This block:
#   1. Materialises the shim at `$WORKSPACE_ROOT/agents/lib/gh-with-agent-token.sh`
#      so it lives at a stable path inside the workspace (idempotent cmp).
#   2. Emits a per-agent `.gh-shim.sh` next to the agent's TOOLS.md that
#      pins `AGENT_ID=<agent>` and sources the shim.
#
# Quinn/Lox still need to add ONE line to `~/.zshenv` (or equivalent user
# shell init) to actually source the per-agent snippet — that host-side
# wiring is out of Rowan's `.openclaw` boundary and is tracked separately
# via `[openclaw-needed]` task comments.
# ---------------------------------------------------------------------------

shim_staged=$(mktemp "${TMPDIR:-/tmp}/agent-shim.XXXXXX")
shim_installed=0
if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
  if [[ ! -f "$REPO_ROOT/$SHIM_SOURCE_RELPATH" ]]; then
    echo "missing shim source in worktree: $SHIM_SOURCE_RELPATH" >&2
    rm -f "$shim_staged"
    exit 1
  fi
  cat "$REPO_ROOT/$SHIM_SOURCE_RELPATH" > "$shim_staged"
else
  if ! git -C "$REPO_ROOT" cat-file -e "$SOURCE_REF:$SHIM_SOURCE_RELPATH" 2>/dev/null; then
    echo "missing shim source on $SOURCE_REF: $SHIM_SOURCE_RELPATH" >&2
    rm -f "$shim_staged"
    exit 1
  fi
  git -C "$REPO_ROOT" show "$SOURCE_REF:$SHIM_SOURCE_RELPATH" > "$shim_staged"
fi

mkdir -p "$SHIM_DEST_DIR"
shim_destination="$SHIM_DEST_DIR/gh-with-agent-token.sh"
if [[ ! -L "$shim_destination" && -f "$shim_destination" ]] && cmp -s "$shim_staged" "$shim_destination"; then
  :
else
  if [[ -e "$shim_destination" || -L "$shim_destination" ]]; then
    mkdir -p "$backup_dir/lib"
    cp -pL "$shim_destination" "$backup_dir/lib/gh-with-agent-token.sh"
    rm -f "$shim_destination"
  fi
  install -m 0755 "$shim_staged" "$shim_destination"
  echo "synced $SHIM_SOURCE_RELPATH -> $shim_destination"
  shim_installed=1
fi
rm -f "$shim_staged"

for shim_agent in "${SHIM_AGENTS[@]}"; do
  shim_snippet="$WORKSPACE_ROOT/agents/$shim_agent/.gh-shim.sh"
  shim_snippet_body="# Auto-generated by sync-agent-definitions.sh (task b0d1b42e).
# Sources the per-agent GitHub CLI shim with AGENT_ID pinned to this agent.
# The shim wraps every \`gh\` invocation so the ambient GITHUB_TOKEN from
# ~/.openclaw/.env no longer silently authenticates as a different agent.
# Sourcing is idempotent — the shim guards itself against re-stacking.
# Host-side wiring (Quinn-routed, .openclaw boundary): add a single line
# to ~/.zshenv that sources this file:
#   [[ -f \"\$HOME/.openclaw/workspace/agents/$shim_agent/.gh-shim.sh\" ]] && source \"\$HOME/.openclaw/workspace/agents/$shim_agent/.gh-shim.sh\"
AGENT_ID=\"$shim_agent\" source \"\$HOME/.openclaw/workspace/agents/lib/gh-with-agent-token.sh\"
"
  shim_staged_snippet=$(mktemp "${TMPDIR:-/tmp}/agent-shim-snippet.XXXXXX")
  printf '%s' "$shim_snippet_body" > "$shim_staged_snippet"
  if [[ ! -L "$shim_snippet" && -f "$shim_snippet" ]] && cmp -s "$shim_staged_snippet" "$shim_snippet"; then
    rm -f "$shim_staged_snippet"
    continue
  fi
  if [[ -e "$shim_snippet" || -L "$shim_snippet" ]]; then
    mkdir -p "$backup_dir/snippets"
    cp -pL "$shim_snippet" "$backup_dir/snippets/$shim_agent.gh-shim.sh"
    rm -f "$shim_snippet"
  fi
  install -m 0644 "$shim_staged_snippet" "$shim_snippet"
  rm -f "$shim_staged_snippet"
  echo "emitted $shim_snippet"
  shim_installed=1
done

if [[ "$shim_installed" -ne 0 ]]; then
  echo "shim wiring refreshed — verify host-side sourcing (see [openclaw-needed] task comment)"
fi
