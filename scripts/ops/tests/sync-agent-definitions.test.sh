#!/usr/bin/env bash
set -euo pipefail
SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sync-agent-definitions.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_WORKSPACE_ROOT="$TMP/workspace"
export OPENCLAW_AGENT_DEFS_BACKUP_ROOT="$TMP/backups"
export OPENCLAW_AGENT_DEFS_LOCK_DIR="$TMP/lock"
export OPENCLAW_AGENT_DEFS_SOURCE_REF="WORKTREE"
mkdir -p "$OPENCLAW_WORKSPACE_ROOT/agents/rowan" "$OPENCLAW_WORKSPACE_ROOT/agents/vara" "$OPENCLAW_WORKSPACE_ROOT/agents/ash"
printf 'keep me\n' > "$OPENCLAW_WORKSPACE_ROOT/AGENTS.md"
printf 'old soul\n' > "$OPENCLAW_WORKSPACE_ROOT/agents/rowan/SOUL.md"
printf 'old workflow\n' > "$OPENCLAW_WORKSPACE_ROOT/agents/vara/WORKFLOW.md"

"$SCRIPT" >/dev/null
repo_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
cmp "$repo_root/agents/definitions/rowan/SOUL.md" "$OPENCLAW_WORKSPACE_ROOT/agents/rowan/SOUL.md"
cmp "$repo_root/agents/definitions/vara/WORKFLOW.md" "$OPENCLAW_WORKSPACE_ROOT/agents/vara/WORKFLOW.md"
cmp "$repo_root/agents/definitions/ash/WORKFLOW.md" "$OPENCLAW_WORKSPACE_ROOT/agents/ash/WORKFLOW.md"
cmp "$repo_root/agents/definitions/ash/HEARTBEAT.md" "$OPENCLAW_WORKSPACE_ROOT/agents/ash/HEARTBEAT.md"
[[ "$(cat "$OPENCLAW_WORKSPACE_ROOT/AGENTS.md")" == "keep me" ]]
[[ -f "$OPENCLAW_WORKSPACE_ROOT/agents/vara/AGENTS.md" ]]
[[ -f "$OPENCLAW_WORKSPACE_ROOT/agents/ash/AGENTS.md" ]]
[[ "$(cat "$OPENCLAW_WORKSPACE_ROOT/agents/vara/AGENTS.md")" == "keep me" ]]
backup=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -path '*/rowan/SOUL.md' -type f -print -quit)
[[ -n "$backup" ]]
[[ "$(cat "$backup")" == "old soul" ]]
vara_backup=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -path '*/vara/WORKFLOW.md' -type f -print -quit)
[[ -n "$vara_backup" ]]
[[ "$(cat "$vara_backup")" == "old workflow" ]]

before=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
"$SCRIPT" >/dev/null
after=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
[[ "$before" == "$after" ]]
echo "sync-agent-definitions: ok"
