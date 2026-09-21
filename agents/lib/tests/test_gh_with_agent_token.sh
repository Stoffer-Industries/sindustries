#!/usr/bin/env bash
# Regression guard for agents/lib/gh-with-agent-token.sh (task b0d1b42e,
# AC1 + AC2). Stage a stub `gh` binary on PATH that records argv and the
# environment the shim passed, then assert that:
#
#   1. The shim is a no-op for Quinn and Lox (no allow-list entry).
#   2. The shim unsets `GITHUB_TOKEN` / `GH_TOKEN` for an allowed agent.
#   3. The shim exports `GH_CONFIG_DIR=~/.config/gh-<agent>` and
#      `GH_TOKEN=$<AGENT>_GITHUB_TOKEN` for an allowed agent.
#   4. When the per-agent token env var is unset, the shim still unsets the
#      bare ambient vars before falling back to `command gh` (AC2 graceful
#      degradation).
#   5. `GH_SHIM_AGENT` explicit override beats `AGENT_ID`.
#
# The test runs under `bash` only; `python3` is not required. Stub `gh`
# records argv + env to a temp log so the assertions can read what the shim
# actually forwarded.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
SHIM="${REPO_ROOT}/agents/lib/gh-with-agent-token.sh"

if [[ ! -f "${SHIM}" ]]; then
  echo "FAIL: shim not found at ${SHIM}" >&2
  exit 1
fi

TMPDIR_TEST="$(mktemp -d -t gh-shim-test.XXXXXX)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

STUB_DIR="${TMPDIR_TEST}/bin"
LOG_FILE="${TMPDIR_TEST}/gh.log"
mkdir -p "${STUB_DIR}"

# Build the stub `gh`. It records its argv (one per line) and a snapshot of
# the relevant environment variables to LOG_FILE, then exits 0.
cat >"${STUB_DIR}/gh" <<'STUB'
#!/usr/bin/env bash
emit_argv() {
  local first=1 a
  printf 'argv:'
  for a in "$@"; do
    if [[ ${first} -eq 1 ]]; then
      printf ' %s' "${a}"
      first=0
    else
      printf '|%s' "${a}"
    fi
  done
  printf '\n'
}
emit_argv "$@"
printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN-<unset>}"
printf 'GH_TOKEN=%s\n' "${GH_TOKEN-<unset>}"
printf 'GH_CONFIG_DIR=%s\n' "${GH_CONFIG_DIR-<unset>}"
exit 0
STUB
chmod +x "${STUB_DIR}/gh"

# Helpers --------------------------------------------------------------------

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

pass() {
  echo "ok $1"
}

# Runs the shim under a controlled env. Sources the shim (so the `gh` shell
# function is defined) then invokes `gh <args>`, capturing the stub's log.
run_shim() {
  : >"${LOG_FILE}"
  unset -f gh gh-with-agent-token 2>/dev/null || true

  (
    # Minimal PATH so the stub is the only `gh` on PATH. The shim still calls
    # `command gh`, which resolves via PATH.
    export PATH="${STUB_DIR}:/usr/bin:/bin"
    export HOME="${TMPDIR_TEST}/agent-home"
    mkdir -p "${HOME}"
    # Apply caller-supplied env (PATH, agent identity, token vars, ambient
    # overrides).
    for kv in "$@"; do
      export "${kv?}"
    done
    # Source the shim with a clean function table so prior cases do not leak.
    source "${SHIM}"
    # Invoke the wrapper.
    gh api user --jq .login
  ) >"${LOG_FILE}" 2>&1
}

assert_log_contains() {
  local needle="$1"
  if ! grep -qF -- "${needle}" "${LOG_FILE}"; then
    echo "=== captured log ===" >&2
    cat "${LOG_FILE}" >&2 || true
    echo "=== end log ===" >&2
    echo "expected log to contain: ${needle}" >&2
    fail "assertion failed"
  fi
}

assert_log_not_contains() {
  local needle="$1"
  if grep -qF -- "${needle}" "${LOG_FILE}"; then
    echo "=== captured log ===" >&2
    cat "${LOG_FILE}" >&2 || true
    echo "=== end log ===" >&2
    echo "expected log NOT to contain: ${needle}" >&2
    fail "assertion failed"
  fi
}

# Case 1: Quinn (not in allow-list) — bare GITHUB_TOKEN passes through.
run_shim \
  "GH_SHIM_AGENT=quinn" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "QUINN_GITHUB_TOKEN=ghp_quinn_ambient"
assert_log_contains 'GITHUB_TOKEN=ghp_quinn_ambient'
assert_log_contains 'GH_CONFIG_DIR=<unset>'
pass "quinn: ambient GITHUB_TOKEN preserved (no-op for non-allow-listed agent)"

# Case 2: Lox (not in allow-list) — same passthrough behaviour.
run_shim \
  "GH_SHIM_AGENT=lox" \
  "GITHUB_TOKEN=ghp_lox_ambient"
assert_log_contains 'GITHUB_TOKEN=ghp_lox_ambient'
assert_log_contains 'GH_CONFIG_DIR=<unset>'
pass "lox: ambient GITHUB_TOKEN preserved (no-op for non-allow-listed agent)"

# Case 3: Rowan with per-agent token — shim unsets ambient and sets
# GH_CONFIG_DIR + GH_TOKEN to the rowan-scoped values (AC1 + AC2).
run_shim \
  "GH_SHIM_AGENT=rowan" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "GH_TOKEN=ghp_quinn_ambient_via_legacy" \
  "ROWAN_GITHUB_TOKEN=ghp_rowan_scoped"
assert_log_not_contains 'GITHUB_TOKEN=ghp_quinn_ambient'
assert_log_not_contains 'GH_TOKEN=ghp_quinn_ambient_via_legacy'
assert_log_contains 'GITHUB_TOKEN=<unset>'
assert_log_contains 'GH_TOKEN=ghp_rowan_scoped'
assert_log_contains "GH_CONFIG_DIR=${TMPDIR_TEST}/agent-home/.config/gh-rowan"
pass "rowan: ambient vars unset, GH_TOKEN set to ROWAN_GITHUB_TOKEN, GH_CONFIG_DIR scoped"

# Case 4: Ash with per-agent token — same shape as Rowan, different identity.
run_shim \
  "GH_SHIM_AGENT=ash" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "ASH_GITHUB_TOKEN=ghp_ash_scoped"
assert_log_not_contains 'GITHUB_TOKEN=ghp_quinn_ambient'
assert_log_contains 'GITHUB_TOKEN=<unset>'
assert_log_contains 'GH_TOKEN=ghp_ash_scoped'
assert_log_contains "GH_CONFIG_DIR=${TMPDIR_TEST}/agent-home/.config/gh-ash"
pass "ash: scoped identity applied (AC1 cross-agent)"

# Case 5: Ivy with per-agent token.
run_shim \
  "GH_SHIM_AGENT=ivy" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "IVY_GITHUB_TOKEN=ghp_ivy_scoped"
assert_log_not_contains 'GITHUB_TOKEN=ghp_quinn_ambient'
assert_log_contains 'GH_TOKEN=ghp_ivy_scoped'
assert_log_contains "GH_CONFIG_DIR=${TMPDIR_TEST}/agent-home/.config/gh-ivy"
pass "ivy: scoped identity applied (AC1 cross-agent)"

# Case 6: Rowan but ROWAN_GITHUB_TOKEN is unset (gateway hasn't propagated it
# yet). Shim must still unset the ambient vars — fallback to `command gh`
# without leaking Quinn's identity (AC2 graceful degradation).
run_shim \
  "GH_SHIM_AGENT=rowan" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "GH_TOKEN=ghp_legacy_quinn"
# Both ambient vars must be unset even though no per-agent token was found.
assert_log_contains 'GITHUB_TOKEN=<unset>'
assert_log_contains 'GH_TOKEN=<unset>'
assert_log_contains 'GH_CONFIG_DIR=<unset>'
pass "rowan without token: ambient vars unset, no GH_CONFIG_DIR (fallback path)"

# Case 7: GH_SHIM_AGENT overrides AGENT_ID (explicit override beats env).
run_shim \
  "GH_SHIM_AGENT=ash" \
  "AGENT_ID=rowan" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "ASH_GITHUB_TOKEN=ghp_ash_scoped"
assert_log_contains 'GH_TOKEN=ghp_ash_scoped'
assert_log_contains "GH_CONFIG_DIR=${TMPDIR_TEST}/agent-home/.config/gh-ash"
assert_log_not_contains 'GH_TOKEN=ghp_rowan'
pass "GH_SHIM_AGENT override beats AGENT_ID"

# Case 8: Agent identity unresolved but ambient GITHUB_TOKEN is set — shim
# passes through to `command gh` AND warns to stderr (AC3 observability).
unset -f gh gh-with-agent-token 2>/dev/null || true
STDOUT_FILE="${TMPDIR_TEST}/stdout"
STDERR_FILE="${TMPDIR_TEST}/stderr"
: >"${STDOUT_FILE}"
: >"${STDERR_FILE}"
(
  export PATH="${STUB_DIR}:/usr/bin:/bin"
  export HOME="${TMPDIR_TEST}/agent-home"
  export GITHUB_TOKEN=ghp_quinn_ambient
  unset GH_SHIM_AGENT AGENT_ID
  source "${SHIM}"
  gh api user --jq .login
) >"${STDOUT_FILE}" 2>"${STDERR_FILE}" || true
# The ambient var passes through (no agent to enforce scoping for).
if ! grep -qF 'GITHUB_TOKEN=ghp_quinn_ambient' "${STDOUT_FILE}"; then
  cat "${STDOUT_FILE}" >&2 || true
  fail "unresolved identity: ambient GITHUB_TOKEN should pass through unchanged"
fi
# And the warn-once line must appear on stderr exactly once per process.
if ! grep -qF 'gh-with-agent-token: ambient GITHUB_TOKEN/GH_TOKEN present but agent identity unresolved' "${STDERR_FILE}"; then
  echo "=== stderr ===" >&2
  cat "${STDERR_FILE}" >&2 || true
  fail "unresolved identity: expected one-line stderr warning"
fi
pass "unresolved identity: passthrough + stderr warning (AC3 observability)"

# Case 9: argv passes through verbatim after the shim wraps. The stub records
# argv as `argv: api|user|--jq|.login` (first arg separated by space, the
# rest by `|`) — make sure that exact ordering is preserved end-to-end.
run_shim \
  "GH_SHIM_AGENT=rowan" \
  "GITHUB_TOKEN=ghp_quinn_ambient" \
  "ROWAN_GITHUB_TOKEN=ghp_rowan_scoped"
assert_log_contains 'argv: api|user|--jq|.login'
pass "argv passes through unchanged"

echo
echo "All gh-with-agent-token.sh tests passed."
