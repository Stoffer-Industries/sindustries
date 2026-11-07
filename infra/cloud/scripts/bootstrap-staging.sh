#!/usr/bin/env bash
# bootstrap-staging.sh — one-time staging environment creation for SIndustries.
#
# Quinn-owned operational script. Runs LOCALLY only (never in CI). Idempotent:
# re-running does not destroy existing Fly apps; existing secret values are
# replaced via `fly secrets set` which is a no-op for unchanged values.
#
# STAGING IS ONE APP (task 219fb673; cutover 2026-11-07). The four
# per-service staging Fly apps — sindustries-tasks-api-staging,
# sindustries-budget-api-staging, sindustries-content-scheduler-api-staging
# and sindustries-auto-post-worker-staging — were destroyed at the cutover.
# Staging now runs the consolidated platform app
# (sindustries-platform-staging), which hosts all four services as
# supervisor children in ONE Fly process group.
#
# This script therefore bootstraps ONE app, and it must not create the
# retired per-service apps again: the platform's auto-post worker is a
# consumer of the same BullMQ queue as the retired worker app, so a
# resurrected per-service worker would process every scheduled post twice,
# silently, with no error anywhere.
#
# Inputs:
#   infra/cloud/.env.local  — Quinn-owned file with secret values. Never
#                             committed; .gitignore'd. The keys this script
#                             reads are listed under "Inputs" in the
#                             translation table below.
#                             Plus optional FLY_APP_PLATFORM / FLY_APP_ORG
#                             overrides.
#
# The .env.local keys are TRANSLATED into the source names the platform
# provisioner reads, and the provisioner owns the mapping from those
# sources to the app-level `PLATFORM_*` Fly secret names:
#
#   .env.local key                                     -> provisioner source
#   TASKS_API_DATABASE_URL                             -> STAGING_TASKS_API_DATABASE_URL
#   BUDGET_API_DATABASE_URL                            -> STAGING_BUDGET_API_DATABASE_URL
#   AUTO_POST_WORKER_DATABASE_URL                      -> STAGING_CONTENT_SCHEDULER_API_DATABASE_URL
#   HEALTH_PROBE_REDIS (or TASKS_API_CONTENT_SCHEDULER_REDIS_URL) -> HEALTH_PROBE_REDIS
#   TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN       -> TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
#   CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN -> CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
#
# There is ONE implementation of the `PLATFORM_*` mapping
# (infra/cloud/platform/platform-provision-secrets.mjs), and the CI path
# uses the same one, so a local bootstrap and a CI deploy cannot register
# different secrets on the same app.
#
# REDIS CAVEAT: the Redis source must be the LIVE staging instance. A URL
# pointing at a deleted instance still parses as a redis:// URL, so the
# provisioner's shape check passes; only the supervisor's first queue
# operation would fail. Verify the instance answers before bootstrapping.
#
# Steps (each guarded by a confirm prompt unless --yes is passed):
#   1. Pre-flight: `fly` CLI installed + authenticated, .env.local readable.
#   2. Create the platform Fly app if it is missing.
#   3. Register the app-level `PLATFORM_*` secrets through the platform
#      provisioner (which fails closed when a source is missing).
#   4. Prisma migrations for the three schemas. Skipped by default; pass
#      --migrate to enable. The platform's release_command runs the same
#      chain on every deploy, so this step is an operator convenience.
#   5. Smoke deploy (canary). Skipped by default; pass --deploy to enable.
#
# Output:
#   - Final report on stdout with the platform URL and the service routes.
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
#   infra/cloud/scripts/bootstrap-staging.sh --service platform --yes
#                                                          # the only service (default)
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

# The one staging app. Overridable, but it must be the consolidated
# platform app: the retired per-service apps must not be recreated.
FLY_APP_PLATFORM_DEFAULT="sindustries-platform-staging"
FLY_APP_ORG_DEFAULT="personal"

FLY_APP_PLATFORM="${FLY_APP_PLATFORM_DEFAULT}"
FLY_APP_ORG="${FLY_APP_ORG_DEFAULT}"

# The per-service staging apps that were destroyed at the cutover. They are
# listed so the script can refuse them with an explanation instead of
# failing with "app not found" half-way through.
RETIRED_SERVICES=(tasks-api budget-api content-scheduler-api auto-post-worker)

ASSUME_YES=0
RUN_MIGRATIONS=0
RUN_DEPLOY=0
ONLY_SERVICE="platform"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)             ASSUME_YES=1; shift ;;
    --migrate)         RUN_MIGRATIONS=1; shift ;;
    --deploy)          RUN_DEPLOY=1; shift ;;
    --service)         ONLY_SERVICE="${2:-}"; shift 2 ;;
    --env-local)       ENV_LOCAL="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,72p' "$0"
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

# The retired per-service apps cannot be bootstrapped any more.
for retired in "${RETIRED_SERVICES[@]}"; do
  if [[ "$ONLY_SERVICE" == "$retired" ]]; then
    fail "the per-service staging app for '$retired' was destroyed at the staging cutover (2026-11-07). Staging is one app now: the consolidated platform ($FLY_APP_PLATFORM_DEFAULT). Run without --service, or with --service platform." 1
  fi
done
if [[ -n "$ONLY_SERVICE" && "$ONLY_SERVICE" != "platform" ]]; then
  fail "unknown service '$ONLY_SERVICE' (the only service is 'platform')" 1
fi

if [[ ! -f "$ENV_LOCAL" ]]; then
  fail "Quinn-owned env file not found: $ENV_LOCAL
  Expected keys (see the translation table in this script's header):
    TASKS_API_DATABASE_URL, BUDGET_API_DATABASE_URL, AUTO_POST_WORKER_DATABASE_URL,
    HEALTH_PROBE_REDIS, TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN,
    CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
  Copy infra/cloud/env/platform.env.example as a starting point, fill in
  Quinn-owned values, re-run." 1
fi
# shellcheck disable=SC1090
source "$ENV_LOCAL"
ok ".env.local loaded"

# Override the Fly app / org if Quinn set them in .env.local.
[[ -n "${FLY_APP_PLATFORM:-}" ]] && FLY_APP_PLATFORM="$FLY_APP_PLATFORM"
[[ -n "${FLY_APP_ORG:-}" ]]     && FLY_APP_ORG="$FLY_APP_ORG"

info "Target Fly app:"
info "  platform:            $FLY_APP_PLATFORM (org $FLY_APP_ORG)"

# ---------- translate .env.local into the provisioner's source names ---------

hdr "2. Provisioning sources"

# The provisioner owns the mapping from source names to the app-level
# PLATFORM_* secret names, so this script only has to hand it the values
# under the names it reads. Nothing is printed: only names are echoed.
export STAGING_TASKS_API_DATABASE_URL="${TASKS_API_DATABASE_URL:-}"
export STAGING_BUDGET_API_DATABASE_URL="${BUDGET_API_DATABASE_URL:-}"
export STAGING_CONTENT_SCHEDULER_API_DATABASE_URL="${AUTO_POST_WORKER_DATABASE_URL:-${CONTENT_SCHEDULER_API_DATABASE_URL:-}}"
# The live staging Redis instance. HEALTH_PROBE_REDIS is the name the
# provisioner and the health probe both use; TASKS_API_CONTENT_SCHEDULER_REDIS_URL
# is the older local alias for the same instance.
export HEALTH_PROBE_REDIS="${HEALTH_PROBE_REDIS:-${TASKS_API_CONTENT_SCHEDULER_REDIS_URL:-}}"
export TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN="${TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN:-}"
export CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN="${CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN:-}"

missing_sources=()
[[ -z "${STAGING_TASKS_API_DATABASE_URL}" ]] && missing_sources+=("TASKS_API_DATABASE_URL")
[[ -z "${STAGING_BUDGET_API_DATABASE_URL}" ]] && missing_sources+=("BUDGET_API_DATABASE_URL")
[[ -z "${HEALTH_PROBE_REDIS}" ]] && missing_sources+=("HEALTH_PROBE_REDIS (or TASKS_API_CONTENT_SCHEDULER_REDIS_URL)")
[[ -z "${TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN}" ]] && missing_sources+=("TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN")
[[ -z "${CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN}" ]] && missing_sources+=("CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN")

if [[ ${#missing_sources[@]} -gt 0 ]]; then
  fail "missing source value(s) in $ENV_LOCAL: ${missing_sources[*]}.
  The platform provisioner fails closed on a missing source, so this script
  stops before touching Fly. Add the key(s) above to .env.local and re-run." 1
fi
ok "all provisioning sources present"

# ---------- Fly app creation ------------------------------------------------

create_app_if_missing() {
  local app="$1"
  local apps_json
  apps_json=$("$FLY" apps list --json 2>/dev/null) \
    || fail "unable to list Fly apps (is the fly CLI authenticated?)" 2
  # Exact-name match via python3 (the prior `grep -q "\"Name\":\"$app\""` form
  # is a substring match — an app named `$app-extra` would falsely match).
  # Fly's `apps list --json` schema uses `Name`; some sandboxed CLIs return
  # lowercase `name`. Tolerate both rather than coupling to one upstream.
  if APP_NAME="$app" python3 -c '
import json, os, sys
target = os.environ["APP_NAME"]
apps = json.load(sys.stdin)
sys.exit(0 if any((a.get("Name") or a.get("name")) == target for a in apps) else 1)
' <<<"$apps_json"; then
    ok "app exists: $app"
    return 0
  fi
  info "creating app: $app"
  # `fly apps create --app <name>` is rejected by current fly releases; the
  # accepted form is positional. `--yes` is required for non-interactive use.
  "$FLY" apps create "$app" --org "$FLY_APP_ORG" --yes >/dev/null
  ok "created app: $app"
}

hdr "3. Fly app"

create_app_if_missing "$FLY_APP_PLATFORM"

# ---------- Fly secrets -----------------------------------------------------

hdr "4. Fly secrets"

info "registering the platform app-level PLATFORM_* secrets via the platform provisioner"
# The provisioner is the single implementation of the mapping from source
# names to the app-level PLATFORM_* secret names (and the single
# implementation of the detached, direct secret write). It never prints a
# secret value.
if ! node "${REPO_ROOT}/infra/cloud/platform/platform-provision-secrets.mjs" \
      --app "$FLY_APP_PLATFORM" --org "$FLY_APP_ORG"; then
  fail "the platform provisioner failed; secrets were not registered. See the error above for the missing source." 2
fi
ok "platform secrets registered: $FLY_APP_PLATFORM"

# ---------- migrations ------------------------------------------------------

hdr "5. Prisma migrations"

if [[ "$RUN_MIGRATIONS" -eq 0 ]]; then
  info "skipped (pass --migrate to enable; will prompt before applying)"
fi

if [[ "$RUN_MIGRATIONS" -eq 1 ]]; then
  confirm "Apply the platform Prisma migrations (tasks-api, budget-api, content-scheduler schemas)?"
  # The platform's release_command runs the same chain on every deploy
  # (infra/cloud/platform/platform-migrate.mjs), so this step is a
  # convenience for an operator who wants the schemas applied before the
  # first deploy. It reads the three PLATFORM_*_DATABASE_URL values.
  export PLATFORM_TASKS_API_DATABASE_URL="${STAGING_TASKS_API_DATABASE_URL}"
  export PLATFORM_BUDGET_API_DATABASE_URL="${STAGING_BUDGET_API_DATABASE_URL}"
  export PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL="${STAGING_CONTENT_SCHEDULER_API_DATABASE_URL}"
  cd "$REPO_ROOT"
  node infra/cloud/platform/platform-migrate.mjs \
    || fail "platform migrations failed" 3
  ok "migrations applied"
fi

# ---------- smoke deploy ----------------------------------------------------

hdr "6. Smoke deploy"
if [[ "$RUN_DEPLOY" -eq 0 ]]; then
  info "skipped (pass --deploy to enable; will prompt before deploying)"
fi

if [[ "$RUN_DEPLOY" -eq 1 ]]; then
  # The CI path gates the platform deploy on the same variable
  # (.github/workflows/deploy-staging-platform.yml), so the operator path
  # and the CI path cannot disagree about whether a staging deploy may run.
  if [[ "${STAGING_PLATFORM_DEPLOY_ENABLED:-}" != "true" ]]; then
    fail "the staging platform deploy is opt-in: set STAGING_PLATFORM_DEPLOY_ENABLED=true. Staging runs the consolidated platform app only; see docs/systems/cloud-platform.md." 1
  fi
  cd "$REPO_ROOT"
  confirm "Run the canary deploy of the consolidated platform?"
  info "deploying $FLY_APP_PLATFORM"
  "$FLY" deploy --config infra/cloud/fly/platform.fly.toml --strategy canary --wait-timeout 600 \
    || fail "canary deploy failed: platform" 4
  ok "deployed: $FLY_APP_PLATFORM"
fi

# ---------- final report ----------------------------------------------------

hdr "7. Done"
cat <<EOF
SIndustries staging environment bootstrap report.

App:
  platform:            https://${FLY_APP_PLATFORM}.fly.dev

Service routes (path-prefix on the platform host until the stable hostnames
resolve — task 5cb4a8fe):
  tasks-api:           https://${FLY_APP_PLATFORM}.fly.dev/tasks-api/health
  budget-api:          https://${FLY_APP_PLATFORM}.fly.dev/budget-api/health
  content-scheduler:   https://${FLY_APP_PLATFORM}.fly.dev/content-scheduler-api/health
  auto-post-worker:    no public HTTP (BullMQ consumer; see the supervisor status)

Supervisor status (per-child state):
  https://${FLY_APP_PLATFORM}.fly.dev/__status

Next steps:
  - Verify with the smoke workflow: gh workflow run deploy-staging-platform.yml
  - Or run a manual deploy: cd $REPO_ROOT && fly deploy --config infra/cloud/fly/platform.fly.toml
  - See docs/runbooks/platform-consolidation-rollback.md for the rollback procedure
    and docs/systems/cloud-platform.md for the topology and the shared-fate warning.

This script is idempotent — re-run any time with --migrate / --deploy flags to
re-apply secrets, migrations, or smoke deploys.
EOF
