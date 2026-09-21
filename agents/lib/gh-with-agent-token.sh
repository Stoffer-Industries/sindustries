#!/usr/bin/env bash
# gh-with-agent-token.sh — per-agent GitHub CLI shim (task b0d1b42e).
#
# Problem: a bare `GITHUB_TOKEN` exported from `~/.openclaw/.env` silently
# overrides an agent's per-agent `GH_CONFIG_DIR` identity because `gh`'s
# credential-resolution order treats env vars as authoritative. The five most
# recent occurrences (2026-09-08 / 09-10 / 09-10 / 09-12 / 09-12 / 09-13) all
# needed close+reopen or an explicit `unset GITHUB_TOKEN GH_TOKEN` workaround.
# Pattern-slug: `ambient-gh-token-overrides-profile`.
#
# This shim wraps `gh` so each agent's `gh` invocation authenticates as that
# agent's own identity by (a) unsetting the bare `GITHUB_TOKEN` / `GH_TOKEN`
# in the child environment, (b) scoping `GH_CONFIG_DIR` to the agent, and
# (c) re-exporting the per-agent token as `GH_TOKEN` (which is preferred over
# `GITHUB_TOKEN` by `gh` and is exactly what the agent's TOOLS.md documents).
#
# Quinn and Lox are NOT in the agent allow-list — the shim is a no-op for them
# because their documented write-op convention (`GITHUB_TOKEN=$QUINN_GITHUB_TOKEN
# gh ...`) depends on the ambient `GITHUB_TOKEN` being authoritative.
#
# Sourcing: each agent's session-init sources this file. Sourcing is idempotent
# — repeated source calls do not stack wrapper functions. Tests live at
# `agents/lib/tests/test_gh_with_agent_token.sh` and run under bash with a
# stubbed `gh` binary on PATH.

set -euo pipefail

# Allow-list of agents whose `gh` calls this shim re-scopes. Quinn and Lox
# are intentionally absent — see the file header comment.
__GH_SHIM_AGENTS=(rowan ash ivy)

# Detect the calling agent. Resolution order:
#   1. `GH_SHIM_AGENT` env var (explicit override; tests use this).
#   2. `AGENT_ID` env var (set by OpenClaw session-init when available).
#   3. argv[0] basename when the script is invoked as a wrapper.
# Returns empty when no agent can be resolved — callers fall through to
# `command gh` unchanged.
__gh_shim_resolve_agent() {
  if [[ -n "${GH_SHIM_AGENT:-}" ]]; then
    printf '%s\n' "${GH_SHIM_AGENT}"
    return 0
  fi
  if [[ -n "${AGENT_ID:-}" ]]; then
    printf '%s\n' "${AGENT_ID}"
    return 0
  fi
  return 1
}

# Returns success when the resolved agent is in the allow-list.
__gh_shim_agent_allowed() {
  local agent
  agent="$(__gh_shim_resolve_agent || true)"
  if [[ -z "${agent}" ]]; then
    return 1
  fi
  local allowed
  for allowed in "${__GH_SHIM_AGENTS[@]}"; do
    if [[ "${agent}" == "${allowed}" ]]; then
      return 0
    fi
  done
  return 1
}

# Warn once per process when an override is in effect but the agent identity
# could not be resolved — surfaces unexpected ambient `GITHUB_TOKEN` overrides
# so the structural regression is observable (backing AC3 of task b0d1b42e).
__gh_shim_warn_unresolved() {
  if [[ -z "${__GH_SHIM_WARNED:-}" ]] && [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
    printf 'gh-with-agent-token: ambient GITHUB_TOKEN/GH_TOKEN present but agent identity unresolved; passing through to command gh\n' >&2
    __GH_SHIM_WARNED=1
  fi
}

# The wrapper itself. Invoked as `gh <args...>` after the function below is
# exported by sourcing.
gh() {
  if ! __gh_shim_agent_allowed; then
    __gh_shim_warn_unresolved
    command gh "$@"
    return $?
  fi

  local agent
  agent="$(__gh_shim_resolve_agent)"
  local -r agent_upper="$(printf '%s' "${agent}" | tr '[:lower:]' '[:upper:]')"
  local -r token_var="${agent_upper}_GITHUB_TOKEN"
  local -r token_value="${!token_var:-}"

  if [[ -z "${token_value}" ]]; then
    # Per-agent token missing — fall back to `command gh` after `unset
    # GITHUB_TOKEN GH_TOKEN` so the user still does not silently authenticate
    # as the wrong identity (matches the documented manual workaround).
    env -u GITHUB_TOKEN -u GH_TOKEN command gh "$@"
    return $?
  fi

  env -u GITHUB_TOKEN -u GH_TOKEN \
      GH_CONFIG_DIR="${HOME}/.config/gh-${agent}" \
      GH_TOKEN="${token_value}" \
      command gh "$@"
}

# Direct alias — scripts that need to bypass the function (e.g. to escape a
# wrapper for a single call) can use `command gh-with-agent-token` or call
# this alias directly via `gh-with-agent-token`.
gh-with-agent-token() {
  gh "$@"
}

# Export the functions so they survive subshell boundaries (cron jobs, helper
# scripts that re-exec `bash -c`). Without `export -f`, the function is only
# visible inside the sourcing shell.
export -f gh gh-with-agent-token 2>/dev/null || true
export -f __gh_shim_resolve_agent __gh_shim_agent_allowed __gh_shim_warn_unresolved 2>/dev/null || true

# Self-test hook — when `gh-with-agent-token.sh` is invoked as a command (not
# sourced), print the resolved agent and exit 0. This makes the file safely
# executable in isolation and provides a smoke check in production shells.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if agent="$(__gh_shim_resolve_agent 2>/dev/null)"; then
    printf 'agent=%s allowed=%s\n' "${agent}" "$(__gh_shim_agent_allowed && echo yes || echo no)"
  else
    printf 'agent=<unresolved> allowed=no\n'
  fi
  exit 0
fi
