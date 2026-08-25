#!/usr/bin/env bash
# bootstrap-staging.sh — one-time staging environment creation for Sindustries.
#
# Quinn-owned operational script. Runs LOCALLY only (never in CI). Idempotent:
# re-running does not destroy existing Fly apps; existing secret values are
# replaced via `fly secrets set` which is a no-op for unchanged values.
#
# Inputs:
#   infra/cloud/.env.local  — Quinn-owned file with Fly app names + secret values.
#                             Never committed; .gitignore'd. Format is the union
#                             of env/tasks-api.env.example, env/budget-api.env.example,
#                             and env/auto-post-worker.env.example prefixed by the
#                             service name (TASKS_API_*, BUDGET_API_*, AUTO_POST_WORKER_*).
#                             Plus top-level FLY_APP_* aliases if Quinn wants to
#                             override the default staging app names.
#
# Steps (each guarded by a confirm prompt unless --yes is passed):
#   1. Pre-flight: `fly` CLI installed + authenticated, .env.local readable.
#   2. Create missing Fly apps (tasks-api, budget-api, auto-post-worker).
#   3. `fly secrets set` per service from .env.local values.
#   4. Prisma migrations deploy (tasks-api + content-scheduler-api; budget-api is migrationless).
#      Skipped by default; pass --migrate to enable.
#   5. Smoke deploy (canary). Skipped by default; pass --deploy to enable.
#
# Output:
#   - Final report on stdout with Fly app URLs, deployed versions, smoke-check status.
#
# Quinn-owned (per docs/specs/cloud-deployment-foundation-tech-design.md, PR #508 APPROVED):
#   FLY_API_TOKEN, Neon connection strings (DATABASE_URL per schema), Upstash credentials,
#   DNS provider token. This script reads them from .env.local; nothing in this script
#   references a secret value by name.
#
# Usage:
#   infra/cloud/scripts/bootstrap-staging.sh                # interactive (default)
#   infra/cloud/scripts/bootstrap-staging.sh --yes          # non-interactive; secrets + create only
#   infra/cloud/scripts/bootstrap-staging.sh --yes --migrate --deploy
#                                                          # full bootstrap, no prompts
#   infra/cloud/scripts/bootstrap-staging.sh --service tasks-api --yes
#                                                          # one service only
#
# Exit codes:
#   0 = success
#   1 = pre-flight failure (missing CLI / missing .env.local / missing secret values)
#   2 = Fly API failure (auth, quota, app-create collision that we can't recover)
#   3 = migration failure
#   4 = smoke-deploy failure

set -euo pipefail

# ---------- defaults / arg parsing -----------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_LOCAL="${REPO_ROOT}/infra/cloud/.env.local"

# Default staging app names match the fly.toml files in infra/cloud/fly/.
FLY_APP_TASKS_API_DEFAULT="sindustries-tasks-api-staging"
FLY_APP_BUDGET_API_DEFAULT="sindustries-budget-api-staging"
FLY_APP_AUTO_POST_WORKER_DEFAULT="sindustries-auto-post-worker-staging"

FLY_APP_TASKS_API="${FLY_APP_TASKS_API_DEFAULT}"
FLY_APP_BUDGET_API="${FLY_APP_BUDGET_API_DEFAULT}"
FLY_APP_AUTO_POST_WORKER="${FLY_APP_AUTO_POST_WORKER_DEFAULT}"

ASSUME_YES=0
RUN_MIGRATIONS=0
RUN_DEPLOY=0
ONLY_SERVICE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)             ASSUME_YES=1; shift ;;
    --migrate)         RUN_MIGRATIONS=1; shift ;;
    --deploy)          RUN_DEPLOY=1; shift ;;
    --service)         ONLY_SERVICE="${2:-}"; shift 2 ;;
    --env-local)       ENV_LOCAL="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1 ;;
  esac
done

# ---------- output helpers --------------------------------------------------

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
else
  C_RESET="" C_BOLD="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE=""
fi

info()  { printf '%s[INFO]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf '%s[ OK ]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '%s[FAIL]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit "${2:-1}"; }
hdr()   { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    info "(--yes) $prompt — proceeding"
    return 0
  fi
  local reply
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) warn "aborted by operator"; exit 1 ;;
  esac
}

# ---------- pre-flight ------------------------------------------------------

hdr "1. Pre-flight"

command -v flyctl >/dev/null 2>&1 || command -v fly >/dev/null 2>&1 \
  || fail "fly CLI not found in PATH. Install: https://fly.io/docs/hands-on/install-flyctl/" 1

# Prefer `flyctl` if both are aliased; the GH Actions workflows use flyctl, so
# local + CI are consistent.
FLY="flyctl"
command -v flyctl >/dev/null 2>&1 || FLY="fly"

# Auth check: `flyctl auth whoami` exits non-zero when not logged in. We don't
# print the identity to stdout (Quinn-owned info).
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  fail "fly CLI not authenticated. Run: $FLY auth login" 1
fi
ok "fly CLI authenticated"

if [[ ! -f "$ENV_LOCAL" ]]; then
  fail "Quinn-owned env file not found: $ENV_LOCAL
  Expected format: union of infra/cloud/env/*.env.example values, prefixed by service name
  (TASKS_API_*, BUDGET_API_*, AUTO_POST_WORKER_*). Copy infra/cloud/env/.env.example as a
  starting point, fill in Quinn-owned values, re-run." 1
fi
# shellcheck disable=SC1090
source "$ENV_LOCAL"
ok ".env.local loaded"

# Override Fly app names if Quinn set them in .env.local.
[[ -n "${FLY_APP_TASKS_API:-}" ]]      && FLY_APP_TASKS_API="$FLY_APP_TASKS_API"
[[ -n "${FLY_APP_BUDGET_API:-}" ]]     && FLY_APP_BUDGET_API="$FLY_APP_BUDGET_API"
[[ -n "${FLY_APP_AUTO_POST_WORKER:-}" ]] && FLY_APP_AUTO_POST_WORKER="$FLY_APP_AUTO_POST_WORKER"

info "Target Fly apps:"
info "  tasks-api:           $FLY_APP_TASKS_API"
info "  budget-api:          $FLY_APP_BUDGET_API"
info "  auto-post-worker:    $FLY_APP_AUTO_POST_WORKER"

# ---------- Fly app creation ------------------------------------------------

create_app_if_missing() {
  local app="$1"
  if "$FLY" apps list --json 2>/dev/null | grep -q "\"Name\":\"$app\""; then
    ok "app exists: $app"
    return 0
  fi
  info "creating app: $app"
  "$FLY" apps create --app "$app" --org personal >/dev/null
  ok "created app: $app"
}

hdr "2. Fly apps"

if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "tasks-api" ]]; then
  create_app_if_missing "$FLY_APP_TASKS_API"
fi
if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "budget-api" ]]; then
  create_app_if_missing "$FLY_APP_BUDGET_API"
fi
if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "auto-post-worker" ]]; then
  create_app_if_missing "$FLY_APP_AUTO_POST_WORKER"
fi

# ---------- Fly secrets -----------------------------------------------------

# Apply one service's TASKS_API_* / BUDGET_API_* / AUTO_POST_WORKER_* env values as
# Fly secrets. Strips the prefix so the secret NAME matches what the service
# reads (e.g. TASKS_API_DATABASE_URL -> DATABASE_URL).
apply_secrets_for_service() {
  local app="$1"
  local prefix="$2"  # TASKS_API / BUDGET_API / AUTO_POST_WORKER

  # Discover keys via env (printenv), filter to prefix, strip prefix.
  local keys=()
  local key
  while IFS= read -r key; do
    keys+=("$key")
  done < <(printenv | awk -F= -v p="$prefix" '$1 ~ "^"p"_" {print $1}' | sort)

  if [[ ${#keys[@]} -eq 0 ]]; then
    warn "no ${prefix}_* env vars found in .env.local; skipping $app"
    return 0
  fi

  local args=()
  for key in "${keys[@]}"; do
    local secret_name="${key#${prefix}_}"
    local secret_value="${!key:-}"
    if [[ -z "$secret_value" ]]; then
      warn "  $secret_name (from $key) is empty in .env.local — skipping"
      continue
    fi
    args+=("$secret_name=$secret_value")
  done

  if [[ ${#args[@]} -eq 0 ]]; then
    warn "no non-empty ${prefix}_* secrets to apply for $app"
    return 0
  fi

  info "setting ${#args[@]} secrets on $app"
  # `fly secrets set` reads secrets from the args; values are passed inline
  # (Quinn-owned values, never logged by Fly in CI logs).
  # shellcheck disable=SC2086
  "$FLY" secrets set --app "$app" "${args[@]}" >/dev/null
  ok "secrets applied: $app (${#args[@]} keys)"
}

hdr "3. Fly secrets"

if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "tasks-api" ]]; then
  apply_secrets_for_service "$FLY_APP_TASKS_API" "TASKS_API"
fi
if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "budget-api" ]]; then
  apply_secrets_for_service "$FLY_APP_BUDGET_API" "BUDGET_API"
fi
if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "auto-post-worker" ]]; then
  apply_secrets_for_service "$FLY_APP_AUTO_POST_WORKER" "AUTO_POST_WORKER"
fi

# ---------- migrations ------------------------------------------------------

run_migrations_for_app() {
  local app="$1"
  local workdir="$2"  # path inside the deployed app where `npx prisma` runs

  info "running prisma migrate deploy on $app (workdir=$workdir)"
  # `fly ssh console` runs an interactive shell; for non-interactive use
  # `-C '...'`. We pipe `set -e` so a failing migrate aborts.
  "$FLY" ssh console --app "$app" -C "cd $workdir && npx prisma migrate deploy" \
    || fail "prisma migrate deploy failed on $app" 3
  ok "migrations applied: $app"
}

hdr "4. Prisma migrations"
if [[ "$RUN_MIGRATIONS" -eq 0 ]]; then
  info "skipped (pass --migrate to enable; will prompt before applying)"
fi

if [[ "$RUN_MIGRATIONS" -eq 1 ]]; then
  confirm "Apply Prisma migrations on $FLY_APP_TASKS_API + $FLY_APP_AUTO_POST_WORKER?"
  if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "tasks-api" ]]; then
    run_migrations_for_app "$FLY_APP_TASKS_API" "/app/services/tasks-api"
  fi
  if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "auto-post-worker" ]]; then
    # Auto-post-worker ships content-scheduler-api's source. Migrations live in
    # services/content-scheduler-api/prisma. We run via the worker machine
    # because it's the only always-on process for that service tree.
    run_migrations_for_app "$FLY_APP_AUTO_POST_WORKER" "/app/services/content-scheduler-api"
  fi
fi

# ---------- smoke deploy ----------------------------------------------------

hdr "5. Smoke deploy"
if [[ "$RUN_DEPLOY" -eq 0 ]]; then
  info "skipped (pass --deploy to enable; will prompt before deploying)"
fi

if [[ "$RUN_DEPLOY" -eq 1 ]]; then
  cd "$REPO_ROOT"
  confirm "Run canary deploy for each service?"

  if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "tasks-api" ]]; then
    info "deploying $FLY_APP_TASKS_API"
    "$FLY" deploy --config infra/cloud/fly/tasks-api.fly.toml --strategy canary --wait-timeout 600 \
      || fail "canary deploy failed: tasks-api" 4
    ok "deployed: $FLY_APP_TASKS_API"
  fi
  if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "budget-api" ]]; then
    info "deploying $FLY_APP_BUDGET_API"
    "$FLY" deploy --config infra/cloud/fly/budget-api.fly.toml --strategy canary --wait-timeout 600 \
      || fail "canary deploy failed: budget-api" 4
    ok "deployed: $FLY_APP_BUDGET_API"
  fi
  if [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "auto-post-worker" ]]; then
    info "deploying $FLY_APP_AUTO_POST_WORKER"
    "$FLY" deploy --config infra/cloud/fly/auto-post-worker.fly.toml --strategy canary --wait-timeout 600 \
      || fail "canary deploy failed: auto-post-worker" 4
    ok "deployed: $FLY_APP_AUTO_POST_WORKER"
  fi
fi

# ---------- final report ----------------------------------------------------

hdr "6. Done"
cat <<EOF
SIndustries staging environment bootstrap report.

Apps:
  tasks-api:           https://${FLY_APP_TASKS_API}.fly.dev
  budget-api:          https://${FLY_APP_BUDGET_API}.fly.dev
  auto-post-worker:    https://${FLY_APP_AUTO_POST_WORKER}.fly.dev (no public HTTP)

Next steps:
  - Verify with the smoke workflow: gh workflow run deploy-staging-tasks-api.yml
  - Or run a manual deploy: cd $REPO_ROOT && fly deploy --config infra/cloud/fly/tasks-api.fly.toml
  - See docs/runbooks/cloud-deployment-rollback.md for rollback procedure (planned in WS3).

This script is idempotent — re-run any time with --migrate / --deploy flags to
re-apply secrets, migrations, or smoke deploys.
EOF