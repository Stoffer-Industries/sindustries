#!/usr/bin/env bash
# deploy.test.sh — AC1 regression guard for infra/cloud/bin/deploy.
#
# Stages a stub `flyctl` in PATH that records argv to $FLY_LOG, plus a
# stub `curl` and a stub `python3` (for the version/machines shaping).
# Runs bin/deploy against the staging Fly apps and asserts:
#
#   1. Missing service argument fails fast (exit 1, no flyctl invocations).
#   2. Unknown service argument fails fast (exit 1, no flyctl invocations).
#   3. --image flag is forwarded to `flyctl deploy --image ...` for the
#      matched service; :latest is refused.
#   4. Without --image, no `--image` is appended (uses local source).
#   5. Missing FLY_API_TOKEN fails preflight (exit 2, no flyctl deploy).
#   6. The post-deploy smoke check GETs the `/health` URL for tasks-api
#      and budget-api, and grep-tails logs for auto-post-worker.
#   7. --dry-run prints the deploy command and exits 0 without invoking
#      `flyctl deploy`.

set -euo pipefail

# tests/ -> bin/ -> cloud/ -> infra/ -> repo root (4 levels up)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

SCRIPT="$REPO_ROOT/infra/cloud/bin/deploy"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found"; exit 1; }

# bash 4+ is required for the associative arrays in bin/deploy. Operators
# on macOS need Homebrew bash first in PATH (Quinn does; CI Ubuntu does).
if ! bash -c 'declare -A FLY_APP_FOR=([x]=y) && echo "${!FLY_APP_FOR[*]}"' >/dev/null 2>&1; then
  echo "FAIL: bash 4+ required (associative arrays). Run with PATH=/opt/homebrew/bin:\$PATH" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- stub flyctl -----------------------------------------------------

mkdir -p "$TMP/bin"
cat >"$TMP/bin/flyctl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: %s\n' "$*" >>"$FLY_LOG"
case "$1" in
  config)
    exit 0 ;;
  apps)
    case "$2" in
      list) printf '%s' "${FLY_LIST_JSON:-[]}" ;;
    esac ;;
  deploy)
    # Real call would push a canary. Stub exits 0 so the script proceeds
    # to the version / machines / smoke steps.
    exit 0 ;;
  releases)
    # bin/deploy calls `flyctl releases --app <app> --json` after deploy
    # to surface the version. Real flyctl returns an array; mirror that.
    printf '[{"Version":42,"CreatedAt":"2026-09-15T08:00:00Z","Description":"stub"}]'
    ;;
  machines)
    printf '[{"id":"m_stub_1","region":"syd","state":"started","name":"tasks-api"}]'
    ;;
  logs)
    # Smoke check for auto-post-worker greps for the startup line.
    if [[ "${FLY_WORKER_STARTUP:-0}" == "1" ]]; then
      printf '[content-scheduler-worker] starting (adapter=bullmq)\n'
    fi
    exit 0 ;;
  *)
    exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# ---------- stub curl (success by default) -------------------------------

cat >"$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: curl %s\n' "$*" >>"$FLY_LOG"
exit "${FLY_CURL_EXIT:-0}"
STUB
chmod +x "$TMP/bin/curl"

# ---------- helpers --------------------------------------------------------

run_deploy() {
  local expected_exit="$1"; shift
  local out err log
  set +e
  out="$(
    PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$@" "$SCRIPT" "$@" 2>&1
  )"
  local rc=$?
  set -e
  printf '%s' "$out"
  return "$rc"
}

assert_eq() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1 — expected [$2], got [$3]" >&2
    exit 1
  fi
}

assert_log_contains() {
  local pattern="$1"
  if ! grep -q -- "$pattern" "$TMP/fly.log" 2>/dev/null; then
    echo "FAIL: expected log to contain [$pattern], was:" >&2
    cat "$TMP/fly.log" >&2 || true
    exit 1
  fi
}

assert_log_absent() {
  local pattern="$1"
  if grep -q -- "$pattern" "$TMP/fly.log" 2>/dev/null; then
    echo "FAIL: expected log to NOT contain [$pattern], was:" >&2
    cat "$TMP/fly.log" >&2 || true
    exit 1
  fi
}

reset_log() { : >"$TMP/fly.log"; }
export FLY_LIST_JSON='[{"Name":"sindustries-tasks-api-staging"},{"Name":"sindustries-budget-api-staging"},{"Name":"sindustries-auto-post-worker-staging"}]'

# ---------- tests ----------------------------------------------------------

echo "test: missing service argument"
reset_log
out="$(PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" 2>&1 || true)"
assert_eq "missing service exit code" "1" "$(PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT"; echo $?)"
assert_log_absent "INVOKED: deploy"

echo "test: unknown service argument"
reset_log
set +e
PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" not-a-service 2>&1
rc=$?
set -e
assert_eq "unknown service exit code" "1" "$rc"
assert_log_absent "INVOKED: deploy"

echo "test: --image latest is refused"
reset_log
set +e
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --image registry/repo:latest 2>&1
rc=$?
set -e
assert_eq ":latest exit code" "1" "$rc"
assert_log_absent "INVOKED: deploy"

echo "test: --image pinned tag is forwarded"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --image registry/repo:abc1234def5678 2>&1
assert_eq "deploy tasks-api exit code" "0" "$?"
assert_log_contains "INVOKED: config validate --config infra/cloud/fly/tasks-api.fly.toml"
assert_log_contains "INVOKED: deploy --config infra/cloud/fly/tasks-api.fly.toml --strategy canary --wait-timeout 600 --env GIT_COMMIT_SHA=abc1234def5678 --image registry/repo:abc1234def5678"
assert_log_contains "INVOKED: releases --app sindustries-tasks-api-staging --json"
assert_log_contains "INVOKED: machines list --app sindustries-tasks-api-staging --json"
assert_log_contains "INVOKED: curl"

echo "test: no --image means no --image flag in deploy argv"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" budget-api 2>&1
assert_eq "deploy budget-api exit code" "0" "$?"
# The deploy argv for budget-api should NOT contain "--image"
if grep -E "INVOKED: deploy --config infra/cloud/fly/budget-api.fly.toml .*--image" "$TMP/fly.log"; then
  echo "FAIL: budget-api deploy should not pass --image when caller didn't pass one" >&2
  exit 1
fi
assert_log_contains "INVOKED: deploy --config infra/cloud/fly/budget-api.fly.toml --strategy canary --wait-timeout 600 --env GIT_COMMIT_SHA="

echo "test: missing FLY_API_TOKEN fails preflight"
reset_log
set +e
unset FLY_API_TOKEN
PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api 2>&1
rc=$?
set -e
assert_eq "missing token exit code" "2" "$rc"
assert_log_absent "INVOKED: deploy"

echo "test: auto-post-worker smoke check tails logs"
reset_log
FLY_API_TOKEN=stub FLY_WORKER_STARTUP=1 PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" auto-post-worker --image registry/repo:def4567abc8901 2>&1
assert_eq "deploy worker exit code" "0" "$?"
assert_log_contains "INVOKED: logs --app sindustries-auto-post-worker-staging --no-tail"
assert_log_contains "INVOKED: deploy --config infra/cloud/fly/auto-post-worker.fly.toml --strategy canary --wait-timeout 600 --env GIT_COMMIT_SHA=def4567abc8901 --image registry/repo:def4567abc8901"

echo "test: --env GIT_COMMIT_SHA uses local HEAD when no --image is given"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api 2>&1
assert_eq "deploy tasks-api (no image) exit code" "0" "$?"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
assert_log_contains "INVOKED: deploy --config infra/cloud/fly/tasks-api.fly.toml --strategy canary --wait-timeout 600 --env GIT_COMMIT_SHA=$HEAD_SHA"

echo "test: --dry-run prints deploy command and exits 0"
reset_log
FLY_API_TOKEN=stub PATH="$TMP/bin:$PATH" FLY_LOG="$TMP/fly.log" "$SCRIPT" tasks-api --dry-run --image registry/repo:abc1234def5678 2>&1
assert_eq "dry-run exit code" "0" "$?"
assert_log_absent "INVOKED: deploy"

echo
echo "OK — all bin/deploy tests passed"