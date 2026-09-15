#!/usr/bin/env bash
# rollback.test.sh — AC1 regression guard for infra/cloud/bin/rollback.
#
# Stages a stub `flyctl` and `curl` in PATH and verifies bin/rollback:
#
#   1. Missing service argument fails fast (exit 1).
#   2. Unknown service argument fails fast (exit 1).
#   3. Missing FLY_API_TOKEN fails preflight (exit 2).
#   4. --dry-run prints the rollback command and exits 0 without invoking
#      `flyctl releases rollback`.
#   5. Without TTY and without --yes, the script refuses to roll back
#      (exit 1) — protects against automation that forgot --yes.
#   6. With FLY_API_TOKEN + --yes, the rollback command runs, releases
#      are inspected (current + previous shown), the post-rollback
#      smoke check runs against /health for tasks-api/budget-api, and the
#      worker startup log is greped for auto-post-worker.

set -euo pipefail

# tests/ -> bin/ -> cloud/ -> infra/ -> repo root (4 levels up)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

SCRIPT="$REPO_ROOT/infra/cloud/bin/rollback"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found"; exit 1; }

if ! bash -c 'declare -A FLY_APP_FOR=([x]=y) && echo "${!FLY_APP_FOR[*]}"' >/dev/null 2>&1; then
  echo "FAIL: bash 4+ required (associative arrays)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat >"$TMP/bin/flyctl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: %s\n' "$*" >>"$FLY_LOG"
case "$1" in
  apps)
    case "$2" in
      list) printf '%s' "${FLY_LIST_JSON:-[]}" ;;
    esac ;;
  releases)
    if [[ "$2" == "rollback" ]]; then
      # Real rollback would mutate the running release. Stub exits 0.
      exit 0
    fi
    # `flyctl releases --app <app> --json` returns a list.
    printf '[{"Version":43,"CreatedAt":"2026-09-15T08:30:00Z","Description":"current stub"},{"Version":42,"CreatedAt":"2026-09-15T08:00:00Z","Description":"previous stub"}]'
    ;;
  machines)
    printf '[{"id":"m_stub_1","region":"syd","state":"started","name":"tasks-api"}]'
    ;;
  logs)
    if [[ "${FLY_WORKER_STARTUP:-0}" == "1" ]]; then
      printf '[content-scheduler-worker] starting (adapter=bullmq)\n'
    fi
    exit 0 ;;
  *)
    exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

cat >"$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: curl %s\n' "$*" >>"$FLY_LOG"
exit "${FLY_CURL_EXIT:-0}"
STUB
chmod +x "$TMP/bin/curl"

export FLY_LIST_JSON='[{"Name":"sindustries-tasks-api-staging"},{"Name":"sindustries-budget-api-staging"},{"Name":"sindustries-auto-post-worker-staging"}]'

reset_log() { : >"$TMP/fly.log"; }
assert_eq() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1 — expected [$2], got [$3]" >&2
    exit 1
  fi
}
assert_log_contains() {
  if ! grep -q -- "$1" "$TMP/fly.log"; then
    echo "FAIL: expected log to contain [$1], was:" >&2
    cat "$TMP/fly.log" >&2 || true
    exit 1
  fi
}
assert_log_absent() {
  if grep -q -- "$1" "$TMP/fly.log"; then
    echo "FAIL: expected log to NOT contain [$1], was:" >&2
    cat "$TMP/fly.log" >&2 || true
    exit 1
  fi
}

# ---------- tests ----------------------------------------------------------

echo "test: missing service argument"
reset_log
set +e
PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" 2>&1
rc=$?
set -e
assert_eq "missing service exit code" "1" "$rc"
assert_log_absent "INVOKED: releases rollback"

echo "test: unknown service argument"
reset_log
set +e
PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" not-a-service --yes 2>&1
rc=$?
set -e
assert_eq "unknown service exit code" "1" "$rc"
assert_log_absent "INVOKED: releases rollback"

echo "test: missing FLY_API_TOKEN fails preflight"
reset_log
set +e
unset FLY_API_TOKEN
PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --yes 2>&1
rc=$?
set -e
assert_eq "missing token exit code" "2" "$rc"
assert_log_absent "INVOKED: releases rollback"

echo "test: --dry-run prints rollback command and exits 0"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --dry-run
assert_eq "dry-run exit code" "0" "$?"
assert_log_absent "INVOKED: releases rollback"
assert_log_absent "INVOKED: curl"

echo "test: non-TTY without --yes refuses to roll back"
reset_log
set +e
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api <"$TMP/devnull" 2>&1
rc=$?
set -e
# The script checks `[[ ! -t 0 ]]` (stdin is not a TTY because of the redirect)
# and refuses with exit 1.
assert_eq "non-tty without --yes exit code" "1" "$rc"
assert_log_absent "INVOKED: releases rollback"

echo "test: --yes runs the rollback for tasks-api with smoke check"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --yes
assert_eq "tasks-api rollback exit code" "0" "$?"
assert_log_contains "INVOKED: apps list --json"
assert_log_contains "INVOKED: releases --app sindustries-tasks-api-staging --json"
assert_log_contains "INVOKED: releases rollback --app sindustries-tasks-api-staging"
assert_log_contains "INVOKED: curl"

echo "test: --to-version is forwarded to releases rollback"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" budget-api --yes --to-version 41
assert_eq "budget-api rollback exit code" "0" "$?"
assert_log_contains "INVOKED: releases rollback --app sindustries-budget-api-staging --to-version 41"

echo "test: auto-post-worker uses the log-tail smoke check, not curl"
reset_log
FLY_API_TOKEN=stub FLY_WORKER_STARTUP=1 PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" auto-post-worker --yes
assert_eq "worker rollback exit code" "0" "$?"
assert_log_contains "INVOKED: releases rollback --app sindustries-auto-post-worker-staging"
assert_log_contains "INVOKED: logs --app sindustries-auto-post-worker-staging --no-tail"
assert_log_absent "INVOKED: curl"

echo
echo "OK — all bin/rollback tests passed"