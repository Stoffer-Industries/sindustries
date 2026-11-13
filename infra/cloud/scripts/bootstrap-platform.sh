#!/usr/bin/env bash
# bootstrap-platform.sh — environment-aware bootstrap for the consolidated
# SIndustries platform (task fb1240c0, Slice B).
#
# ONE IMPLEMENTATION, TWO ENVIRONMENTS
# -----------------------------------
# The consolidated platform is ONE Fly app per environment, hosting every
# service as a supervisor child in ONE process group:
#
#   staging    -> sindustries-platform-staging
#   production -> sindustries-platform-production
#
# Before this script existed, the staging path was `bootstrap-staging.sh`
# with the app name, the source names and the deploy gate hard-coded in
# it. A production bootstrap could only have been a second copy of those
# facts, and a copy is exactly what drifts: a production app provisioned
# from staging source names looks healthy and is not.
#
# So the environment facts live in ONE place — the environment manifest
# (infra/cloud/platform/platform-environments.mjs) — and this script reads
# them through a read-only projection for shell callers
# (infra/cloud/platform/platform-environment-facts.mjs). This script holds
# no environment facts of its own: the app name, the source names, the
# required sources and the deploy gate all come from the manifest.
#
# The entry points are thin wrappers over this script:
#
#   infra/cloud/scripts/bootstrap-staging.sh    -> --environment staging
#   infra/cloud/scripts/bootstrap-production.sh -> --environment production
#
# WHAT THIS SCRIPT DOES (and does not)
# -------------------------------------
# It is the LOCAL operator path. It never writes secrets itself: the
# platform provisioner (infra/cloud/platform/platform-provision-secrets.mjs)
# owns the mapping from source names to the app-level `PLATFORM_*` secret
# names, so a local bootstrap and a CI deploy can never register different
# secrets on the same app.
#
# Steps (each guarded by a confirm prompt unless --yes is passed):
#   1. Pre-flight: fly CLI installed + authenticated, env file readable,
#      the target app is the environment's own platform app.
#   2. Register the environment's source values under the source names the
#      provisioner reads. Missing required sources fail BEFORE any Fly
#      call.
#   3. Create the platform Fly app if it is missing.
#   4. Register the app-level `PLATFORM_*` secrets through the platform
#      provisioner (which fails closed when a source is missing).
#   5. Prisma migrations for the three schemas. Skipped by default; pass
#      --migrate to enable AND set the environment's migrations gate
#      variable to `true` — migrations change the database, so they carry
#      their own gate.
#   6. Deploy (canary). Skipped by default; pass --deploy to enable, and
#      the environment's deploy gate variable must be `true`.
#
# IDEMPOTENCE
# -----------
# Re-running does not destroy anything: an existing app is reused, and
# `fly secrets set` replaces only the app-level secret values. The
# migrations and the deploy are opt-in.
#
# Inputs:
#   The environment's local env file (default
#   infra/cloud/.env.local for staging, infra/cloud/.env.production.local
#   for production). Never committed; gitignored. The keys this script
#   reads are listed under "THE EXACT SOURCE CONTRACT" in
#   infra/cloud/env/bootstrap-<environment>.env.example.
#
#   THE ENV FILE IS PARSED, NEVER SOURCED
#   -------------------------------------
#   The env file contributes the SOURCE KEYS and the Fly org, and nothing
#   else. It is read with an allow-list rather than `source`d into this
#   script's shell, because a sourced file can rewrite the script's own
#   control variables: the environment, the target app, the deploy gate
#   and the environment facts are all resolved from the manifest BEFORE
#   the file is read and are `readonly` afterwards. A copy of the staging
#   env file therefore cannot point the production bootstrap at staging.
#
#   The .env.local keys are TRANSLATED into the source names the platform
#   provisioner reads, and the provisioner owns the mapping from those
#   sources to the app-level `PLATFORM_*` Fly secret names:
#
#   .env.local key                                     -> provisioner source
#   TASKS_API_DATABASE_URL                             -> <env>_TASKS_API_DATABASE_URL
#   BUDGET_API_DATABASE_URL                            -> <env>_BUDGET_API_DATABASE_URL
#   AUTO_POST_WORKER_DATABASE_URL                      -> <env>_CONTENT_SCHEDULER_API_DATABASE_URL
#   HEALTH_PROBE_REDIS (or TASKS_API_CONTENT_SCHEDULER_REDIS_URL) -> <env>_HEALTH_PROBE_REDIS
#   TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN       -> <env>_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
#   CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN -> <env>_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
#
# The exact source names are the manifest's; the table above is the
# LOCAL key -> manifest source KEY mapping and is identical for both
# environments.
#
# REDIS CAVEAT: the Redis source must be the LIVE instance of that
# environment. A URL pointing at a deleted instance still parses as a
# redis:// URL, so the provisioner's shape check passes; only the
# supervisor's first queue operation would fail. Verify the instance
# answers before bootstrapping.
#
# Usage:
#   infra/cloud/scripts/bootstrap-platform.sh --environment staging
#   infra/cloud/scripts/bootstrap-platform.sh --environment production --yes
#   infra/cloud/scripts/bootstrap-platform.sh --environment production --yes --migrate --deploy
#
# Exit codes:
#   0 = success
#   1 = pre-flight failure (missing CLI / missing env file / missing source values)
#   2 = Fly API failure (auth, quota, app-create collision that we can't recover)
#   3 = migration failure
#   4 = smoke-deploy failure

set -euo pipefail

# ---------- defaults / arg parsing -----------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FACTS_CLI="${REPO_ROOT}/infra/cloud/platform/platform-environment-facts.mjs"

ENVIRONMENT="staging"
ENV_LOCAL=""
FLY_APP_ORG=""
ASSUME_YES=0
RUN_MIGRATIONS=0
RUN_DEPLOY=0
ONLY_SERVICE="platform"

# The per-service apps that must never be created. In staging they were
# destroyed at the 2026-11-07 cutover; in production they were never
# created. Either way the platform is one app, and a resurrected
# per-service auto-post worker would put two consumers on one BullMQ
# queue — every scheduled post processed twice, silently, with no error
# anywhere.
RETIRED_SERVICES=(tasks-api budget-api content-scheduler-api auto-post-worker)

# The LOCAL env-file key -> manifest source KEY mapping. The manifest owns
# the source NAME; this table only says which local key feeds it.
LOCAL_SOURCE_MAP=(
  "TASKS_API_DATABASE_URL:tasksDatabaseUrl"
  "BUDGET_API_DATABASE_URL:budgetDatabaseUrl"
  "AUTO_POST_WORKER_DATABASE_URL:contentSchedulerDatabaseUrl"
  "CONTENT_SCHEDULER_API_DATABASE_URL:contentSchedulerDatabaseUrl"
  "HEALTH_PROBE_REDIS:redisUrl"
  "TASKS_API_CONTENT_SCHEDULER_REDIS_URL:redisUrl"
  "TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN:tasksApprovalToken"
  "CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN:schedulerApprovalToken"
)

usage() {
  sed -n '2,110p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)    ENVIRONMENT="${2:-}"; shift 2 ;;
    --yes)            ASSUME_YES=1; shift ;;
    --migrate)        RUN_MIGRATIONS=1; shift ;;
    --deploy)         RUN_DEPLOY=1; shift ;;
    --service)        ONLY_SERVICE="${2:-}"; shift 2 ;;
    --env-local)      ENV_LOCAL="${2:-}"; shift 2 ;;
    --org)            FLY_APP_ORG="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
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

info() { printf '%s[INFO]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%s[FAIL]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit "${2:-1}"; }
hdr()  { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

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

# ---------- environment facts -----------------------------------------------

hdr "0. Environment facts"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found in PATH. The environment manifest is a Node module; the bootstrap reads it through infra/cloud/platform/platform-environment-facts.mjs." 1
fi

# The manifest is the source of truth for the app name, the source names,
# the required sources and the deploy gate. Nothing below hard-codes an
# environment fact.
if ! PLATFORM_ENV_FACTS="$(node "$FACTS_CLI" --environment "$ENVIRONMENT" 2>&1)"; then
  fail "could not read the environment facts for '$ENVIRONMENT':
$PLATFORM_ENV_FACTS" 1
fi
export PLATFORM_ENV_FACTS

fact() {
  node -e '
const facts = JSON.parse(process.env.PLATFORM_ENV_FACTS);
const value = process.argv[1].split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), facts);
if (value === undefined || value === null) process.exit(3);
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
' "$1" || fail "could not read the environment fact '$1'" 1
}

PLATFORM_APP="$(fact platformApp)"
HEALTH_PROBE_APP="$(fact healthProbeApp)"
DEPLOY_GATE_VARIABLE="$(fact deployGateVariable)"
MIGRATIONS_GATE_VARIABLE="$(fact migrationsGateVariable)"
FLY_ORG_VARIABLE="$(fact flyOrgVariable)"
DEFAULT_FLY_ORG="$(fact defaultFlyOrg)"
ENV_LOCAL_DEFAULT="$(fact artefacts.envFile)"
FLY_CONFIG_SHARED="$(fact artefacts.flyConfig.shared)"
FLY_CONFIG_OVERLAY="$(fact artefacts.flyConfig.overlay || true)"
FLY_CONFIG_RENDERED="$(fact artefacts.flyConfig.rendered)"

# The required source KEYS are a JSON array; re-read them one by one.
# The node exit status is CHECKED: a failed read used to yield an EMPTY
# list, and an empty required-source list reads as "nothing is required"
# — the opposite of failing closed.
REQUIRED_SOURCE_KEYS=()
if ! REQUIRED_SOURCE_KEYS_TEXT="$(node -e '
const facts = JSON.parse(process.env.PLATFORM_ENV_FACTS);
for (const key of facts.requiredSourceKeys) process.stdout.write(`${key}\n`);
')"; then
  fail "could not read the required source keys for '$ENVIRONMENT' from the environment manifest." 1
fi
while IFS= read -r required_source_key; do
  [[ -n "$required_source_key" ]] || continue
  REQUIRED_SOURCE_KEYS+=("$required_source_key")
done <<<"$REQUIRED_SOURCE_KEYS_TEXT"
if [[ ${#REQUIRED_SOURCE_KEYS[@]} -eq 0 ]]; then
  fail "the environment manifest lists no required sources for '$ENVIRONMENT' — refusing to continue with an empty required-source list." 1
fi

# The control variables are resolved from the manifest and are READONLY
# from here on. The operator's env file is parsed BELOW with an
# allow-list, so nothing it says can change the environment, the app, the
# gates or the facts.
readonly ENVIRONMENT PLATFORM_APP HEALTH_PROBE_APP DEPLOY_GATE_VARIABLE \
  MIGRATIONS_GATE_VARIABLE FLY_ORG_VARIABLE PLATFORM_ENV_FACTS

ok "environment: $ENVIRONMENT"
info "  platform app:      $PLATFORM_APP"
info "  health-probe app:  $HEALTH_PROBE_APP"
info "  deploy gate:       $DEPLOY_GATE_VARIABLE=true"

# ---------- pre-flight ------------------------------------------------------

hdr "1. Pre-flight"

if [[ -z "$ENV_LOCAL" ]]; then
  ENV_LOCAL="${REPO_ROOT}/${ENV_LOCAL_DEFAULT}"
fi

if [[ ! -f "$ENV_LOCAL" ]]; then
  fail "env file not found: $ENV_LOCAL
  Required source keys (this script translates them into the provisioner's
  source names — see the translation table in this script's header):
    TASKS_API_DATABASE_URL
    BUDGET_API_DATABASE_URL
    AUTO_POST_WORKER_DATABASE_URL
    HEALTH_PROBE_REDIS            (or TASKS_API_CONTENT_SCHEDULER_REDIS_URL)
    TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
    CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN
  Copy infra/cloud/env/bootstrap-${ENVIRONMENT}.env.example as a starting point,
  fill in the values, re-run." 1
fi
# The env file is PARSED with an allow-list. It is never `source`d.
#
# It used to be sourced straight into this script's shell, and every
# control variable — ENVIRONMENT, PLATFORM_APP, DEPLOY_GATE_VARIABLE,
# PLATFORM_ENV_FACTS — was read AFTER the source. A copy of the staging
# env file could therefore rewrite them, and the app-name guard compared
# two env-file-controlled values with each other, so it could not fail:
# the production bootstrap would create the STAGING app and satisfy the
# STAGING deploy gate. The allow-list takes the file's SOURCE KEYS and
# nothing else; the environment, the app, the gates and the facts are
# the manifest's.
ENV_FILE_VALUES="$(mktemp)"
trap 'rm -f "$ENV_FILE_VALUES"' EXIT

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$line" || "$line" == '#'* ]] && continue
  [[ "$line" == export\ * ]] && line="${line#export }"
  [[ "$line" == *=* ]] || continue
  file_key="${line%%=*}"
  file_value="${line#*=}"
  file_key="${file_key%"${file_key##*[![:space:]]}"}"
  file_value="${file_value#"${file_value%%[![:space:]]*}"}"
  # Strip a matching pair of surrounding quotes. An unquoted value may
  # carry a trailing comment.
  if [[ ${#file_value} -ge 2 && "${file_value:0:1}" == "'" && "${file_value: -1}" == "'" ]]; then
    file_value="${file_value:1:${#file_value}-2}"
  elif [[ ${#file_value} -ge 2 && "${file_value:0:1}" == '"' && "${file_value: -1}" == '"' ]]; then
    file_value="${file_value:1:${#file_value}-2}"
  else
    file_value="${file_value%% #*}"
  fi
  printf '%s=%s\n' "$file_key" "$file_value" >>"$ENV_FILE_VALUES"
done <"$ENV_LOCAL"

# Only the source keys and the Fly org are taken from the file.
ENV_FILE_ALLOWED_KEYS=()
for pair in "${LOCAL_SOURCE_MAP[@]}"; do
  ENV_FILE_ALLOWED_KEYS+=("${pair%%:*}")
done
ENV_FILE_ALLOWED_KEYS+=("FLY_APP_ORG" "$FLY_ORG_VARIABLE")

ENV_FILE_FLY_APP_PLATFORM=""
ENV_FILE_FLY_APP_ORG=""
while IFS='=' read -r file_key file_value; do
  [[ -n "$file_key" ]] || continue
  case "$file_key" in
    FLY_APP_PLATFORM)
      # Captured, never applied: the target app is the manifest's.
      ENV_FILE_FLY_APP_PLATFORM="$file_value"
      continue
      ;;
    FLY_APP_ORG)
      ENV_FILE_FLY_APP_ORG="$file_value"
      continue
      ;;
  esac
  case " ${ENV_FILE_ALLOWED_KEYS[*]} " in
    *" $file_key "*) printf -v "$file_key" '%s' "$file_value" ;;
  esac
done <"$ENV_FILE_VALUES"

ok "env file parsed (allow-listed source keys only; the file cannot choose the environment, the app or the gates)"

# The Fly org may be named by the env file or by the environment variable
# the manifest names; the APP NAME may not.
if [[ -z "$FLY_APP_ORG" ]]; then
  FLY_APP_ORG="${!FLY_ORG_VARIABLE:-}"
fi
if [[ -z "$FLY_APP_ORG" ]]; then
  FLY_APP_ORG="$(node -e '
const facts = JSON.parse(process.env.PLATFORM_ENV_FACTS);
process.stdout.write(process.env[facts.flyOrgVariable] || "");
')"
fi
if [[ -z "$FLY_APP_ORG" ]]; then
  FLY_APP_ORG="$ENV_FILE_FLY_APP_ORG"
fi
if [[ -z "$FLY_APP_ORG" ]]; then
  FLY_APP_ORG="$DEFAULT_FLY_ORG"
fi

# The target is NOT free-form. The environment is ONE app: the per-service
# apps must not be created (in staging they were destroyed at the
# 2026-11-07 cutover; in production they were never created), and a
# resurrected per-service auto-post worker would put two consumers on one
# BullMQ queue. The org may be overridden; the app name may not.
#
# The comparison is against the MANIFEST's app name — not against another
# env-file-controlled value — so a stale FLY_APP_PLATFORM in the env file
# fails the bootstrap instead of silently retargeting it.
for candidate_app in "${FLY_APP_PLATFORM:-}" "$ENV_FILE_FLY_APP_PLATFORM"; do
  [[ -n "$candidate_app" ]] || continue
  if [[ "$candidate_app" != "$PLATFORM_APP" ]]; then
    fail "refusing to bootstrap Fly app '$candidate_app': $ENVIRONMENT is one app ($PLATFORM_APP). The retired per-service apps must not be recreated. Remove FLY_APP_PLATFORM from $ENV_LOCAL." 1
  fi
done
FLY_APP_PLATFORM="$PLATFORM_APP"
readonly FLY_APP_PLATFORM

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

# The retired per-service apps cannot be bootstrapped in any environment.
for retired in "${RETIRED_SERVICES[@]}"; do
  if [[ "$ONLY_SERVICE" == "$retired" ]]; then
    if [[ "$ENVIRONMENT" == "staging" ]]; then
      fail "the per-service staging app for '$retired' was destroyed at the staging cutover (2026-11-07). Staging is one app now: the consolidated platform ($PLATFORM_APP). Run without --service, or with --service platform." 1
    fi
    fail "the per-service app for '$retired' is not created in $ENVIRONMENT: production is one consolidated app ($PLATFORM_APP). Run without --service, or with --service platform." 1
  fi
done
if [[ -n "$ONLY_SERVICE" && "$ONLY_SERVICE" != "platform" ]]; then
  fail "unknown service '$ONLY_SERVICE' (the only service is 'platform')" 1
fi

info "Target Fly app:"
info "  platform:            $FLY_APP_PLATFORM (org $FLY_APP_ORG)"

# ---------- translate the env file into the provisioner's source names -------

hdr "2. Provisioning sources"

# The provisioner owns the mapping from source names to the app-level
# PLATFORM_* secret names, so this script only has to hand it the values
# under the names it reads. Nothing is printed: only names are echoed.
local_key_for_source_key() {
  local source_key="$1" pair local_key
  for pair in "${LOCAL_SOURCE_MAP[@]}"; do
    local_key="${pair%%:*}"
    [[ "${pair##*:}" == "$source_key" ]] || continue
    if [[ -n "${!local_key:-}" ]]; then
      printf '%s' "$local_key"
      return 0
    fi
  done
  return 1
}

# The first local key with a value wins: the documented aliases are
# fallbacks. The exported set is tracked by source KEY, not by whether the
# source-name variable happens to be set — in staging some source names are
# identical to the local key (HEALTH_PROBE_REDIS), and the env file only
# sets a shell variable, so an unset-in-the-environment source must still
# be exported explicitly.
EXPORTED_SOURCE_KEYS=""
for pair in "${LOCAL_SOURCE_MAP[@]}"; do
  local_key="${pair%%:*}"
  source_key="${pair##*:}"
  value="${!local_key:-}"
  [[ -n "$value" ]] || continue
  case " $EXPORTED_SOURCE_KEYS " in
    *" $source_key "*) continue ;;
  esac
  source_name="$(fact "sourceNames.$source_key")"
  export "$source_name=$value"
  EXPORTED_SOURCE_KEYS="$EXPORTED_SOURCE_KEYS $source_key"
done

missing_sources=()
for source_key in "${REQUIRED_SOURCE_KEYS[@]}"; do
  [[ -n "$source_key" ]] || continue
  if ! local_key_for_source_key "$source_key" >/dev/null; then
    missing_sources+=("$(fact "sourceNames.$source_key")")
  fi
done

if [[ ${#missing_sources[@]} -gt 0 ]]; then
  fail "missing source value(s) in $ENV_LOCAL: ${missing_sources[*]}.
  The platform provisioner fails closed on a missing source, so this script
  stops before touching Fly. Add the key(s) above to $ENV_LOCAL and re-run." 1
fi
ok "all provisioning sources present"

# Validate the payload BEFORE any Fly mutation. The provisioner refuses a
# payload that carries a staging/dev marker, a placeholder or a loopback
# address; the dry run performs exactly that check without touching Fly
# (it prints secret NAMES only, never values). A production bootstrap that
# still holds a staging value must fail before it creates anything.
if ! node "${REPO_ROOT}/infra/cloud/platform/platform-provision-secrets.mjs" \
      --environment "$ENVIRONMENT" --app "$FLY_APP_PLATFORM" --org "$FLY_APP_ORG" --dry-run >/dev/null; then
  fail "the $ENVIRONMENT payload failed the provisioner's validation; nothing was created and no secret was written. See the error above." 1
fi
ok "payload validated (no Fly calls yet)"

# ---------- Fly app creation ------------------------------------------------

create_app_if_missing() {
  local app="$1"
  local apps_json
  apps_json=$("$FLY" apps list --json --org "$FLY_APP_ORG" 2>/dev/null) \
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
# secret value. The environment is passed explicitly so the provisioner
# reads THIS environment's source names and refuses any other app.
if ! node "${REPO_ROOT}/infra/cloud/platform/platform-provision-secrets.mjs" \
      --environment "$ENVIRONMENT" --app "$FLY_APP_PLATFORM" --org "$FLY_APP_ORG"; then
  fail "the platform provisioner failed; secrets were not registered. See the error above for the missing source." 2
fi
ok "platform secrets registered: $FLY_APP_PLATFORM"

# ---------- migrations ------------------------------------------------------

hdr "5. Prisma migrations"

if [[ "$RUN_MIGRATIONS" -eq 0 ]]; then
  info "skipped (pass --migrate to enable; will prompt before applying)"
fi

if [[ "$RUN_MIGRATIONS" -eq 1 ]]; then
  # Migrations change the DATABASE, not the app, so they carry their own
  # gate: `--migrate` alone is not consent to run schema changes against
  # a production database.
  if [[ "${!MIGRATIONS_GATE_VARIABLE:-}" != "true" ]]; then
    fail "the $ENVIRONMENT schema migrations are opt-in: set $MIGRATIONS_GATE_VARIABLE=true. Migrations change the database, so they carry their own gate." 1
  fi
  confirm "Apply the platform Prisma migrations (tasks-api, budget-api, content-scheduler schemas)?"
  # The platform's release_command runs the same chain on every deploy
  # (infra/cloud/platform/platform-migrate.mjs), so this step is a
  # convenience for an operator who wants the schemas applied before the
  # first deploy. It reads the three PLATFORM_*_DATABASE_URL values.
  tasks_source_name="$(fact sourceNames.tasksDatabaseUrl)"
  budget_source_name="$(fact sourceNames.budgetDatabaseUrl)"
  scheduler_source_name="$(fact sourceNames.contentSchedulerDatabaseUrl)"
  export PLATFORM_TASKS_API_DATABASE_URL="${!tasks_source_name:-}"
  export PLATFORM_BUDGET_API_DATABASE_URL="${!budget_source_name:-}"
  export PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL="${!scheduler_source_name:-}"
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
  # and the CI path cannot disagree about whether a deploy may run.
  if [[ "${!DEPLOY_GATE_VARIABLE:-}" != "true" ]]; then
    fail "the $ENVIRONMENT platform deploy is opt-in: set $DEPLOY_GATE_VARIABLE=true. The $ENVIRONMENT platform runs the consolidated platform app only; see docs/systems/cloud-platform.md." 1
  fi
  cd "$REPO_ROOT"
  # The effective config is the shared config plus the environment overlay.
  # The rendered file is written next to the shared config because Fly
  # resolves the relative build paths against the config file's directory.
  deploy_config="$FLY_CONFIG_SHARED"
  if [[ -n "$FLY_CONFIG_OVERLAY" ]]; then
    node infra/cloud/platform/render-fly-config.mjs \
      --shared "$FLY_CONFIG_SHARED" \
      --overlay "$FLY_CONFIG_OVERLAY" \
      --out "$FLY_CONFIG_RENDERED" \
      --environment "$ENVIRONMENT" \
      || fail "could not render the $ENVIRONMENT Fly config from $FLY_CONFIG_OVERLAY" 1
    deploy_config="$FLY_CONFIG_RENDERED"
  fi
  confirm "Run the canary deploy of the consolidated $ENVIRONMENT platform?"
  info "deploying $FLY_APP_PLATFORM ($deploy_config)"
  # The app name is passed EXPLICITLY as well as carried by the rendered
  # config. The rendered config's `app` comes from the overlay, and the
  # renderer refuses an overlay that names another environment's app —
  # but naming the target here means a stale or hand-edited rendered
  # file cannot send the deploy to a different app either.
  "$FLY" deploy --app "$FLY_APP_PLATFORM" --config "$deploy_config" --strategy canary --wait-timeout 600 \
    || fail "canary deploy failed: platform" 4
  ok "deployed: $FLY_APP_PLATFORM"
fi

# ---------- final report ----------------------------------------------------

hdr "7. Done"
cat <<EOF
SIndustries $ENVIRONMENT environment bootstrap report.

App:
  platform:            https://${FLY_APP_PLATFORM}.fly.dev
  health probe:        $HEALTH_PROBE_APP

Service routes (path-prefix on the platform host until the stable hostnames
resolve — task 5cb4a8fe):
  tasks-api:           https://${FLY_APP_PLATFORM}.fly.dev/tasks-api/health
  budget-api:          https://${FLY_APP_PLATFORM}.fly.dev/budget-api/health
  content-scheduler:   https://${FLY_APP_PLATFORM}.fly.dev/content-scheduler-api/health
  auto-post-worker:    no public HTTP (BullMQ consumer; see the supervisor status)

Supervisor status (per-child state):
  https://${FLY_APP_PLATFORM}.fly.dev/__status

Next steps:
  - Deploy gate: $DEPLOY_GATE_VARIABLE=true before any deploy of this environment.
  - See docs/systems/cloud-platform.md for the topology and the shared-fate warning.
  - See docs/cloud/production-source-contract.md for the source contract when
    bootstrapping production.

This script is idempotent — re-run any time with --migrate / --deploy flags to
re-apply secrets, migrations, or smoke deploys.
EOF
