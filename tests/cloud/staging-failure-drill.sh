#!/usr/bin/env bash
# staging-failure-drill.sh
#
# AC3 black-box failure / recovery drill for the cloud staging
# environment (task 2850c5ac, docs/specs/cloud-staging-environment-tech-design.md
# section 4). Walks the worker-failure → alert → recovery path against
# the live staging topology and emits a JSON result matching
# tests/cloud/staging-validation.schema.json.
#
# This drill intentionally stops exactly one Content Scheduler worker
# instance (never Postgres, never Redis). It refuses to run unless:
#   - provider environment label equals "staging"
#   - DATABASE_URL or REDIS_URL substrings look staging, not production
#   - FLY_API_TOKEN is present in the caller environment
#   - the operator passed --confirm-staging on the command line
#
# Out of scope (this script):
#   - database or Redis destructive faults — those are reserved for the
#     dedicated migration/restore task
#   - Postgres or Redis process control — drill is worker-only
#
# Inputs (flags or env):
#   --fly-org <name>           STAGING_FLY_ORG              required
#   --fly-app-worker <name>    STAGING_FLY_APP_WORKER       required
#   --scheduler-api-url <url>  STAGING_SCHEDULER_API_URL    required
#   --scheduler-token <bearer> STAGING_SCHEDULER_TOKEN      required
#   --observability-url <url>  STAGING_OBSERVABILITY_URL    optional (for alert correlation)
#   --run-id <id>              STAGING_RUN_ID               optional
#   --intent-commit <sha>      STAGING_INTENT_COMMIT        optional
#   --output <path>            write JSON result here        optional (stdout by default)
#   --confirm-staging          required ack; refuses otherwise
#   --max-duration-seconds N   hard cap, default 600
#
# Exit codes:
#   0  verdict=pass
#   1  verdict=fail (drill steps failed or alert did not fire/resolve)
#   2  harness/config error
#   130 SIGINT
#   143 SIGTERM

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# bash 4+ is required for associative arrays used by infra/cloud/bin/*.
if ! bash -c 'declare -A X=([y]=1)' >/dev/null 2>&1; then
  echo "FAIL: bash 4+ required (associative arrays). Run with PATH=/opt/homebrew/bin:\$PATH" >&2
  exit 2
fi

SCHEMA_VERSION=1
PRODUCTION_DENY_SUBSTRINGS=(
  "sindustries-content-scheduler-api"           # production Fly app substring
  "content-scheduler-prod"
  "content-scheduler-production"
)
RUN_TAG_PREFIX="staging-drill"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

fly_org=""
fly_app_worker=""
scheduler_api_url=""
scheduler_token=""
observability_url=""
run_id=""
intent_commit=""
output_path=""
confirm_staging=0
max_duration_seconds=600

print_help() {
  cat <<'HELP'
Usage: staging-failure-drill.sh [flags]

Required:
  --fly-org <name>            STAGING_FLY_ORG
  --fly-app-worker <name>     STAGING_FLY_APP_WORKER
  --scheduler-api-url <url>   STAGING_SCHEDULER_API_URL
  --scheduler-token <bearer>  STAGING_SCHEDULER_TOKEN
  --confirm-staging           acknowledges this script targets staging only

Optional:
  --observability-url <url>   STAGING_OBSERVABILITY_URL (alert correlation)
  --run-id <id>               STAGING_RUN_ID (default timestamp+random)
  --intent-commit <sha>       STAGING_INTENT_COMMIT
  --output <path>             write JSON result here (stdout by default)
  --max-duration-seconds N    hard cap, default 600

Emits JSON matching tests/cloud/staging-validation.schema.json.
Exit 0 pass, 1 fail, 2 harness/config error.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fly-org)            fly_org="${2:-}"; shift 2 ;;
    --fly-app-worker)     fly_app_worker="${2:-}"; shift 2 ;;
    --scheduler-api-url)  scheduler_api_url="${2:-}"; shift 2 ;;
    --scheduler-token)    scheduler_token="${2:-}"; shift 2 ;;
    --observability-url)  observability_url="${2:-}"; shift 2 ;;
    --run-id)             run_id="${2:-}"; shift 2 ;;
    --intent-commit)      intent_commit="${2:-}"; shift 2 ;;
    --output)             output_path="${2:-}"; shift 2 ;;
    --confirm-staging)    confirm_staging=1; shift ;;
    --max-duration-seconds) max_duration_seconds="${2:-600}"; shift 2 ;;
    -h|--help)            print_help; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Apply env defaults if not set on the command line.
: "${fly_org:=${STAGING_FLY_ORG:-}}"
: "${fly_app_worker:=${STAGING_FLY_APP_WORKER:-}}"
: "${scheduler_api_url:=${STAGING_SCHEDULER_API_URL:-}}"
: "${scheduler_token:=${STAGING_SCHEDULER_TOKEN:-}}"
: "${observability_url:=${STAGING_OBSERVABILITY_URL:-}}"
: "${run_id:=${STAGING_RUN_ID:-}}"
: "${intent_commit:=${STAGING_INTENT_COMMIT:-}}"

missing=()
[[ -z "$fly_org" ]] && missing+=("--fly-org")
[[ -z "$fly_app_worker" ]] && missing+=("--fly-app-worker")
[[ -z "$scheduler_api_url" ]] && missing+=("--scheduler-api-url")
[[ -z "$scheduler_token" ]] && missing+=("--scheduler-token")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: missing required inputs: ${missing[*]}" >&2
  exit 2
fi
if [[ "$confirm_staging" -ne 1 ]]; then
  echo "error: --confirm-staging required (this drill targets staging only)" >&2
  exit 2
fi
if [[ -z "${FLY_API_TOKEN:-}" ]]; then
  echo "error: FLY_API_TOKEN must be set in the caller environment" >&2
  exit 2
fi
if [[ ! "$intent_commit" =~ ^[0-9a-f]{7,64}$ ]]; then
  echo "error: --intent-commit must be a 7-64 character lowercase hex SHA" >&2
  exit 2
fi

# Generate run-id if still empty.
if [[ -z "$run_id" ]]; then
  run_id="${RUN_TAG_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x' $((RANDOM & 0xffff)))"
fi

# Refuse production-looking Fly app names.
for needle in "${PRODUCTION_DENY_SUBSTRINGS[@]}"; do
  if [[ "$fly_app_worker" == *"$needle"* && "$fly_app_worker" != *"-staging"* ]]; then
    echo "error: --fly-app-worker '$fly_app_worker' contains '$needle' which strongly suggests production; refusing." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

redact_token() {
  # Belt-and-suspenders: never let a bearer reach log streams.
  printf '[REDACTED]'
}

started_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

record_check() {
  local name="$1" status="$2" started="$3" ended="$4" details_json="$5" error_json="${6:-null}"
  if [[ "$error_json" == "null" ]]; then
    printf '{"name":"%s","status":"%s","startedAt":"%s","endedAt":"%s","details":%s}\n' \
      "$name" "$status" "$started" "$ended" "$details_json"
  else
    printf '{"name":"%s","status":"%s","startedAt":"%s","endedAt":"%s","details":%s,"error":%s}\n' \
      "$name" "$status" "$started" "$ended" "$details_json" "$error_json"
  fi
}

# curl wrapper: returns a single-line "STATUS\nBODY" pair; sets STATUS to 0
# on transport failure. Bearer token is passed via -H; never logs the value.
http_get() {
  local url="$1" bearer="$2"
  curl --silent --show-error --max-time 15 \
    -H "authorization: Bearer $(redact_token >/dev/null; printf '%s' "$bearer")" \
    -o /tmp/.drill-body.$$ \
    -w "%{http_code}" \
    "$url" || echo "0"
}

emit_failure() {
  echo "error: $1" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Drill steps
# ---------------------------------------------------------------------------

declare -a CHECKS_JSONL=()
declare -a CLEANUP_JSONL=()
declare -a PRODUCTION_BLOCKERS_JSONL=()

drill_step() {
  # usage: drill_step <name> <bash-fn> [args...]
  # bash-fn returns 0 on pass (appends JSON line to CHECKS_JSONL),
  # 99 on skip (records a skip entry, returns 0), or any other non-zero
  # on fail (records a fail entry and returns the same code). Always
  # records both started and ended timestamps in ISO 8601.
  local name="$1"; shift
  local started ended details_json status error_json
  started="$(started_iso)"
  set +e
  details_json="$("$@")"
  rc=$?
  set -e
  ended="$(started_iso)"
  if [[ $rc -eq 0 ]]; then
    status="pass"
    error_json="null"
  elif [[ $rc -eq 99 ]]; then
    status="skip"
    details_json="{}"
    error_json="null"
    rc=0
  else
    status="fail"
    error_json="{\"code\":\"DRILL_STEP_FAILED\",\"message\":\"step $name exited $rc\"}"
    details_json="{}"
  fi
  CHECKS_JSONL+=("$(record_check "$name" "$status" "$started" "$ended" "$details_json" "$error_json")")
  return $rc
}

# Returns a single JSON object describing machines before the drill, or
# exits non-zero on failure.
pre_drill_status() {
  flyctl status --json --app "$fly_app_worker" 2>/dev/null \
    | jq '{ machines: (.Machines // [] | map({ id: .ID, name: .Name, state: .State })) }' \
    || return 1
}

kill_one_worker() {
  # Pick the first worker machine and stop it. flyctl machines stop is
  # reversible via flyctl machines start. The workflow installs the CLI as
  # `flyctl` (Stoff81 Critical #3: prior code mixed `fly` and `flyctl`;
  # the kill/restart steps would fail on the runner because only `flyctl`
  # is on PATH).
  local target
  target="$(flyctl machines list --json --app "$fly_app_worker" 2>/dev/null \
    | jq -r '.[] | select((.config.metadata."fly-process-group" == "worker") or (.name | test("worker"))) | .id' \
    | head -n1)"
  if [[ -z "$target" ]]; then
    # Fallback: pick the first non-nginx machine.
    target="$(flyctl machines list --json --app "$fly_app_worker" 2>/dev/null \
      | jq -r '.[] | select(.name | test("worker|scheduler"; "i")) | .id' | head -n1)"
  fi
  if [[ -z "$target" ]]; then
    echo "error: no worker machine found in app $fly_app_worker" >&2
    return 1
  fi
  flyctl machines stop "$target" --app "$fly_app_worker" >/dev/null 2>&1 \
    && printf '{"stoppedMachineId":"%s"}\n' "$target" \
    || return 1
}

restart_stopped_machine() {
  local machine_id="$1"
  flyctl machines start "$machine_id" --app "$fly_app_worker" >/dev/null 2>&1 \
    && printf '{"startedMachineId":"%s"}\n' "$machine_id" \
    || return 1
}

# Verifies the killed machine is actually in state=stopped via flyctl.
# Returns 0 if stopped, non-zero otherwise. Returns 99 (skip) if the
# kill never produced a STOPPED_MACHINE_ID. This is the post-kill
# truth check Stoff81 Critical #2 demanded: prior code only polled
# the HTTP health endpoint and treated timeout as acceptable, which
# could let a "passing-looking" health poll hide an unverified kill.
verify_killed_stopped() {
  local target="$1"
  if [[ -z "$target" ]]; then
    return 99
  fi
  flyctl machines list --json --app "$fly_app_worker" 2>/dev/null \
    | jq -r --arg id "$target" '.[] | select(.id == $id) | .state' \
    | grep -qx 'stopped' \
    || return 1
  printf '{"machineId":"%s","state":"stopped"}\n' "$target"
}

# Verifies the machine the drill restarted is back in state=started via
# flyctl. Returns 0 if started, non-zero otherwise. Returns 99 (skip)
# if the kill never produced a STOPPED_MACHINE_ID (so there is nothing
# to recover).
verify_recovered_started() {
  local target="$1"
  if [[ -z "$target" ]]; then
    return 99
  fi
  flyctl machines list --json --app "$fly_app_worker" 2>/dev/null \
    | jq -r --arg id "$target" '.[] | select(.id == $id) | .state' \
    | grep -qx 'started' \
    || return 1
  printf '{"machineId":"%s","state":"started"}\n' "$target"
}

# AC3 requires evidence that an alert fired, logs identify the terminated
# process/environment, startup reconciliation completed, and the alert
# resolved. The prerequisite hosted-observability work has not exposed an
# authenticated machine-readable contract for those assertions yet. Record
# this as a failing check instead of treating an HTTP health poll or timeout
# as success (Stoff81 Critical #2).
observability_verification_unimplemented() {
  echo "hosted alert/log/reconciliation verification contract is not implemented" >&2
  return 1
}

# Idempotent cleanup: called directly before the verdict is built and
# again on EXIT (in case the script is interrupted by SIGINT/SIGTERM).
# CLEANUP_RAN guards against double-restart; the direct call populates
# CLEANUP_JSONL so the verdict can include the actual restart result
# instead of treating "cleanup not yet executed" as a failure (Stoff81
# Critical #1: prior code wrote the result JSON before the EXIT trap
# fired, so cleanup_ok was always computed against an empty array).
CLEANUP_RAN=0
cleanup() {
  if [[ "$CLEANUP_RAN" -eq 1 ]]; then
    return
  fi
  CLEANUP_RAN=1
  if [[ -n "${STOPPED_MACHINE_ID:-}" ]]; then
    started="$(started_iso)"
    if restart_stopped_machine "$STOPPED_MACHINE_ID" >/dev/null; then
      ended="$(started_iso)"
      CLEANUP_JSONL+=('{"name":"drill.worker_restart","ok":true,"error":null}')
      STOPPED_MACHINE_ID=""  # Clear so a re-entrant EXIT trap is a no-op.
    else
      ended="$(started_iso)"
      CLEANUP_JSONL+=('{"name":"drill.worker_restart","ok":false,"error":"could not restart stopped worker machine"}')
    fi
  fi
}

trap cleanup EXIT
trap 'echo "drill: SIGTERM received" >&2; exit 143' TERM
trap 'echo "drill: SIGINT received" >&2; exit 130' INT

# Hard duration cap.
START_EPOCH="$(date +%s)"
deadline_reached() {
  local now
  now="$(date +%s)"
  [[ $((now - START_EPOCH)) -ge $max_duration_seconds ]]
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

# Step 1: baseline health must be green before we stop anything.
drill_step drill.baseline_health pre_drill_status || true

# Step 2: stop one worker.
STOPPED_MACHINE_ID=""
RECOVERY_MACHINE_ID=""
drill_step drill.kill_one_worker kill_one_worker
if [[ ${#CHECKS_JSONL[@]} -gt 0 ]]; then
  last_line="${CHECKS_JSONL[-1]}"
  if [[ "$last_line" == *'"status":"pass"'* ]]; then
    STOPPED_MACHINE_ID="$(printf '%s' "$last_line" | jq -r '.details.stoppedMachineId // empty')"
    RECOVERY_MACHINE_ID="$STOPPED_MACHINE_ID"
  fi
fi

# Step 3: confirm the killed machine is actually in state=stopped.
# This is the post-kill truth check (Stoff81 Critical #2); it fails
# the drill if flyctl shows the machine still running. Skipped when
# the kill itself never produced a STOPPED_MACHINE_ID (kill failed).
drill_step drill.verify_killed_machine_stopped verify_killed_stopped "$STOPPED_MACHINE_ID" || true

# Step 4: explicitly fail until the hosted observability prerequisite exposes
# an authenticated alert/log/reconciliation verification contract.
drill_step drill.observability_alert_logs_and_reconciliation observability_verification_unimplemented || true

# Run cleanup() directly so CLEANUP_JSONL is populated before the
# verdict is computed. The EXIT trap will see CLEANUP_RAN=1 and be
# a no-op; if the script is interrupted before reaching here, the
# EXIT trap still runs cleanup() once (Stoff81 Critical #1).
cleanup

# Step 5: confirm the machine is back to state=started after the
# restart. Skipped when no kill ever produced a STOPPED_MACHINE_ID.
drill_step drill.verify_recovered_machine_started verify_recovered_started "$RECOVERY_MACHINE_ID" || true

cleanup_ok=1
for line in "${CLEANUP_JSONL[@]}"; do
  if [[ "$line" != *'"ok":true'* ]]; then
    cleanup_ok=0
  fi
done

verdict="fail"
checks_all_pass=1
for line in "${CHECKS_JSONL[@]}"; do
  if [[ "$line" != *'"status":"pass"'* ]]; then
    checks_all_pass=0
    break
  fi
done
if [[ "$checks_all_pass" -eq 1 && "$cleanup_ok" -eq 1 ]]; then
  verdict="pass"
fi

# Build the final JSON.
checks_array="$(printf '%s\n' "${CHECKS_JSONL[@]}" | jq -s '.')"
cleanup_array="$(printf '%s\n' "${CLEANUP_JSONL[@]}" | jq -s '.')"
if [[ ${#CLEANUP_JSONL[@]} -eq 0 ]]; then
  cleanup_array='[{"name":"drill.worker_restart_not_needed","ok":true,"error":null}]'
fi

accepted_limitations='[]'
production_blockers='[{"code":"AC3_OBSERVABILITY_VERIFICATION_UNIMPLEMENTED","summary":"The drill cannot yet verify alert firing/resolution, correlated logs, or startup reconciliation through a machine-readable hosted-observability contract.","owner":"Rowan","reference":"docs/specs/cloud-staging-environment-tech-design.md#4-verify-failure-alerting-and-recovery"}]'

ended_iso="$(started_iso)"
# intentCommit is either a quoted string or null. The prior in-heredoc
# concatenation `${intent_commit:+"\"$intent_commit\""}${intent_commit:-null}`
# produced invalid JSON like `"abc123"abc123` when intent_commit was set
# (Codex P1 #4). Build the token here so jq can parse the result without
# the trailing-literal bug.
intent_commit_json="\"$intent_commit\""
services_json=$(cat <<JSON
{
  "tasksApi": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false},
  "budgetApi": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false},
  "contentScheduler": {"url":"${scheduler_api_url}","version":null,"matchesIntent":false}
}
JSON
)

result=$(cat <<JSON
{
  "schemaVersion": ${SCHEMA_VERSION},
  "runId": "${run_id}",
  "intentCommit": ${intent_commit_json:-null},
  "environment": { "id": "${fly_org}/${fly_app_worker}", "provider": "fly.io" },
  "startedAt": "${START_EPOCH:-}",
  "endedAt": "${ended_iso}",
  "services": ${services_json},
  "checks": ${checks_array},
  "cleanup": { "ok": $([[ $cleanup_ok -eq 1 ]] && echo true || echo false), "operations": ${cleanup_array} },
  "productionBlockers": ${production_blockers},
  "acceptedLimitations": ${accepted_limitations},
  "verdict": "${verdict}"
}
JSON
)

# Replace startedAt with the real ISO timestamp captured at the start.
real_started="$(date -u -d "@${START_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${START_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"
result="$(printf '%s' "$result" | jq --arg s "$real_started" '.startedAt = $s')"

# Pretty-print and write.
result="$(printf '%s' "$result" | jq '.')"
if [[ -n "$output_path" ]]; then
  printf '%s\n' "$result" > "$output_path"
else
  printf '%s\n' "$result"
fi

if [[ "$verdict" == "pass" ]]; then
  exit 0
fi
exit 1
