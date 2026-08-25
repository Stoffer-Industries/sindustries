#!/usr/bin/env bash
# bootstrap-staging.test.sh — AC1 regression guard.
#
# Stage a stub `flyctl` in PATH that records argv to $FLY_LOG and emits
# canned JSON for `apps list --json`. Run bootstrap-staging.sh with
# --yes --service tasks-api and assert:
#
#   1. When the app exists in the canned list, NO `apps create` call
#      is issued (existence check still works after the python3 rewrite).
#   2. When the app is missing, `apps create <name> --org personal --yes`
#      is invoked with the positional form (NOT `--app <name>`).
#   3. When a same-prefix app exists (e.g. `sindustries-tasks-api-staging-extra`),
#      the check rejects the substring match and still issues `apps create`.
#      This is the regression that the prior `grep -q "\"Name\":\"$app\""`
#      form allowed.
#
# All three sub-cases share the same test scaffolding; only $FLY_LIST_JSON
# differs per run.

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
  *)
    # secrets set, ssh console, deploy — all no-ops under the stub.
    exit 0
    ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# ---------- minimal .env.local ---------------------------------------------

# bootstrap-staging.sh sources this in pre-flight and looks for TASKS_API_*
# keys to populate `fly secrets set`. A single TASKS_API_DATABASE_URL is
# enough to satisfy both gates without dragging real Quinn-owned values in.
cat >"$TMP/.env.local" <<'ENV'
TASKS_API_DATABASE_URL=postgres://stub:stub@localhost:5432/stub
ENV

# ---------- helpers ---------------------------------------------------------

run_case() {
  local label="$1"
  local list_json="$2"
  local fly_log="$TMP/fly.${label}.log"
  FLY_LOG="$fly_log" \
  FLY_LIST_JSON="$list_json" \
  PATH="$TMP/bin:$PATH" \
    bash "$SCRIPT" --yes --service tasks-api --env-local "$TMP/.env.local" \
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

# ---------- case 1: app already exists --------------------------------------

run_case "exists" '[{"Name":"sindustries-tasks-api-staging","Status":"running"}]'
assert_no_create "$TMP/fly.exists.log" "case=exists"

# ---------- case 2: app missing --------------------------------------------

run_case "missing" '[]'
assert_create_args "$TMP/fly.missing.log" "sindustries-tasks-api-staging --org personal --yes" \
  "case=missing"

# ---------- case 3: substring-match regression ------------------------------

# Prior `grep -q "\"Name\":\"$app\""` form would match this because
# `"Name":"sindustries-tasks-api-staging-extra"` contains the substring
# `"Name":"sindustries-tasks-api-staging`. The python3 JSON parse is exact.
run_case "substring" '[{"Name":"sindustries-tasks-api-staging-extra","Status":"running"}]'
assert_create_args "$TMP/fly.substring.log" "sindustries-tasks-api-staging --org personal --yes" \
  "case=substring"

# ---------- case 4: lowercase-name tolerance --------------------------------

# Some sandboxed fly CLIs emit `name` instead of `Name`. Tolerate both.
run_case "lowercase" '[{"name":"sindustries-tasks-api-staging","status":"running"}]'
assert_no_create "$TMP/fly.lowercase.log" "case=lowercase"

echo "bootstrap-staging: ok (4 cases)"
