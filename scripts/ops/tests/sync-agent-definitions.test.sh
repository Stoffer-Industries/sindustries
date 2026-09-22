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

# Per-agent GitHub CLI shim wiring (task b0d1b42e). The script must:
#   1. Materialise the shim at $OPENCLAW_WORKSPACE_ROOT/agents/lib/gh-with-agent-token.sh
#      matching the repo source (file mode 0755).
#   2. Emit .gh-shim.sh snippets for each allow-listed agent (rowan, ash,
#      ivy) that source the shim without mutating global AGENT_ID. Quinn and
#      Lox snippets must NOT be emitted.
#   3. Treat re-runs as no-ops when source and destination byte-match (the
#      backup count stays unchanged across reruns).
shim_dest="$OPENCLAW_WORKSPACE_ROOT/agents/lib/gh-with-agent-token.sh"
[[ -f "$shim_dest" ]]
cmp "$repo_root/agents/lib/gh-with-agent-token.sh" "$shim_dest"
[[ "$(stat -f '%Lp' "$shim_dest")" == "755" ]]

for shim_agent in rowan ash ivy; do
  snippet="$OPENCLAW_WORKSPACE_ROOT/agents/$shim_agent/.gh-shim.sh"
  [[ -f "$snippet" ]]
  # ~/.zshenv is shared across local agents and may source every emitted
  # snippet. None may overwrite another session's identity.
  if grep -nE '^[[:space:]]*(export[[:space:]]+)?AGENT_ID=' "$snippet" >/dev/null; then
    echo "FAIL: $snippet mutates global AGENT_ID" >&2
    exit 1
  fi
  grep -F '$HOME/.openclaw/workspace/agents/lib/gh-with-agent-token.sh' "$snippet" >/dev/null
done

[[ ! -f "$OPENCLAW_WORKSPACE_ROOT/agents/quinn/.gh-shim.sh" ]]
[[ ! -f "$OPENCLAW_WORKSPACE_ROOT/agents/lox/.gh-shim.sh" ]]
[[ ! -f "$OPENCLAW_WORKSPACE_ROOT/agents/vara/.gh-shim.sh" ]]

before_shim=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
"$SCRIPT" >/dev/null
after_shim=$(find "$OPENCLAW_AGENT_DEFS_BACKUP_ROOT" -type f | wc -l | tr -d ' ')
[[ "$before_shim" == "$after_shim" ]]

# Regression guard: sourcing every emitted snippet, as the shared host
# ~/.zshenv does, must not change a session-scoped identity.
emitted_snippet="$OPENCLAW_WORKSPACE_ROOT/agents/rowan/.gh-shim.sh"
AGENT_ID_AFTER=$(AGENT_ID=rowan bash -c "source '$OPENCLAW_WORKSPACE_ROOT/agents/rowan/.gh-shim.sh'; source '$OPENCLAW_WORKSPACE_ROOT/agents/ash/.gh-shim.sh'; source '$OPENCLAW_WORKSPACE_ROOT/agents/ivy/.gh-shim.sh'; printf '%s' \"\${AGENT_ID-<unset>}\"")
if [[ "$AGENT_ID_AFTER" != "rowan" ]]; then
  echo "FAIL: sourcing emitted snippets changed AGENT_ID" >&2
  echo "      got: '$AGENT_ID_AFTER' (expected: 'rowan')" >&2
  exit 1
fi
# Also confirm the wrapper is registered as a shell function (not the
# system binary), so a future `gh` invocation in the same shell will go
# through the shim.
WRAPPER_KIND=$(bash -c "source '$emitted_snippet'; type gh" | head -1)
if [[ "$WRAPPER_KIND" != "gh is a function" && "$WRAPPER_KIND" != "gh is a shell function"* ]]; then
  echo "FAIL: sourcing $emitted_snippet did not register gh as a shell function" >&2
  echo "      got: '$WRAPPER_KIND'" >&2
  exit 1
fi

# Functional check: sourcing the snippet with HOME pointed at the test
# workspace must wrap `gh` so that calling `gh pr view` (a stubbed no-op
# binary) records the expected env. We point HOME at a tmp dir, then
# rewrite the snippet path in-place to match the absolute test path —
# verifying the wrapper wiring works end-to-end without depending on the
# user's actual ~/.openclaw/workspace.
TMP_SHIM_HOME="$TMP/shim-home"
mkdir -p "$TMP_SHIM_HOME/.openclaw/workspace/agents/lib"
cp "$repo_root/agents/lib/gh-with-agent-token.sh" "$TMP_SHIM_HOME/.openclaw/workspace/agents/lib/gh-with-agent-token.sh"
SHIM_STUB_DIR="$TMP_SHIM_HOME/bin"
mkdir -p "$SHIM_STUB_DIR"
cat >"$SHIM_STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf 'argv=%s\n' "$*"
printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN:-<unset>}"
printf 'GH_TOKEN=%s\n' "${GH_TOKEN:-<unset>}"
printf 'GH_CONFIG_DIR=%s\n' "${GH_CONFIG_DIR:-<unset>}"
STUB
chmod +x "$SHIM_STUB_DIR/gh"
TMP_SNIPPET="$TMP_SHIM_HOME/snip.sh"
cat >"$TMP_SNIPPET" <<EOF
export PATH="$SHIM_STUB_DIR:\$PATH"
export CODEX_HOME="$TMP_SHIM_HOME/.openclaw/agents/rowan/agent/codex-home"
source "$TMP_SHIM_HOME/.openclaw/workspace/agents/lib/gh-with-agent-token.sh"
EOF
# Fallback path: when the per-agent token env var is unset, the shim must
# still unset GITHUB_TOKEN/GH_TOKEN before exec'ing `gh` (AC2 graceful
# degradation). GH_CONFIG_DIR is intentionally not set in this branch.
out=$(bash -c 'source "$1"; gh pr view 1' _ "$TMP_SNIPPET")
printf '%s\n' "$out" | grep -q '^argv=pr view 1$'
printf '%s\n' "$out" | grep -q '^GITHUB_TOKEN=<unset>$'
printf '%s\n' "$out" | grep -q '^GH_TOKEN=<unset>$'
printf '%s\n' "$out" | grep -q '^GH_CONFIG_DIR=<unset>$'
# Full shim path: when ROWAN_GITHUB_TOKEN is set, the shim must rewrite
# GITHUB_TOKEN=unset, GH_TOKEN=$ROWAN_GITHUB_TOKEN, GH_CONFIG_DIR=$HOME/.config/gh-rowan.
out_with_token=$(env -i HOME="$TMP_SHIM_HOME" PATH="$SHIM_STUB_DIR:/usr/bin:/bin" ROWAN_GITHUB_TOKEN="ghp_rowan_test_token" bash -c 'source "$1"; gh pr view 1' _ "$TMP_SNIPPET")
printf '%s\n' "$out_with_token" | grep -q '^argv=pr view 1$'
printf '%s\n' "$out_with_token" | grep -q '^GITHUB_TOKEN=<unset>$'
printf '%s\n' "$out_with_token" | grep -q '^GH_TOKEN=ghp_rowan_test_token$'
printf '%s\n' "$out_with_token" | grep -q "^GH_CONFIG_DIR=$TMP_SHIM_HOME/.config/gh-rowan$"

echo "sync-agent-definitions: ok"
