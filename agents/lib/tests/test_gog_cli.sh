#!/usr/bin/env bash
# Regression guard for agents/lib/gog-cli.sh and
# agents/lib/gog-with-direct-egress.sh (2026-10-26).
#
# Background: `gog` (Google Workspace CLI) is a cgo-enabled Go binary, so on
# macOS it validates TLS with the platform verifier (Security.framework). That
# verifier ignores SSL_CERT_FILE / CURL_CA_BUNDLE / NODE_EXTRA_CA_CERTS — the
# proxy trust bundle every other client on this host uses — and the secret
# egress proxy's root CA is not installed in any macOS keychain. Behind the
# ambient HTTP_PROXY/HTTPS_PROXY, every `gog` call therefore failed at the
# OAuth token refresh with:
#
#   tls: failed to verify certificate: x509: "oauth2.googleapis.com"
#   certificate is not trusted
#
# The fix routes `gog` through a wrapper that strips the ambient proxy, since
# `gog` authenticates with local OAuth tokens and never needs secret-egress
# sentinel injection.
#
# This harness stages a stub `gog` on PATH that records its argv and the
# environment it received, then asserts:
#
#   1. The wrapper `gog-cli.sh` unsets HTTP_PROXY / HTTPS_PROXY / http_proxy /
#      https_proxy / ALL_PROXY / all_proxy in the child environment.
#   2. The wrapper forwards argv unchanged and preserves unrelated env.
#   3. The sourceable shim defines a `gog` function that produces the same
#      proxy-free child environment (bash).
#   4. The production zsh sourcing path (as used by ~/.zshenv) behaves
#      identically (zsh).
#   5. The shim falls back to a proxy-free inline invocation when the shared
#      wrapper cannot be found.
#   6. The shim does not leak output into a sourcing shell.
#
# Runs under bash and includes a production-parity zsh subprocess. `python3`
# is not required.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
WRAPPER="${REPO_ROOT}/agents/lib/gog-cli.sh"
SHIM="${REPO_ROOT}/agents/lib/gog-with-direct-egress.sh"

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

pass() {
  echo "  ok: $*"
}

for required in "${WRAPPER}" "${SHIM}"; do
  if [[ ! -f "${required}" ]]; then
    echo "FAIL: missing required file: ${required}" >&2
    exit 1
  fi
done

TMPDIR_TEST="$(mktemp -d -t gog-proxy-test.XXXXXX)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

STUB_DIR="${TMPDIR_TEST}/bin"
LOG_FILE="${TMPDIR_TEST}/gog.log"
mkdir -p "${STUB_DIR}"

# Build the stub `gog`. It records its argv (one per line) and a snapshot of
# the environment variables under test to LOG_FILE, then exits 0.
cat >"${STUB_DIR}/gog" <<'STUB'
#!/usr/bin/env bash
{
  echo "--- invocation ---"
  for arg in "$@"; do
    echo "arg:${arg}"
  done
  echo "HTTP_PROXY=${HTTP_PROXY-<unset>}"
  echo "HTTPS_PROXY=${HTTPS_PROXY-<unset>}"
  echo "http_proxy=${http_proxy-<unset>}"
  echo "https_proxy=${https_proxy-<unset>}"
  echo "ALL_PROXY=${ALL_PROXY-<unset>}"
  echo "all_proxy=${all_proxy-<unset>}"
  echo "NO_PROXY=${NO_PROXY-<unset>}"
  echo "GOG_PRESERVE_ME=${GOG_PRESERVE_ME-<unset>}"
  echo "PATH=${PATH}"
} >>"${GOG_STUB_LOG}"
exit 0
STUB
chmod +x "${STUB_DIR}/gog"

# Assert that no proxy variable leaked into the recorded environment.
# The stub prints the literal sentinel `<unset>` when a variable is absent, so
# both an empty value and that sentinel count as "not leaked".
assert_proxy_free() {
  local log_file="$1" context="$2" var value
  for var in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; do
    value="$(sed -n "s/^${var}=//p" "${log_file}" | tail -1)"
    if [[ -z "${value}" || "${value}" == "<unset>" ]]; then
      pass "${context}: ${var} unset in child environment"
    else
      fail "${context}: ${var} leaked into child environment (value='${value}')"
    fi
  done
}

# ---------------------------------------------------------------------------
# 1 + 2. The wrapper strips the proxy and forwards argv / unrelated env.
# ---------------------------------------------------------------------------
echo "== wrapper: gog-cli.sh =="
: >"${LOG_FILE}"
PATH="${STUB_DIR}:${PATH}" \
GOG_STUB_LOG="${LOG_FILE}" \
GOG_PRESERVE_ME="keep-me" \
HTTP_PROXY="http://proxy.invalid:3128" \
HTTPS_PROXY="http://proxy.invalid:3128" \
http_proxy="http://proxy.invalid:3128" \
https_proxy="http://proxy.invalid:3128" \
ALL_PROXY="http://proxy.invalid:3128" \
all_proxy="http://proxy.invalid:3128" \
  bash "${WRAPPER}" calendar list --account someone@example.com --all \
  >/dev/null

assert_proxy_free "${LOG_FILE}" "wrapper"

if grep -q '^arg:calendar$' "${LOG_FILE}" &&
   grep -q '^arg:--account$' "${LOG_FILE}" &&
   grep -q '^arg:someone@example.com$' "${LOG_FILE}" &&
   grep -q '^arg:--all$' "${LOG_FILE}"; then
  pass "wrapper: argv forwarded unchanged"
else
  fail "wrapper: argv not forwarded unchanged"
fi

if grep -q '^GOG_PRESERVE_ME=keep-me$' "${LOG_FILE}"; then
  pass "wrapper: unrelated env preserved"
else
  fail "wrapper: unrelated env was dropped"
fi

# ---------------------------------------------------------------------------
# 3. The sourceable shim defines gog() and produces a proxy-free child.
# ---------------------------------------------------------------------------
echo "== shim: bash =="
: >"${LOG_FILE}"
PATH="${STUB_DIR}:${PATH}" \
GOG_STUB_LOG="${LOG_FILE}" \
HTTP_PROXY="http://proxy.invalid:3128" \
HTTPS_PROXY="http://proxy.invalid:3128" \
http_proxy="http://proxy.invalid:3128" \
https_proxy="http://proxy.invalid:3128" \
ALL_PROXY="http://proxy.invalid:3128" \
all_proxy="http://proxy.invalid:3128" \
  bash -c "source '${SHIM}'; gog calendar list --from 2026-01-01" >/dev/null

assert_proxy_free "${LOG_FILE}" "shim/bash"

if grep -q '^arg:--from$' "${LOG_FILE}" && grep -q '^arg:2026-01-01$' "${LOG_FILE}"; then
  pass "shim/bash: argv forwarded unchanged"
else
  fail "shim/bash: argv not forwarded unchanged"
fi

# ---------------------------------------------------------------------------
# 4. Production-parity zsh sourcing path (~/.zshenv sources the shim).
# ---------------------------------------------------------------------------
echo "== shim: zsh (production parity) =="
if command -v zsh >/dev/null 2>&1; then
  : >"${LOG_FILE}"
  PATH="${STUB_DIR}:${PATH}" \
  GOG_STUB_LOG="${LOG_FILE}" \
  HTTP_PROXY="http://proxy.invalid:3128" \
  HTTPS_PROXY="http://proxy.invalid:3128" \
  http_proxy="http://proxy.invalid:3128" \
  https_proxy="http://proxy.invalid:3128" \
  ALL_PROXY="http://proxy.invalid:3128" \
  all_proxy="http://proxy.invalid:3128" \
    zsh -c "source '${SHIM}'; gog gmail search 'newer_than:1d'" >/dev/null

  assert_proxy_free "${LOG_FILE}" "shim/zsh"

  if grep -q '^arg:gmail$' "${LOG_FILE}" && grep -q '^arg:search$' "${LOG_FILE}"; then
    pass "shim/zsh: argv forwarded unchanged"
  else
    fail "shim/zsh: argv not forwarded unchanged"
  fi
else
  echo "  skip: zsh not available"
fi

# ---------------------------------------------------------------------------
# 5. Fallback when the shared wrapper cannot be found.
# ---------------------------------------------------------------------------
echo "== shim: missing-wrapper fallback =="
: >"${LOG_FILE}"
PATH="${STUB_DIR}:${PATH}" \
GOG_STUB_LOG="${LOG_FILE}" \
HTTP_PROXY="http://proxy.invalid:3128" \
HTTPS_PROXY="http://proxy.invalid:3128" \
http_proxy="http://proxy.invalid:3128" \
https_proxy="http://proxy.invalid:3128" \
ALL_PROXY="http://proxy.invalid:3128" \
all_proxy="http://proxy.invalid:3128" \
  bash -c "HOME='${TMPDIR_TEST}'; unset __gog_shim_dir; __gog_shim_dir=''; source '${SHIM}'; gog drive search 'x'" >/dev/null

assert_proxy_free "${LOG_FILE}" "shim/fallback"

# ---------------------------------------------------------------------------
# 6. Sourcing the shim must not print anything to the sourcing shell.
# ---------------------------------------------------------------------------
echo "== shim: silent on source =="
source_output="$(bash -c "source '${SHIM}'" 2>&1)"
if [[ -z "${source_output}" ]]; then
  pass "shim: sourcing is silent"
else
  fail "shim: sourcing produced output: ${source_output}"
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  echo "PASS: all gog proxy-bypass assertions held"
  exit 0
fi
echo "FAILURES: ${failures}" >&2
exit 1
