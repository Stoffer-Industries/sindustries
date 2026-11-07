#!/usr/bin/env bash
# bootstrap-staging.test.sh — regression guard for the staging bootstrap.
#
# Staging is ONE app after the cutover (task 219fb673, 2026-11-07): the
# consolidated platform `sindustries-platform-staging` hosts all four
# services as supervisor children, and the four per-service staging apps
# were destroyed.
#
# Stage a stub `flyctl` in PATH that records argv to $FLY_LOG and emits
# canned JSON for `apps list --json`. Run bootstrap-staging.sh and assert:
#
#   1. When the platform app exists in the canned list, NO `apps create`
#      call is issued (existence check still works after the python3
#      rewrite).
#   2. When the app is missing, `apps create <name> --org personal --yes`
#      is invoked with the positional form (NOT `--app <name>`).
#   3. When a same-prefix app exists (e.g. `sindustries-platform-staging-extra`),
#      the check rejects the substring match and still issues `apps create`.
#      This is the regression that the prior `grep -q "\"Name\":\"$app\""`
#      form allowed.
#   4. Lowercase `name` keys are tolerated (some sandboxed CLIs emit them).
#   5. The RETIRED per-service names are refused with the cutover
#      explanation, and no app is created for them. This is the guard that
#      keeps the retired auto-post worker app from being resurrected next
#      to the platform's worker — two consumers on one BullMQ queue would
#      process every scheduled post twice, silently.
#   6. The platform's app-level secrets are registered through the platform
#      provisioner (one implementation of the PLATFORM_* mapping).
#   7. A missing source value fails the script BEFORE it touches Fly.
#   8. A FLY_APP_PLATFORM override is REFUSED for every retired app (and
#      for any other name), and nothing is created or written. The
#      override used to reach `apps create` + `secrets set` on a retired
#      app — which would resurrect the retired auto-post worker next to
#      the platform's worker and put two consumers on one BullMQ queue.
#   9. The REAL example file (infra/cloud/env/bootstrap-staging.env.example)
#      runs through the translation step unchanged: the documented source
#      contract is the contract the script consumes. Before this file
#      existed the error message pointed at platform.env.example, whose
#      keys are the PLATFORM_* DESTINATION names — so the documented
#      first-time path failed closed before touching Fly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
SCRIPT="$REPO_ROOT/infra/cloud/scripts/bootstrap-staging.sh"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found (REPO_ROOT=$REPO_ROOT)"; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

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
    # Record the registered secret names so the read-back can confirm them.
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
  "apps create")
    # Real call would create; the stub exits 0 so bootstrap-staging.sh can
    # proceed to the secrets step (which the stub also no-ops).
    exit 0
    ;;
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
  *)
    # secrets set, ssh console, deploy — all no-ops under the stub.
    exit 0
    ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# ---------- minimal .env.local ---------------------------------------------

# bootstrap-staging.sh sources this in pre-flight and translates its keys
# into the source names the platform provisioner reads. Every required
# source is present here; case 7 uses a variant with one removed.
cat >"$TMP/.env.local" <<'ENV'
TASKS_API_DATABASE_URL=postgres://stub:***@localhost:5432/stub
BUDGET_API_DATABASE_URL=postgres://stub:***@localhost:5432/stub
AUTO_POST_WORKER_DATABASE_URL=postgres://stub:***@localhost:5432/stub
HEALTH_PROBE_REDIS=redis://stub.example.upstash.io:6379
TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-tasks-token
CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-scheduler-token
ENV

# A variant with the Redis source missing — the script must fail closed
# before it touches Fly.
grep -v '^HEALTH_PROBE_REDIS=' "$TMP/.env.local" >"$TMP/.env.local.noredis"

# ---------- case 8: the FLY_APP_PLATFORM override is refused --------------
#
# The retired per-service apps must not be recreated, and the ONLY app
# staging runs on is the consolidated platform. The override used to be
# accepted verbatim: it reached `apps create` and the provisioner's
# `secrets set`, which would have written the platform secrets to a
# retired app.
#
# The override value is substituted per case, so the template keeps a
# placeholder rather than interpolating an unset positional parameter.
write_override_env() {
  local target="$1" out="$2"
  cat >"$out" <<'ENV'
TASKS_API_DATABASE_URL=postgres://stub:***@localhost:5432/stub
BUDGET_API_DATABASE_URL=postgres://stub:***@localhost:5432/stub
AUTO_POST_WORKER_DATABASE_URL=postgres://stub:***@localhost:5432/stub
HEALTH_PROBE_REDIS=redis://stub.example.upstash.io:6379
TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-tasks-token
CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN=stub-scheduler-token
ENV
  printf 'FLY_APP_PLATFORM=%s\n' "$target" >>"$out"
}

# Every retired app name plus one arbitrary other name must be refused.
for override in \
  sindustries-tasks-api-staging \
  sindustries-budget-api-staging \
  sindustries-content-scheduler-api-staging \
  sindustries-auto-post-worker-staging \
  sindustries-some-other-app
do
  write_override_env "$override" "$TMP/.env.local.override"
  rm -f "$TMP/registered.override"
  FLY_LOG="$TMP/fly.override.log" \
  FLY_REGISTERED="$TMP/registered.override" \
  FLY_LIST_JSON='[]' \
  PATH="$TMP/bin:$PATH" \
    bash "$SCRIPT" --yes --env-local "$TMP/.env.local.override" \
      >"$TMP/out.override" 2>"$TMP/err.override" \
      || true

  if ! grep -qF "refusing to bootstrap Fly app" "$TMP/err.override"; then
    echo "FAIL: case=override $override — expected the refusal on stderr" >&2
    sed 's/^/  /' "$TMP/err.override" >&2
    exit 1
  fi
  if grep -qE '^INVOKED: (apps create|secrets set)' "$TMP/fly.override.log" 2>/dev/null; then
    echo "FAIL: case=override $override — the script must refuse BEFORE it creates an app or writes secrets" >&2
    sed 's/^/  /' "$TMP/fly.override.log" >&2
    exit 1
  fi
  if grep -qF "$override" "$TMP/fly.override.log" 2>/dev/null; then
    echo "FAIL: case=override $override — the overridden app was referenced" >&2
    sed 's/^/  /' "$TMP/fly.override.log" >&2
    exit 1
  fi
done

# The override that NAMES the consolidated platform is accepted — it is
# the one app staging runs on.
write_override_env "sindustries-platform-staging" "$TMP/.env.local.override"
rm -f "$TMP/registered.override-ok"
FLY_LOG="$TMP/fly.override-ok.log" \
FLY_REGISTERED="$TMP/registered.override-ok" \
FLY_LIST_JSON='[{"Name":"sindustries-platform-staging","Status":"running"}]' \
PATH="$TMP/bin:$PATH" \
  bash "$SCRIPT" --yes --env-local "$TMP/.env.local.override" \
    >"$TMP/out.override-ok" 2>"$TMP/err.override-ok" \
    || true
if grep -qF "refusing to bootstrap Fly app" "$TMP/err.override-ok"; then
  echo "FAIL: case=override-ok — the consolidated platform app must be accepted" >&2
  sed 's/^/  /' "$TMP/err.override-ok" >&2
  exit 1
fi

# ---------- case 9: the real example file satisfies the source contract ----
#
# The documented first-time path must actually work. This runs the REAL
# example file (with its values filled in) through the script's
# translation step.
EXAMPLE="$REPO_ROOT/infra/cloud/env/bootstrap-staging.env.example"
if [[ ! -f "$EXAMPLE" ]]; then
  echo "FAIL: $EXAMPLE is missing — the bootstrap source contract must be published" >&2
  exit 1
fi

# Fill every empty assignment in the real example file with a stub value.
python3 - "$EXAMPLE" "$TMP/.env.local.example" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
out = []
for line in open(src):
    m = re.match(r'^([A-Z0-9_]+)=\s*$', line.rstrip('\n'))
    if m:
        key = m.group(1)
        if key.endswith('_DATABASE_URL'):
            value = 'postgres://stub:***@localhost:5432/stub'
        elif key.endswith('_REDIS'):
            value = 'redis://stub.example.upstash.io:6379'
        else:
            value = 'stub-token'
        out.append(f'{key}={value}\n')
        continue
    # FLY_APP_ORG is optional and must keep its documented default.
    if re.match(r'^#\s*FLY_APP_ORG=', line):
        continue
    out.append(line)
open(dst, 'w').writelines(out)
PY

rm -f "$TMP/registered.example"
FLY_LOG="$TMP/fly.example.log" \
FLY_REGISTERED="$TMP/registered.example" \
FLY_LIST_JSON='[{"Name":"sindustries-platform-staging","Status":"running"}]' \
PATH="$TMP/bin:$PATH" \
  bash "$SCRIPT" --yes --env-local "$TMP/.env.local.example" \
    >"$TMP/out.example" 2>"$TMP/err.example" \
    || true

if grep -qF "missing source value(s)" "$TMP/err.example"; then
  echo "FAIL: case=example — the published example file does not satisfy the source contract" >&2
  sed 's/^/  /' "$TMP/err.example" >&2
  exit 1
fi
if grep -qF "refusing to bootstrap Fly app" "$TMP/err.example"; then
  echo "FAIL: case=example — the published example file set an unexpected app name" >&2
  sed 's/^/  /' "$TMP/err.example" >&2
  exit 1
fi
if ! grep -qF 'INVOKED: secrets set --app sindustries-platform-staging --detach' "$TMP/fly.example.log"; then
  echo "FAIL: case=example — the example file must reach the secrets step" >&2
  sed 's/^/  /' "$TMP/fly.example.log" >&2
  exit 1
fi

# ---------- helpers ---------------------------------------------------------

run_case() {
  local label="$1"
  local list_json="$2"
  local fly_log="$TMP/fly.${label}.log"
  rm -f "$TMP/registered.${label}"
  FLY_LOG="$fly_log" \
  FLY_REGISTERED="$TMP/registered.${label}" \
  FLY_LIST_JSON="$list_json" \
  PATH="$TMP/bin:$PATH" \
    bash "$SCRIPT" --yes --env-local "$TMP/.env.local" \
      >"$TMP/out.${label}" 2>"$TMP/err.${label}" \
      || true
}

assert_no_create() {
  local log="$1"
  if grep -q '^INVOKED: apps create' "$log"; then
    echo "FAIL: $2 — should not have called 'apps create'" >&2
    sed 's/^/  /' "$log" >&2
    exit 1
  fi
}

assert_create_args() {
  local log="$1"
  local expected="$2"
  if ! grep -qF "INVOKED: apps create ${expected}" "$log"; then
    echo "FAIL: $2 — expected 'apps create ${expected}'" >&2
    sed 's/^/  /' "$log" >&2
    exit 1
  fi
  # Specifically forbid the deprecated --app form.
  if grep -qE 'INVOKED: apps create --app' "$log"; then
    echo "FAIL: $2 — used deprecated '--app' flag" >&2
    sed 's/^/  /' "$log" >&2
    exit 1
  fi
}

# ---------- case 1: platform app already exists ----------------------------

run_case "exists" '[{"Name":"sindustries-platform-staging","Status":"running"}]'
assert_no_create "$TMP/fly.exists.log" "case=exists"

# ---------- case 2: platform app missing ----------------------------------

run_case "missing" '[]'
assert_create_args "$TMP/fly.missing.log" "sindustries-platform-staging --org personal --yes" \
  "case=missing"

# ---------- case 3: substring-match regression ------------------------------

# Prior `grep -q "\"Name\":\"$app\""` form would match this because
# `"Name":"sindustries-platform-staging-extra"` contains the substring
# `"Name":"sindustries-platform-staging`. The python3 JSON parse is exact.
run_case "substring" '[{"Name":"sindustries-platform-staging-extra","Status":"running"}]'
assert_create_args "$TMP/fly.substring.log" "sindustries-platform-staging --org personal --yes" \
  "case=substring"

# ---------- case 4: lowercase-name tolerance --------------------------------

# Some sandboxed fly CLIs emit `name` instead of `Name`. Tolerate both.
run_case "lowercase" '[{"name":"sindustries-platform-staging","status":"running"}]'
assert_no_create "$TMP/fly.lowercase.log" "case=lowercase"

# ---------- case 5: the retired per-service apps are refused ---------------

# The retired auto-post worker app must never be recreated next to the
# platform's worker: two consumers on one BullMQ queue would process every
# scheduled post twice, silently.
for retired in tasks-api budget-api content-scheduler-api auto-post-worker; do
  rm -f "$TMP/registered.retired"
  FLY_LOG="$TMP/fly.retired.log" \
  FLY_REGISTERED="$TMP/registered.retired" \
  FLY_LIST_JSON='[]' \
  PATH="$TMP/bin:$PATH" \
    bash "$SCRIPT" --yes --service "$retired" --env-local "$TMP/.env.local" \
      >"$TMP/out.retired" 2>"$TMP/err.retired" \
      || true

  if ! grep -qF "destroyed at the staging cutover" "$TMP/err.retired"; then
    echo "FAIL: case=retired --service $retired — expected the cutover explanation on stderr" >&2
    sed 's/^/  /' "$TMP/err.retired" >&2
    exit 1
  fi
  if grep -qF "sindustries-${retired}-staging" "$TMP/fly.retired.log"; then
    echo "FAIL: case=retired --service $retired — the retired app was referenced" >&2
    sed 's/^/  /' "$TMP/fly.retired.log" >&2
    exit 1
  fi
  assert_no_create "$TMP/fly.retired.log" "case=retired --service $retired"
done

# ---------- case 6: the platform secrets go through the provisioner --------

# The provisioner owns the mapping from source names to the app-level
# PLATFORM_* secret names; the bootstrap script must not write secrets
# itself.
if ! grep -qF 'INVOKED: secrets set --app sindustries-platform-staging --detach' "$TMP/fly.missing.log"; then
  echo "FAIL: case=secrets — expected the provisioner to write the platform's secrets" >&2
  sed 's/^/  /' "$TMP/fly.missing.log" >&2
  exit 1
fi
if ! grep -qF 'PLATFORM_TASKS_API_DATABASE_URL=<redacted>' "$TMP/fly.missing.log"; then
  echo "FAIL: case=secrets — expected the PLATFORM_* secret names to be registered" >&2
  sed 's/^/  /' "$TMP/fly.missing.log" >&2
  exit 1
fi
if grep -qE 'INVOKED: secrets set --app sindustries-(tasks-api|budget-api|content-scheduler-api|auto-post-worker)-staging' "$TMP/fly.missing.log"; then
  echo "FAIL: case=secrets — secrets were written to a retired per-service app" >&2
  sed 's/^/  /' "$TMP/fly.missing.log" >&2
  exit 1
fi

# ---------- case 7: a missing source fails closed --------------------------

rm -f "$TMP/registered.noredis"
FLY_LOG="$TMP/fly.noredis.log" \
FLY_REGISTERED="$TMP/registered.noredis" \
FLY_LIST_JSON='[]' \
PATH="$TMP/bin:$PATH" \
  bash "$SCRIPT" --yes --env-local "$TMP/.env.local.noredis" \
    >"$TMP/out.noredis" 2>"$TMP/err.noredis" \
    || true

if ! grep -qF 'HEALTH_PROBE_REDIS' "$TMP/err.noredis"; then
  echo "FAIL: case=noredis — expected the missing source to be named on stderr" >&2
  sed 's/^/  /' "$TMP/err.noredis" >&2
  exit 1
fi
if grep -qE '^INVOKED: (apps create|secrets set)' "$TMP/fly.noredis.log"; then
  echo "FAIL: case=noredis — the script must fail BEFORE it creates an app or writes secrets" >&2
  sed 's/^/  /' "$TMP/fly.noredis.log" >&2
  exit 1
fi

echo "bootstrap-staging: ok (7 cases)"
