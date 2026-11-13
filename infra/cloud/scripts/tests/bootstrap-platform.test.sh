#!/usr/bin/env bash
# bootstrap-platform.test.sh — contract tests for the shared, environment-aware
# bootstrap (task fb1240c0, Slice B).
#
# The staging bootstrap has its own regression guard
# (bootstrap-staging.test.sh). This file covers the PRODUCTION path and the
# shared behaviour that the production path adds:
#
#   1. The production app name comes from the ENVIRONMENT MANIFEST, not from
#      a copy in the script: the app is created as
#      `sindustries-platform-production`, and it is created only when it is
#      absent.
#   2. The production secrets are registered through the SHARED provisioner
#      (`secrets set --app sindustries-platform-production --detach`), which
#      is the only implementation of the source -> PLATFORM_* mapping.
#   3. A production value that still carries a staging marker is REFUSED
#      before anything is created or written. The provisioner owns that
#      separation guard; the bootstrap runs it in --dry-run mode BEFORE the
#      app creation, so a bad payload cannot even create an app.
#   4. A missing production source is refused before anything is created or
#      written, and the missing PRODUCTION source name is named on stderr.
#   5. The deploy is opt-in twice over: the operator must pass --deploy AND
#      the environment's deploy gate variable must be `true`. The deployed
#      config is the RENDERED production config, not the shared staging one.
#   6. The deploy gate name is derived from the environment id, and the
#      derivation still agrees with the variable the staging deploy workflow
#      gates on.
#   7. The published production example file satisfies the source contract:
#      the documented first-time path works.
#
# No real secret value appears in this file: every fixture is obviously fake.
#
# Run:
#   bash infra/cloud/scripts/tests/bootstrap-platform.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
PRODUCTION_SCRIPT="$REPO_ROOT/infra/cloud/scripts/bootstrap-production.sh"
SHARED_SCRIPT="$REPO_ROOT/infra/cloud/scripts/bootstrap-platform.sh"
FACTS_CLI="$REPO_ROOT/infra/cloud/platform/platform-environment-facts.mjs"
[[ -f "$PRODUCTION_SCRIPT" ]] || { echo "FAIL: $PRODUCTION_SCRIPT not found (REPO_ROOT=$REPO_ROOT)"; exit 1; }
[[ -f "$SHARED_SCRIPT" ]] || { echo "FAIL: $SHARED_SCRIPT not found"; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$REPO_ROOT/infra/cloud/fly/platform.production.fly.toml"' EXIT

# ---------- stub flyctl -----------------------------------------------------

mkdir -p "$TMP/bin"
cat >"$TMP/bin/flyctl" <<'STUB'
#!/usr/bin/env bash
# Record the argv, but never a secret VALUE: the `secrets set` payload is
# redacted to the secret names so a failing assertion can never print one.
case "$1 $2" in
  "secrets set")
    names=()
    for arg in "$@"; do
      case "$arg" in
        *=*) names+=("${arg%%=*}=<redacted>") ;;
        *)   names+=("$arg") ;;
      esac
    done
    printf 'INVOKED: %s\n' "${names[*]}" >>"$FLY_LOG"
    for arg in "$@"; do
      case "$arg" in
        --detach|--app) continue ;;
        *=*) printf '%s\n' "${arg%%=*}" >>"$FLY_REGISTERED" ;;
      esac
    done
    exit 0
    ;;
esac
printf 'INVOKED: %s\n' "$*" >>"$FLY_LOG"
case "$1 $2" in
  "auth whoami")          exit 0 ;;
  "apps list")
    printf '%s' "${FLY_LIST_JSON:-[]}"
    ;;
  "apps create")         exit 0 ;;
  "secrets list")
    printf '['
    first=1
    if [[ -f "${FLY_REGISTERED:-}" ]]; then
      while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        if [[ "$first" -eq 1 ]]; then first=0; else printf ','; fi
        printf '{"Name":"%s"}' "$name"
      done <"$FLY_REGISTERED"
    fi
    printf ']'
    ;;
  *)                     exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# ---------- the production env file ----------------------------------------
#
# The values must NOT look like staging, dev or localhost: the production
# separation guard refuses those, and this file exercises the happy path.

write_env() {
  local out="$1" tasks_url="${2:-postgres://stub:***@db.example-neon.tech:5432/prod}"
  cat >"$out" <<ENV
TASKS_API_DATABASE_URL=$tasks_url
BUDGET_API_DATABASE_URL=$tasks_url
AUTO_POST_WORKER_DATABASE_URL=$tasks_url
HEALTH_PROBE_REDIS=rediss://:stub@prod-example.upstash.io:6379
TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-tasks-token
CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-scheduler-token
ENV
}

write_env "$TMP/.env.production.local"

# A variant whose tasks DSN still points at staging: the whole payload must
# be refused before anything is created.
write_env "$TMP/.env.production.staging" \
  "postgres://stub:***@db.staging.sindustries.co.nz:5432/prod"

# A variant with the Redis source missing.
grep -v '^HEALTH_PROBE_REDIS=' "$TMP/.env.production.local" >"$TMP/.env.production.noredis"

run_production() {
  local label="$1" env_file="$2"
  shift 2
  rm -f "$TMP/registered.${label}"
  FLY_LOG="$TMP/fly.${label}.log" \
  FLY_REGISTERED="$TMP/registered.${label}" \
  FLY_LIST_JSON="${FLY_LIST_JSON_OVERRIDE:-[]}" \
  PATH="$TMP/bin:$PATH" \
    bash "$PRODUCTION_SCRIPT" --yes --env-local "$env_file" "$@" \
      >"$TMP/out.${label}" 2>"$TMP/err.${label}" \
      || true
}

assert_no_fly_mutation() {
  local log="$1" label="$2"
  if grep -qE '^INVOKED: (apps create|secrets set)' "$log" 2>/dev/null; then
    echo "FAIL: $label — the script must refuse BEFORE it creates an app or writes a secret" >&2
    sed 's/^/  /' "$log" >&2
    exit 1
  fi
}

# ---------- case 1: the production app is created when it is absent ---------

run_production "create" "$TMP/.env.production.local"
if ! grep -qF "INVOKED: apps create sindustries-platform-production --org personal --yes" "$TMP/fly.create.log"; then
  echo "FAIL: case=create — expected the production app to be created" >&2
  sed 's/^/  /' "$TMP/fly.create.log" >&2
  exit 1
fi
if grep -qE 'INVOKED: apps create --app' "$TMP/fly.create.log"; then
  echo "FAIL: case=create — used the deprecated '--app' flag" >&2
  exit 1
fi

# ---------- case 2: the secrets go through the shared provisioner ----------

if ! grep -qF 'INVOKED: secrets set --app sindustries-platform-production --detach' "$TMP/fly.create.log"; then
  echo "FAIL: case=secrets — expected the provisioner to write the production app's secrets" >&2
  sed 's/^/  /' "$TMP/fly.create.log" >&2
  exit 1
fi
if ! grep -qF 'PLATFORM_TASKS_API_DATABASE_URL=<redacted>' "$TMP/fly.create.log"; then
  echo "FAIL: case=secrets — expected the PLATFORM_* secret names to be registered" >&2
  sed 's/^/  /' "$TMP/fly.create.log" >&2
  exit 1
fi
if grep -qE 'INVOKED: secrets set --app sindustries-(tasks-api|budget-api|content-scheduler-api|auto-post-worker)' "$TMP/fly.create.log"; then
  echo "FAIL: case=secrets — secrets were written to a per-service app" >&2
  exit 1
fi

# ---------- case 3: an existing production app is reused ------------------

FLY_LIST_JSON_OVERRIDE='[{"Name":"sindustries-platform-production","Status":"running"}]' \
  run_production "exists" "$TMP/.env.production.local"
if grep -qE '^INVOKED: apps create' "$TMP/fly.exists.log"; then
  echo "FAIL: case=exists — the app exists and must not be created again" >&2
  sed 's/^/  /' "$TMP/fly.exists.log" >&2
  exit 1
fi

# ---------- case 4: a staging value is refused before any Fly call ---------

run_production "staging-value" "$TMP/.env.production.staging"
assert_no_fly_mutation "$TMP/fly.staging-value.log" "case=staging-value"
if ! grep -qF "refuses these values" "$TMP/err.staging-value"; then
  echo "FAIL: case=staging-value — expected the production separation guard on stderr" >&2
  sed 's/^/  /' "$TMP/err.staging-value" >&2
  exit 1
fi

# ---------- case 5: a missing source is refused before any Fly call -------

run_production "missing-source" "$TMP/.env.production.noredis"
assert_no_fly_mutation "$TMP/fly.missing-source.log" "case=missing-source"
if ! grep -qF 'PRODUCTION_HEALTH_PROBE_REDIS' "$TMP/err.missing-source"; then
  echo "FAIL: case=missing-source — expected the missing PRODUCTION source to be named on stderr" >&2
  sed 's/^/  /' "$TMP/err.missing-source" >&2
  exit 1
fi

# ---------- case 6: the deploy is gated twice ------------------------------

run_production "deploy-gated" "$TMP/.env.production.local" --deploy
if grep -qE '^INVOKED: deploy' "$TMP/fly.deploy-gated.log"; then
  echo "FAIL: case=deploy-gated — the deploy ran without the gate variable" >&2
  exit 1
fi
if ! grep -qF 'PRODUCTION_PLATFORM_DEPLOY_ENABLED=true' "$TMP/err.deploy-gated"; then
  echo "FAIL: case=deploy-gated — expected the gate variable to be named on stderr" >&2
  sed 's/^/  /' "$TMP/err.deploy-gated" >&2
  exit 1
fi

# With the gate set, the deploy runs against the RENDERED production config.
PRODUCTION_PLATFORM_DEPLOY_ENABLED=true \
FLY_LIST_JSON_OVERRIDE='[{"Name":"sindustries-platform-production","Status":"running"}]' \
  run_production "deploy" "$TMP/.env.production.local" --deploy
if ! grep -qF 'INVOKED: deploy --config infra/cloud/fly/platform.production.fly.toml --strategy canary' "$TMP/fly.deploy.log"; then
  echo "FAIL: case=deploy — expected the deploy to use the rendered production config" >&2
  sed 's/^/  /' "$TMP/fly.deploy.log" >&2
  exit 1
fi
if grep -qF 'INVOKED: deploy --config infra/cloud/fly/platform.fly.toml' "$TMP/fly.deploy.log"; then
  echo "FAIL: case=deploy — the shared (staging) config must never be deployed to production" >&2
  exit 1
fi
RENDERED="$REPO_ROOT/infra/cloud/fly/platform.production.fly.toml"
if [[ ! -f "$RENDERED" ]]; then
  echo "FAIL: case=deploy — the rendered production config was not written" >&2
  exit 1
fi
if ! grep -qF "app = 'sindustries-platform-production'" "$RENDERED"; then
  echo "FAIL: case=deploy — the rendered config must name the production app" >&2
  exit 1
fi
if ! git -C "$REPO_ROOT" check-ignore -q infra/cloud/fly/platform.production.fly.toml; then
  echo "FAIL: case=deploy — the generated production config must be gitignored" >&2
  exit 1
fi

# ---------- case 7: the gate derivation agrees with the staging workflow ---

GATE_FROM_FACTS="$(node "$FACTS_CLI" --environment staging --field deployGateVariable)"
if [[ "$GATE_FROM_FACTS" != "STAGING_PLATFORM_DEPLOY_ENABLED" ]]; then
  echo "FAIL: case=gate — the derived staging gate is '$GATE_FROM_FACTS'" >&2
  exit 1
fi
if ! grep -qF 'STAGING_PLATFORM_DEPLOY_ENABLED' "$REPO_ROOT/.github/workflows/deploy-staging-platform.yml"; then
  echo "FAIL: case=gate — the staging deploy workflow does not use the derived gate variable" >&2
  exit 1
fi
PROD_GATE="$(node "$FACTS_CLI" --environment production --field deployGateVariable)"
if [[ "$PROD_GATE" != "PRODUCTION_PLATFORM_DEPLOY_ENABLED" ]]; then
  echo "FAIL: case=gate — the derived production gate is '$PROD_GATE'" >&2
  exit 1
fi

# ---------- case 8: the facts agree with the manifest ----------------------

APP_FROM_FACTS="$(node "$FACTS_CLI" --environment production --field platformApp)"
if [[ "$APP_FROM_FACTS" != "sindustries-platform-production" ]]; then
  echo "FAIL: case=facts — the production app name is '$APP_FROM_FACTS'" >&2
  exit 1
fi
REQUIRED="$(node "$FACTS_CLI" --environment production --field requiredSourceNames)"
for source in PRODUCTION_TASKS_API_DATABASE_URL PRODUCTION_BUDGET_API_DATABASE_URL PRODUCTION_HEALTH_PROBE_REDIS PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN PRODUCTION_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN; do
  if [[ "$REQUIRED" != *"$source"* ]]; then
    echo "FAIL: case=facts — $source is not a required production source" >&2
    exit 1
  fi
done

# ---------- case 9: the published example file satisfies the contract -----

EXAMPLE="$REPO_ROOT/infra/cloud/env/bootstrap-production.env.example"
if [[ ! -f "$EXAMPLE" ]]; then
  echo "FAIL: case=example — $EXAMPLE is missing — the production source contract must be published" >&2
  exit 1
fi
python3 - "$EXAMPLE" "$TMP/.env.production.example" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
out = []
for line in open(src):
    m = re.match(r'^([A-Z0-9_]+)=\s*$', line.rstrip('\n'))
    if m:
        key = m.group(1)
        if key.endswith('_DATABASE_URL'):
            value = 'postgres://stub:***@db.example-neon.tech:5432/prod'
        elif key.endswith('_REDIS'):
            value = 'rediss://:stub@prod-example.upstash.io:6379'
        else:
            value = 'stub-token'
        out.append(f'{key}={value}\n')
        continue
    if re.match(r'^#\s*FLY_APP_ORG=', line):
        continue
    out.append(line)
open(dst, 'w').writelines(out)
PY

FLY_LIST_JSON_OVERRIDE='[{"Name":"sindustries-platform-production","Status":"running"}]' \
  run_production "example" "$TMP/.env.production.example"
if grep -qF "missing source value(s)" "$TMP/err.example"; then
  echo "FAIL: case=example — the published example file does not satisfy the source contract" >&2
  sed 's/^/  /' "$TMP/err.example" >&2
  exit 1
fi
if ! grep -qF 'INVOKED: secrets set --app sindustries-platform-production --detach' "$TMP/fly.example.log"; then
  echo "FAIL: case=example — the example file must reach the secrets step" >&2
  sed 's/^/  /' "$TMP/fly.example.log" >&2
  exit 1
fi

echo "bootstrap-platform: ok (9 cases)"
