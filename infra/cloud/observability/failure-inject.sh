#!/usr/bin/env bash
#
# failure-inject.sh — guided AC2 failure scenarios for task 31233a0a.
#
# Quinn runs each scenario against staging to demonstrate that the
# matching alert (defined in infra/cloud/observability/grafana/alerts/)
# fires, captures the alert state JSON via evidence-capture.sh, then
# runs the matching recover scenario to demonstrate resolution.
#
# Each scenario:
#   1. Prints the failure command + the alert that should fire.
#   2. Prints the expected observation window (alert `for` duration + scrape interval).
#   3. Either runs the command (default) or prints it (--dry-run).
#   4. Exits non-zero if the failure command itself fails.
#
# Usage:
#   failure-inject.sh <scenario> [--dry-run] [--app <name>] [-h|--help]
#
# Scenarios (all have a matching <scenario>-up or <scenario>-recover counterpart):
#   redis-down           Suspend the content-scheduler Redis Fly app (or
#                        your Fly Redis addon) so PING fails. Expected
#                        alert: sindustries-redis-down (for=1m).
#   tasks-api-down       Scale the tasks-api Fly app to 0 machines.
#                        Expected alert: sindustries-tasks-api-down (for=2m).
#   tasks-api-up         Restore tasks-api to 1 machine.
#   budget-api-down      Scale the budget-api Fly app to 0 machines.
#                        Expected alert: sindustries-budget-api-down (for=2m).
#   budget-api-up        Restore budget-api to 1 machine.
#   db-down              Repoint the health-probe at a non-existent DB
#                        host via a Fly secrets update. Expected alerts:
#                        sindustries-tasks-api-db-down + budget-api-db-down.
#   db-up                Restore the original HEALTH_PROBE_DATABASES secret.
#   deploy-failed        Trigger a Fly deploy with a non-existent image
#                        tag (the workflow can also be invoked with a
#                        broken SHA). Expected alert: sindustries-deploy-failed.
#   deploy-restored      Redeploy with the correct image tag.
#
# Flags:
#   --dry-run     Print the failure command without applying it.
#                 Does NOT require FLY_API_TOKEN — use this to preview.
#   --app <name>  Override the target Fly app (default depends on scenario).
#   -h/--help     Show usage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

ENV_LOCAL="${SCRIPT_DIR}/.env.local"
DRY_RUN=false
APP_OVERRIDE=""

print_help() {
  cat <<'HELP'
failure-inject.sh — guided AC2 failure scenarios for task 31233a0a.

Quinn runs each scenario against staging to demonstrate that the
matching alert (defined in infra/cloud/observability/grafana/alerts/)
fires, captures the alert state JSON via evidence-capture.sh, then
runs the matching recover scenario to demonstrate resolution.

Each scenario:
  1. Prints the failure command + the alert that should fire.
  2. Prints the expected observation window (alert `for` duration + scrape interval).
  3. Either runs the command (default) or prints it (--dry-run).
  4. Exits non-zero if the failure command itself fails.

Usage:
  failure-inject.sh <scenario> [--dry-run] [--app <name>] [-h|--help]

Scenarios (all have a matching <scenario>-up or <scenario>-recover counterpart):
  redis-down           Suspend the content-scheduler Redis Fly app (or
                       your Fly Redis addon) so PING fails. Expected
                       alert: sindustries-redis-down (for=1m).
  redis-up             Resume the content-scheduler Redis.
  tasks-api-down       Scale the tasks-api Fly app to 0 machines.
                       Expected alert: sindustries-tasks-api-down (for=2m).
  tasks-api-up         Restore tasks-api to 1 machine.
  budget-api-down      Scale the budget-api Fly app to 0 machines.
                       Expected alert: sindustries-budget-api-down (for=2m).
  budget-api-up        Restore budget-api to 1 machine.
  db-down              Repoint the health-probe at a non-existent DB
                       host via a Fly secrets update. Expected alerts:
                       sindustries-tasks-api-db-down + budget-api-db-down.
  db-up                Restore the original HEALTH_PROBE_DATABASES secret.
  deploy-failed        Trigger a Fly deploy with a non-existent image
                       tag (the workflow can also be invoked with a
                       broken SHA). Expected alert: sindustries-deploy-failed.
  deploy-restored      Redeploy with the correct image tag.

Flags:
  --dry-run     Print the failure command without applying it.
                 Does NOT require FLY_API_TOKEN — use this to preview.
  --app <name>  Override the target Fly app (default depends on scenario).
  -h/--help     Show usage.
HELP
}

while [ "${#}" -gt 0 ]; do
  case "$1" in
    -h|--help) print_help; exit 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --app)     APP_OVERRIDE="$2"; shift 2 ;;
    redis-down|redis-up|tasks-api-down|tasks-api-up|budget-api-down|budget-api-up|db-down|db-up|deploy-failed|deploy-restored)
      SCENARIO="$1"; shift ;;
    *)
      echo "::error::unknown argument: $1" >&2
      print_help
      exit 2
      ;;
  esac
done

if [ -z "${SCENARIO:-}" ]; then
  echo "::error::missing scenario. Run with --help for the list." >&2
  exit 2
fi

require_dry_run_or_token() {
  if [ "${DRY_RUN}" = true ]; then
    return 0
  fi
  if [ ! -f "${ENV_LOCAL}" ]; then
    echo "::error::Quinn-owned secret file not found: ${ENV_LOCAL}" >&2
    echo "::error::Re-run with --dry-run to preview the failure command." >&2
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "${ENV_LOCAL}"
  set +a
  if [ -z "${FLY_API_TOKEN:-}" ]; then
    echo "::error::FLY_API_TOKEN not set in .env.local" >&2
    exit 1
  fi
  export FLY_API_TOKEN
}

print_scenario_header() {
  local title="$1"
  local alert_uid="$2"
  local expected_for="$3"
  echo "==> Scenario: ${title}"
  echo "    Expected alert: ${alert_uid}"
  echo "    Expected \`for\` window: ${expected_for}"
  echo "    Capture state via: ./infra/cloud/observability/evidence-capture.sh --format sh"
}

run_flyctl() {
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] flyctl $*"
    return 0
  fi
  flyctl "$@"
}

scenario_redis_down() {
  print_scenario_header "redis-down" "sindustries-redis-down" "1m"
  require_dry_run_or_token
  local redis_app="${APP_OVERRIDE:-content-scheduler-redis}"
  run_flyctl redis suspend --app "${redis_app}" 2>/dev/null \
    || run_flyctl machines suspend --app "${redis_app}" --all 2>/dev/null \
    || echo "    (could not auto-pause ${redis_app}; manually pause in the Fly dashboard or scale its machines to 0)"
  cat <<NOTE

    Wait ~90s, then:
      bash infra/cloud/observability/evidence-capture.sh --format sh | bash
    Capture alert-state JSON for sindustries-redis-down.
    Run \`${0} redis-up [--app ${redis_app}]\` to recover.
NOTE
}

scenario_redis_up() {
  print_scenario_header "redis-up (recover)" "sindustries-redis-down" "(should resolve)"
  require_dry_run_or_token
  local redis_app="${APP_OVERRIDE:-content-scheduler-redis}"
  run_flyctl redis resume --app "${redis_app}" 2>/dev/null \
    || run_flyctl machines start --app "${redis_app}" --all 2>/dev/null \
    || echo "    (could not auto-resume ${redis_app}; manually resume in the Fly dashboard or scale back to 1)"
  cat <<NOTE

    Wait ~90s for the alert to transition to Normal.
    Re-run evidence-capture.sh and confirm the alert state is "Normal".
NOTE
}

scenario_tasks_api_down() {
  print_scenario_header "tasks-api-down" "sindustries-tasks-api-down" "2m"
  require_dry_run_or_token
  local app="${APP_OVERRIDE:-sindustries-tasks-api-staging}"
  run_flyctl scale count 0 --app "${app}"
  cat <<NOTE

    Wait ~3m (alert \`for=2m\` + 60s scrape interval + buffer), then:
      bash infra/cloud/observability/evidence-capture.sh --format sh | bash
    Capture alert-state JSON for sindustries-tasks-api-down.
    Run \`${0} tasks-api-up [--app ${app}]\` to recover.
NOTE
}

scenario_tasks_api_up() {
  print_scenario_header "tasks-api-up (recover)" "sindustries-tasks-api-down" "(should resolve)"
  require_dry_run_or_token
  local app="${APP_OVERRIDE:-sindustries-tasks-api-staging}"
  run_flyctl scale count 1 --app "${app}"
  cat <<NOTE

    Wait ~3m for the alert to transition to Normal.
    Re-run evidence-capture.sh and confirm the alert state is "Normal".
NOTE
}

scenario_budget_api_down() {
  print_scenario_header "budget-api-down" "sindustries-budget-api-down" "2m"
  require_dry_run_or_token
  local app="${APP_OVERRIDE:-sindustries-budget-api-staging}"
  run_flyctl scale count 0 --app "${app}"
  cat <<NOTE

    Wait ~3m, then capture alert-state JSON for sindustries-budget-api-down.
    Run \`${0} budget-api-up [--app ${app}]\` to recover.
NOTE
}

scenario_budget_api_up() {
  print_scenario_header "budget-api-up (recover)" "sindustries-budget-api-down" "(should resolve)"
  require_dry_run_or_token
  local app="${APP_OVERRIDE:-sindustries-budget-api-staging}"
  run_flyctl scale count 1 --app "${app}"
  cat <<NOTE

    Wait ~3m for the alert to transition to Normal.
NOTE
}

scenario_db_down() {
  print_scenario_header "db-down (repoint health-probe at unreachable DB)" \
    "sindustries-tasks-api-db-down + sindustries-budget-api-db-down" "1m"
  require_dry_run_or_token
  local probe_app="${APP_OVERRIDE:-sindustries-health-probe-staging}"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] flyctl secrets set --app ${probe_app} \\"
    echo "                HEALTH_PROBE_DATABASES='tasks-api=postgres://nope:nope@127.0.0.1:1/no,budget-api=postgres://nope:nope@127.0.0.1:1/no'"
    cat <<NOTE

    Wait ~2m, then capture alert-state JSON for both task-DB-down alerts.
    Run \`${0} db-up [--app ${probe_app}]\` to recover (the script will
    source the real HEALTH_PROBE_DATABASES value from .env.local).
NOTE
    return 0
  fi
  if [ -z "${HEALTH_PROBE_DATABASES:-}" ]; then
    echo "::error::HEALTH_PROBE_DATABASES not set in .env.local — cannot capture for recover." >&2
    exit 1
  fi
  echo "    Saving current HEALTH_PROBE_DATABASES for recover (in-memory only)."
  ORIGINAL_DBS="${HEALTH_PROBE_DATABASES}"
  flyctl secrets set \
    --app "${probe_app}" \
    HEALTH_PROBE_DATABASES="tasks-api=postgres://nope:nope@127.0.0.1:1/no,budget-api=postgres://nope:nope@127.0.0.1:1/no"
  cat <<NOTE

    Wait ~2m, then capture alert-state JSON for both task-DB-down alerts.
    Run \`${0} db-up [--app ${probe_app}]\` to recover.
NOTE
}

scenario_db_up() {
  print_scenario_header "db-up (recover)" \
    "sindustries-tasks-api-db-down + sindustries-budget-api-db-down" "(should resolve)"
  require_dry_run_or_token
  local probe_app="${APP_OVERRIDE:-sindustries-health-probe-staging}"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] flyctl secrets set --app ${probe_app} HEALTH_PROBE_DATABASES=<restored-from-env>"
    return 0
  fi
  if [ -z "${HEALTH_PROBE_DATABASES:-}" ]; then
    echo "::error::HEALTH_PROBE_DATABASES not set in .env.local — cannot restore." >&2
    exit 1
  fi
  flyctl secrets set \
    --app "${probe_app}" \
    HEALTH_PROBE_DATABASES="${HEALTH_PROBE_DATABASES}"
  cat <<NOTE

    Wait ~2m for both alerts to transition to Normal.
NOTE
}

scenario_deploy_failed() {
  print_scenario_header "deploy-failed (trigger a broken deploy)" "sindustries-deploy-failed" "5m"
  require_dry_run_or_token
  local app="${APP_OVERRIDE:-sindustries-health-probe-staging}"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] gh workflow run deploy-staging-health-probe.yml \\"
    echo "                -f image=registry.fly.io/sindustries-health-probe-staging:does-not-exist"
    echo "    (or: gh workflow run deploy-staging-tasks-api.yml -f image=...)"
    cat <<NOTE

    Wait ~6m (alert \`for=5m\` + 60s scrape interval + buffer), then capture
    alert-state JSON for sindustries-deploy-failed.
    Run \`${0} deploy-restored [--app ${app}]\` to recover.
NOTE
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { echo "::error::gh CLI not found" >&2; exit 1; }
  echo "    Triggering a broken deploy of ${app} via gh workflow run..."
  gh workflow run deploy-staging-health-probe.yml \
    --repo "${GITHUB_REPOSITORY:-Stoffer-Industries/sindustries}" \
    -f image=registry.fly.io/${app}:does-not-exist
  cat <<NOTE

    Wait ~6m, then capture alert-state JSON for sindustries-deploy-failed.
    Run \`${0} deploy-restored [--app ${app}]\` to recover.
NOTE
}

scenario_deploy_restored() {
  print_scenario_header "deploy-restored (re-run a correct deploy)" "sindustries-deploy-failed" "(should resolve)"
  require_dry_run_or_token
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] gh workflow run deploy-staging-health-probe.yml (no image override)"
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { echo "::error::gh CLI not found" >&2; exit 1; }
  gh workflow run deploy-staging-health-probe.yml \
    --repo "${GITHUB_REPOSITORY:-Stoffer-Industries/sindustries}"
  cat <<NOTE

    Wait ~6m for the alert to transition to Normal.
NOTE
}

case "${SCENARIO}" in
  redis-down)         scenario_redis_down ;;
  redis-up)           scenario_redis_up ;;
  tasks-api-down)     scenario_tasks_api_down ;;
  tasks-api-up)       scenario_tasks_api_up ;;
  budget-api-down)    scenario_budget_api_down ;;
  budget-api-up)      scenario_budget_api_up ;;
  db-down)            scenario_db_down ;;
  db-up)              scenario_db_up ;;
  deploy-failed)      scenario_deploy_failed ;;
  deploy-restored)    scenario_deploy_restored ;;
  *)
    echo "::error::unknown scenario: ${SCENARIO}" >&2
    exit 2
    ;;
esac
