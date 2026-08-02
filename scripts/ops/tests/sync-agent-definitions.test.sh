#!/usr/bin/env bash
set -euo pipefail
SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sync-agent-definitions.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_WORKSPACE_ROOT="$TMP/workspace"
export OPENCLAW_AGENT_DEFS_BACKUP_ROOT="$TMP/backups"
export OPENCLAW_AGENT_DEFS_LOCK_DIR="$TMP/lock"
mkdir -p "$OPENCLAW_WORKSPACE_ROOT/agents/rowan"
printf 'keep me\n' > "$OPENCLAW_WORKSPACE_ROOT/AGENTS.md"
printf 'old soul\n' > "$OPENCLAW_WORKSPACE_ROOT/agents/rowan/SOUL.md"

"$SCRIPT" >/dev/null
cmp <(git -C "$(cd "$(dirname "$SCRIPT")/../.." && pwd)" show origin/main:agents/definitions/rowan/SOUL.md) "$OPENCLAW_WORKSPACE_ROOT/agents/rowan/SOUL.md"
[[ "$(cat "$OPENCLAW_WORKSPACE_ROOT/AGENTS.md")" == "keep me" ]]
backup=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -path '*/rowan/SOUL.md' -type f -print -quit)
[[ -n "$backup" ]]
[[ "$(cat "$backup")" == "old soul" ]]

before=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
"$SCRIPT" >/dev/null
after=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
[[ "$before" == "$after" ]]
echo "sync-agent-definitions: ok"
