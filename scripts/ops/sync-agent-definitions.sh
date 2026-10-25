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
# affected agent's shell. The wrapper resolves identity from OpenClaw/Codex
# runtime context; snippets must not export a global AGENT_ID. Quinn and Lox
# are intentionally absent — see the shim's allow-list header.
SHIM_SOURCE_RELPATH=agents/lib/gh-with-agent-token.sh
GH_WRAPPER_SOURCE_RELPATH=agents/lib/github-cli.sh
# Google Workspace CLI (`gog`) proxy shim (2026-10-26). `gog` is a cgo-enabled
# Go binary, so macOS validates its TLS chain with the platform verifier,
# which ignores the proxy trust bundle every other client on this host uses.
# Behind the ambient secret-egress proxy every `gog` call fails at the OAuth
# token refresh with:
#   tls: failed to verify certificate: x509: "oauth2.googleapis.com"
#   certificate is not trusted
# `gog` authenticates with local OAuth tokens and never needs secret-egress
# sentinel injection, so it must not traverse that proxy. Both files are
# materialised beside the GitHub equivalents so a single ~/.zshenv source line
# fixes `gog` for every agent session and cron job.
GOG_WRAPPER_SOURCE_RELPATH=agents/lib/gog-cli.sh
GOG_SHIM_SOURCE_RELPATH=agents/lib/gog-with-direct-egress.sh
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
# it is sourced into the shell. It resolves identity from session-scoped
# runtime context (`OPENCLAW_AGENT_ID`, `CODEX_HOME`, or legacy `AGENT_ID`).
# Without sourcing, the ambient `GITHUB_TOKEN` keeps overriding each agent's
# `GH_CONFIG_DIR` identity (see retro pattern
# `ambient-gh-token-overrides-profile`).
#
# This block:
#   1. Materialises the shim at `$WORKSPACE_ROOT/agents/lib/gh-with-agent-token.sh`
#      so it lives at a stable path inside the workspace (idempotent cmp).
#   2. Emits a per-agent `.gh-shim.sh` next to the agent's TOOLS.md that
#      sources the shim without mutating global session identity.
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

# The shim delegates all proxy and ambient-token policy to the shared wrapper.
# Keep the executable beside the materialised shim in agent workspaces.
wrapper_staged=$(mktemp "${TMPDIR:-/tmp}/agent-gh-wrapper.XXXXXX")
wrapper_installed=0
if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
  if [[ ! -f "$REPO_ROOT/$GH_WRAPPER_SOURCE_RELPATH" ]]; then
    echo "missing GitHub wrapper source in worktree: $GH_WRAPPER_SOURCE_RELPATH" >&2
    rm -f "$wrapper_staged"
    exit 1
  fi
  cat "$REPO_ROOT/$GH_WRAPPER_SOURCE_RELPATH" > "$wrapper_staged"
else
  if ! git -C "$REPO_ROOT" cat-file -e "$SOURCE_REF:$GH_WRAPPER_SOURCE_RELPATH" 2>/dev/null; then
    echo "missing GitHub wrapper source on $SOURCE_REF: $GH_WRAPPER_SOURCE_RELPATH" >&2
    rm -f "$wrapper_staged"
    exit 1
  fi
  git -C "$REPO_ROOT" show "$SOURCE_REF:$GH_WRAPPER_SOURCE_RELPATH" > "$wrapper_staged"
fi

wrapper_destination="$SHIM_DEST_DIR/github-cli.sh"
if [[ ! -L "$wrapper_destination" && -f "$wrapper_destination" ]] && cmp -s "$wrapper_staged" "$wrapper_destination"; then
  :
else
  if [[ -e "$wrapper_destination" || -L "$wrapper_destination" ]]; then
    mkdir -p "$backup_dir/lib"
    cp -pL "$wrapper_destination" "$backup_dir/lib/github-cli.sh"
    rm -f "$wrapper_destination"
  fi
  install -m 0755 "$wrapper_staged" "$wrapper_destination"
  echo "synced $GH_WRAPPER_SOURCE_RELPATH -> $wrapper_destination"
  wrapper_installed=1
fi
rm -f "$wrapper_staged"

# ---------------------------------------------------------------------------
# Google Workspace CLI (`gog`) proxy shim wiring (2026-10-26).
#
# This block:
#   1. Materialises the shared wrapper at `$WORKSPACE_ROOT/agents/lib/gog-cli.sh`
#      so all proxy policy for `gog` lives in exactly one file (same contract as
#      `github-cli.sh`).
#   2. Materialises the sourceable shim at
#      `$WORKSPACE_ROOT/agents/lib/gog-with-direct-egress.sh`, which defines the
#      `gog` shell function.
#
# Host-side wiring (Lox, .openclaw boundary): add one line to ~/.zshenv:
#   [[ -f "$HOME/.openclaw/workspace/agents/lib/gog-with-direct-egress.sh" ]] && source "$HOME/.openclaw/workspace/agents/lib/gog-with-direct-egress.sh"
# ---------------------------------------------------------------------------

gog_sync_installed=0
for gog_entry in \
  "${GOG_WRAPPER_SOURCE_RELPATH}:gog-cli.sh:0755" \
  "${GOG_SHIM_SOURCE_RELPATH}:gog-with-direct-egress.sh:0755"; do
  gog_relpath="${gog_entry%%:*}"
  gog_rest="${gog_entry#*:}"
  gog_destname="${gog_rest%%:*}"
  gog_mode="${gog_rest#*:}"
  gog_destination="$SHIM_DEST_DIR/$gog_destname"

  gog_staged=$(mktemp "${TMPDIR:-/tmp}/agent-gog-shim.XXXXXX")
  # Unlike the GitHub shim block above, a missing source here must NOT abort
  # the whole sync: this block is additive, and the agent-definition
  # materialisation that follows is the critical path. Skip with a warning so
  # an older ref (or another worktree) cannot stop AGENTS.md syncing.
  gog_source_ok=1
  if [[ "$SOURCE_REF" == "WORKTREE" ]]; then
    if [[ ! -f "$REPO_ROOT/$gog_relpath" ]]; then
      echo "skipping gog shim (source missing in worktree): $gog_relpath" >&2
      gog_source_ok=0
    else
      cat "$REPO_ROOT/$gog_relpath" > "$gog_staged"
    fi
  else
    if ! git -C "$REPO_ROOT" cat-file -e "$SOURCE_REF:$gog_relpath" 2>/dev/null; then
      echo "skipping gog shim (source missing on $SOURCE_REF): $gog_relpath" >&2
      gog_source_ok=0
    else
      git -C "$REPO_ROOT" show "$SOURCE_REF:$gog_relpath" > "$gog_staged"
    fi
  fi
  if [[ "$gog_source_ok" -eq 0 ]]; then
    rm -f "$gog_staged"
    continue
  fi

  if [[ ! -L "$gog_destination" && -f "$gog_destination" ]] && cmp -s "$gog_staged" "$gog_destination"; then
    :
  else
    if [[ -e "$gog_destination" || -L "$gog_destination" ]]; then
      mkdir -p "$backup_dir/lib"
      cp -pL "$gog_destination" "$backup_dir/lib/$gog_destname"
      rm -f "$gog_destination"
    fi
    install -m "$gog_mode" "$gog_staged" "$gog_destination"
    echo "synced $gog_relpath -> $gog_destination"
    gog_sync_installed=1
  fi
  rm -f "$gog_staged"
done

if [[ "$gog_sync_installed" -ne 0 ]]; then
  echo "gog shim wiring refreshed — verify host-side sourcing in ~/.zshenv"
fi

for shim_agent in "${SHIM_AGENTS[@]}"; do
  shim_snippet="$WORKSPACE_ROOT/agents/$shim_agent/.gh-shim.sh"
  shim_snippet_body="# Auto-generated by sync-agent-definitions.sh (task b0d1b42e).
# Sources the per-agent GitHub CLI shim.
# The shim wraps every \`gh\` invocation so the ambient GITHUB_TOKEN from
# ~/.openclaw/.env no longer silently authenticates as a different agent.
# Agent identity is resolved at call time from OpenClaw/Codex session context.
# Do not export AGENT_ID here: ~/.zshenv is shared by every local agent, so
# sourcing multiple agent snippets would make the last export win globally.
#
# Host-side wiring (Quinn-routed, .openclaw boundary): add a single line
# to ~/.zshenv that sources this file:
#   [[ -f \"\$HOME/.openclaw/workspace/agents/$shim_agent/.gh-shim.sh\" ]] && source \"\$HOME/.openclaw/workspace/agents/$shim_agent/.gh-shim.sh\"
source \"\$HOME/.openclaw/workspace/agents/lib/gh-with-agent-token.sh\"
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

if [[ "$shim_installed" -ne 0 || "$wrapper_installed" -ne 0 ]]; then
  echo "shim wiring refreshed — verify host-side sourcing (see [openclaw-needed] task comment)"
fi
