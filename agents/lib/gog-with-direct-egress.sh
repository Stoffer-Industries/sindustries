#!/usr/bin/env bash

# gog-with-direct-egress.sh — shell shim that routes `gog` through the shared
# proxy-policy wrapper (agents/lib/gog-cli.sh).
#
# Why: `gog` (Google Workspace CLI) is a cgo-enabled Go binary, so macOS
# validates its TLS chain with the platform verifier, which ignores the
# proxy trust bundle the rest of the host uses. Behind the ambient
# secret-egress proxy every `gog` call fails with
#
#   tls: failed to verify certificate: x509: "oauth2.googleapis.com"
#   certificate is not trusted
#
# `gog` uses its own local OAuth tokens and never needs secret-egress
# sentinel injection, so it must not traverse that proxy. This shim makes
# `gog` work from every shell (agent sessions, cron prompts, interactive
# terminals) without each call site remembering to strip the proxy env.
#
# Sourcing: `~/.zshenv` sources this file once for the whole host. It only
# defines a shell function — no side effects, no shell-option mutation, and a
# safe fallback to the real binary if the wrapper is missing.
#
# Deliberately compatible with both bash and zsh, like the sibling
# `gh-with-agent-token.sh`, because macOS loads it from ~/.zshenv.

# Resolved at source time (file scope) so the path survives into the function.
# In bash ${BASH_SOURCE[0]} is the sourced file; in zsh $0 is the sourced
# file when sourced (FUNCTION_ARGZERO, the zsh default).
__gog_shim_source_path="${BASH_SOURCE[0]:-$0}"
__gog_shim_dir="$(cd "$(dirname "${__gog_shim_source_path}")" 2>/dev/null && pwd || true)"

# Returns the path of the shared wrapper, or empty when it cannot be found.
__gog_shim_resolve_wrapper() {
  local candidate
  for candidate in \
    "${__gog_shim_dir}/gog-cli.sh" \
    "${HOME}/.openclaw/workspace/agents/lib/gog-cli.sh"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

# The shim itself. `env` executes a real binary via PATH lookup, so this does
# not recurse into the function even though the function is also named `gog`.
gog() {
  local wrapper
  if wrapper="$(__gog_shim_resolve_wrapper)"; then
    "${wrapper}" "$@"
    return $?
  fi

  # Wrapper missing: fall back to the real binary with the proxy stripped
  # inline, so `gog` still works even before the wrapper is materialised.
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
      -u ALL_PROXY -u all_proxy gog "$@"
  return $?
}

# Export functions only in bash. In zsh, `export -f` prints function bodies to
# stdout instead of exporting them, polluting every shell startup.
#
# `__gog_shim_dir` is exported alongside the functions so a child bash shell
# resolves the sibling wrapper through the same directory the parent used,
# instead of degenerating to the root-absolute `/gog-cli.sh` candidate and
# relying on the `${HOME}/.openclaw/workspace/agents/lib/gog-cli.sh` path
# staying correct.
if [[ -n "${BASH_VERSION:-}" ]]; then
  export __gog_shim_dir
  export -f gog __gog_shim_resolve_wrapper 2>/dev/null || true
fi

# Self-test hook — when invoked as a command (not sourced), print the resolved
# wrapper path and exit 0. This makes the file safely executable in isolation
# and provides a smoke check in production shells.
if [[ -n "${BASH_VERSION:-}" && "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if wrapper_path="$(__gog_shim_resolve_wrapper)"; then
    printf 'wrapper=%s\n' "${wrapper_path}"
  else
    printf 'wrapper=<not-found>\n'
  fi
  exit 0
fi
