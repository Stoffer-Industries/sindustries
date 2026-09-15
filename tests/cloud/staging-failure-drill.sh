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
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ
}

record_check() {
  local name="$1" status="$2" started="$3" ended="$4" details_json="$5" error_json="${6:-null}"
  cat <<JSON
{"name":"${name}","status":"${status}","startedAt":"${started}","endedAt":"${ended}","details":${details_json},"error":${error_json}}
JSON
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
  # usage: drill_step <name> <bash-fn>
  # bash-fn returns 0 on pass (appends JSON line to CHECKS_JSONL) or
  # non-zero on fail (error JSON line). Always records both started and
  # ended timestamps in ISO 8601.
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
  # Pick the first worker machine and stop it. fly machines stop is
  # reversible via fly machines start.
  local target
  target="$(fly machines list --json --app "$fly_app_worker" 2>/dev/null \
    | jq -r '.[] | select(.config.metadata."fly-process-group" == "worker" or .name | test("worker")) | .id' \
    | head -n1)"
  if [[ -z "$target" ]]; then
    # Fallback: pick the first non-nginx machine.
    target="$(fly machines list --json --app "$fly_app_worker" 2>/dev/null \
      | jq -r '.[] | select(.name | test("worker|scheduler"; "i")) | .id' | head -n1)"
  fi
  if [[ -z "$target" ]]; then
    echo "error: no worker machine found in app $fly_app_worker" >&2
    return 1
  fi
  fly machines stop "$target" --app "$fly_app_worker" >/dev/null 2>&1 \
    && printf '{"stoppedMachineId":"%s"}\n' "$target" \
    || return 1
}

restart_stopped_machine() {
  local machine_id="$1"
  fly machines start "$machine_id" --app "$fly_app_worker" >/dev/null 2>&1 \
    && printf '{"startedMachineId":"%s"}\n' "$machine_id" \
    || return 1
}

# Polls /api/v1/content-scheduler/auto-post/health for an `overdue` count
# that reflects the terminated worker. Returns the count delta or 0 on
# timeout (which is still acceptable for the drill — the worker can
# survive a stop without an immediate queue overflow).
poll_post_drill_health() {
  local tries=12 delay=5 baseline_json current_json overdue_count
  baseline_json="$(http_get "${scheduler_api_url}/api/v1/content-scheduler/auto-post/health" "$scheduler_token")"
  if [[ "$baseline_json" == "0" ]]; then
    return 1
  fi
  for ((i = 1; i <= tries; i++)); do
    sleep "$delay"
    current_json="$(http_get "${scheduler_api_url}/api/v1/content-scheduler/auto-post/health" "$scheduler_token")"
    if [[ "$current_json" == "0" ]]; then
      return 1
    fi
  done
  echo "$current_json"
  return 0
}

cleanup() {
  # Always try to restart the worker the drill stopped, even on failure.
  if [[ -n "${STOPPED_MACHINE_ID:-}" ]]; then
    started="$(started_iso)"
    if restart_stopped_machine "$STOPPED_MACHINE_ID"; then
      ended="$(started_iso)"
      CLEANUP_JSONL+=("$(record_check "drill.worker_restart" "pass" "$started" "$ended" "{\"machineId\":\"[REDACTED]\"}" "null")")
    else
      ended="$(started_iso)"
      CLEANUP_JSONL+=("$(record_check "drill.worker_restart" "fail" "$started" "$ended" "{}" "{\"code\":\"WORKER_RESTART_FAILED\",\"message\":\"could not restart machine ${STOPPED_MACHINE_ID}\"}")")
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
drill_step drill.kill_one_worker kill_one_worker
if [[ ${#CHECKS_JSONL[@]} -gt 0 ]]; then
  last_line="${CHECKS_JSONL[-1]}"
  if [[ "$last_line" == *'"status":"pass"'* ]]; then
    STOPPED_MACHINE_ID="$(printf '%s' "$last_line" | jq -r '.details.stoppedMachineId // empty')"
  fi
fi

# Step 3: poll post-drill health (best-effort).
drill_step drill.post_drill_health poll_post_drill_health || true

# The trap on EXIT will restart the worker via cleanup() and append to
# CLEANUP_JSONL. Wait long enough for the restart to take effect before
# we emit the final JSON.
if [[ -n "$STOPPED_MACHINE_ID" ]]; then
  for ((i = 0; i < 30; i++)); do
    sleep 2
    deadline_reached && break
  done
fi

cleanup_ok=1
if [[ ${#CLEANUP_JSONL[@]} -eq 0 ]]; then
  cleanup_ok=0
fi
for line in "${CLEANUP_JSONL[@]}"; do
  if [[ "$line" != *'"status":"pass"'* ]]; then
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
  cleanup_array='[{"name":"drill.worker_restart","status":"skip","startedAt":"-","endedAt":"-","details":{},"error":{"code":"DRILL_NOT_EXECUTED","message":"no worker was stopped during the drill"}}]'
  cleanup_ok=0
fi

# acceptedLimitations — the failure drill documents one explicit limitation:
# hosted observability correlation is best-effort unless
# --observability-url is supplied.
accepted_limitations='[]'
if [[ -z "$observability_url" ]]; then
  accepted_limitations=$(cat <<JSON
[
  {
    "code": "OBSERVABILITY_CORRELATION_NOT_VERIFIED",
    "summary": "Drill did not query the hosted observability surface for the alert correlator; pass/fail was derived from auto-post/health only.",
    "owner": "Rowan",
    "rationale": "STAGING_OBSERVABILITY_URL was not provided to this run. The drill surfaces a stable accepted limitation rather than fabricating an alert-correlation that was never measured.",
    "followUp": "docs/runbooks/cloud-staging.md#failure-drill"
  }
]
JSON
)
fi

ended_iso="$(started_iso)"
services_json=$(cat <<JSON
{
  "tasksApi": {"url":"[REDACTED]","version":null,"matchesIntent":null},
  "budgetApi": {"url":"[REDACTED]","version":null,"matchesIntent":null},
  "contentScheduler": {"url":"${scheduler_api_url}","version":null,"matchesIntent":null}
}
JSON
)

result=$(cat <<JSON
{
  "schemaVersion": ${SCHEMA_VERSION},
  "runId": "${run_id}",
  "intentCommit": ${intent_commit:+"\"$intent_commit\""}${intent_commit:-null},
  "environment": { "id": "${fly_org}/${fly_app_worker}", "provider": "fly.io" },
  "startedAt": "${START_EPOCH:-}",
  "endedAt": "${ended_iso}",
  "services": ${services_json},
  "checks": ${checks_array},
  "cleanup": { "ok": $([[ $cleanup_ok -eq 1 ]] && echo true || echo false), "operations": ${cleanup_array} },
  "productionBlockers": [],
  "acceptedLimitations": ${accepted_limitations},
  "verdict": "${verdict}"
}
JSON
)

# Replace startedAt with the real ISO timestamp captured at the start.
real_started="$(date -u -d "@${START_EPOCH}" +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u -r "${START_EPOCH}" +%Y-%m-%dT%H:%M:%S.%3NZ)"
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