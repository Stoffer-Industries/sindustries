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
# Sourcing: each agent's session-init sources this file. The implementation is
# deliberately compatible with both bash and zsh because macOS loads it from
# ~/.zshenv. It must not mutate the caller's shell options. Tests live at
# `agents/lib/tests/test_gh_with_agent_token.sh` with a stubbed `gh` on PATH.

# Allow-list of agents whose `gh` calls this shim re-scopes. Quinn and Lox
# are intentionally absent — see the file header comment.
# Detect the calling agent. Resolution order:
#   1. `GH_SHIM_AGENT` env var (explicit override; tests use this).
#   2. `OPENCLAW_AGENT_ID` when the runtime exposes it directly.
#   3. The agent segment in Codex's per-agent `CODEX_HOME`.
#   4. `AGENT_ID` as a legacy fallback.
# Returns empty when no agent can be resolved — callers fall through to
# `command gh` unchanged.
__gh_shim_resolve_agent() {
  if [[ -n "${GH_SHIM_AGENT:-}" ]]; then
    printf '%s\n' "${GH_SHIM_AGENT}"
    return 0
  fi
  if [[ -n "${OPENCLAW_AGENT_ID:-}" ]]; then
    printf '%s\n' "${OPENCLAW_AGENT_ID}"
    return 0
  fi
  if [[ -n "${CODEX_HOME:-}" ]]; then
    case "${CODEX_HOME}" in
      */.openclaw/agents/*/agent/codex-home*)
        local codex_agent="${CODEX_HOME#*/.openclaw/agents/}"
        codex_agent="${codex_agent%%/*}"
        if [[ -n "${codex_agent}" ]]; then
          printf '%s\n' "${codex_agent}"
          return 0
        fi
        ;;
    esac
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
  case "${agent}" in
    rowan|ash|ivy) return 0 ;;
    *) return 1 ;;
  esac
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
  # `printenv` is portable across bash and zsh. Bash's `${!name}` indirect
  # expansion aborts in zsh with "bad substitution".
  local token_value
  token_value="$(command printenv "${token_var}" 2>/dev/null || true)"

  if [[ -z "${token_value}" ]]; then
    # Per-agent token missing — unset ambient token overrides but keep the
    # resolved agent's config directory. This lets `gh` use that profile's
    # own keyring credential instead of silently falling through to the host's
    # default Quinn profile. `env` runs the target in a fresh subprocess, so
    # there is no function table to bypass — call `gh` directly, not the bash
    # builtin `command` (which is not an executable on Linux).
    env -u GITHUB_TOKEN -u GH_TOKEN \
        GH_CONFIG_DIR="${HOME}/.config/gh-${agent}" \
        gh "$@"
    return $?
  fi

  env -u GITHUB_TOKEN -u GH_TOKEN \
      GH_CONFIG_DIR="${HOME}/.config/gh-${agent}" \
      GH_TOKEN="${token_value}" \
      gh "$@"
}

# Direct alias — scripts that need to bypass the function (e.g. to escape a
# wrapper for a single call) can use `command gh-with-agent-token` or call
# this alias directly via `gh-with-agent-token`.
gh-with-agent-token() {
  gh "$@"
}

# Export functions only in bash. In zsh, `export -f` prints function bodies to
# stdout instead of exporting them, polluting every shell startup.
if [[ -n "${BASH_VERSION:-}" ]]; then
  export -f gh gh-with-agent-token 2>/dev/null || true
  export -f __gh_shim_resolve_agent __gh_shim_agent_allowed __gh_shim_warn_unresolved 2>/dev/null || true
fi

# Self-test hook — when `gh-with-agent-token.sh` is invoked as a command (not
# sourced), print the resolved agent and exit 0. This makes the file safely
# executable in isolation and provides a smoke check in production shells.
if [[ -n "${BASH_VERSION:-}" && "${BASH_SOURCE:-}" == "${0}" ]]; then
  if agent="$(__gh_shim_resolve_agent 2>/dev/null)"; then
    printf 'agent=%s allowed=%s\n' "${agent}" "$(__gh_shim_agent_allowed && echo yes || echo no)"
  else
    printf 'agent=<unresolved> allowed=no\n'
  fi
  exit 0
fi
