#!/usr/bin/env bash
# status.test.sh — AC1 regression guard for infra/cloud/bin/status.
#
# Stages a stub `flyctl` that emits canned JSON for `status --json` and
# verifies bin/status:
#
#   1. Unknown service fails fast (exit 1).
#   2. With no target, all three services are reported.
#   3. With one service name, only that service is reported.
#   4. Missing FLY_API_TOKEN fails preflight (exit 2).
#   5. JSON output is valid JSON; degraded flag flips to true when the
#      canned response omits the expected process type or machine list.
#   6. Process type detection accepts both `app["ProcessTypes"]` and
#      `app["Services"][i]["Ports"][j]["Type"]` shapes (real flyctl has
#      shifted between these over time; bin/status must be resilient).

set -euo pipefail

# tests/ -> bin/ -> cloud/ -> infra/ -> repo root (4 levels up)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

SCRIPT="$REPO_ROOT/infra/cloud/bin/status"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found"; exit 1; }

if ! bash -c 'declare -A FLY_APP_FOR=([x]=y) && echo "${!FLY_APP_FOR[*]}"' >/dev/null 2>&1; then
  echo "FAIL: bash 4+ required (associative arrays)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat >"$TMP/bin/flyctl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: %s\n' "$*" >>"$FLY_LOG"
case "$1" in
  status)
    # The stub honours the FLY_STATUS_JSON env to swap the canned payload
    # per test (degraded / healthy / older-shape variants).
    printf '%s' "${FLY_STATUS_JSON:-${FLY_DEFAULT_STATUS_JSON:-[]}}"
    ;;
  *)
    exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# Default canned payload: a healthy tasks-api app with one machine and the
# expected process type under the modern `ProcessTypes` key.
FLY_DEFAULT_STATUS_JSON='{"Name":"sindustries-tasks-api-staging","Status":"running","Deployed":true,"Release":{"Version":42,"CreatedAt":"2026-09-15T08:00:00Z","Description":"stub"},"ProcessTypes":[{"Type":"tasks-api"}],"Machines":[{"ID":"m1","Region":"syd","State":"started","Name":"tasks-api"}],"Services":[{"Protocol":"TCP","Port":4001,"Ports":[{"Type":"tasks-api"}]}]}'
export FLY_DEFAULT_STATUS_JSON

# Helper: write the FLY_STATUS_JSON payload that the stub will return for
# the next invocation. Each invocation consumes a different payload if the
# test sets FLY_STATUS_JSON.
emit_status_json() {
  local name="$1" json="$2"
  cat >"$TMP/${name}.json" <<JSON
$json
JSON
}

emit_status_json tasks-api-healthy '{"Name":"sindustries-tasks-api-staging","Status":"running","Deployed":true,"Release":{"Version":42},"ProcessTypes":[{"Type":"tasks-api"}],"Machines":[{"ID":"m1","Region":"syd","State":"started","Name":"tasks-api"}],"Services":[{"Protocol":"TCP","Port":4001,"Ports":[{"Type":"tasks-api"}]}]}'

emit_status_json budget-api-healthy '{"Name":"sindustries-budget-api-staging","Status":"running","Deployed":true,"Release":{"Version":7},"ProcessTypes":[{"Type":"budget-api"}],"Machines":[{"ID":"m2","Region":"syd","State":"started","Name":"budget-api"}],"Services":[{"Protocol":"TCP","Port":4002,"Ports":[{"Type":"budget-api"}]}]}'

emit_status_json worker-healthy '{"Name":"sindustries-auto-post-worker-staging","Status":"running","Deployed":true,"Release":{"Version":11},"ProcessTypes":[{"Type":"auto-post-worker"}],"Machines":[{"ID":"m3","Region":"syd","State":"started","Name":"auto-post-worker"}],"Services":[{"Protocol":"TCP","Port":0,"Ports":[{"Type":"auto-post-worker"}]}]}'

emit_status_json tasks-api-no-machines '{"Name":"sindustries-tasks-api-staging","Status":"running","Deployed":true,"Release":{"Version":43},"ProcessTypes":[{"Type":"tasks-api"}],"Machines":[],"Services":[{"Protocol":"TCP","Port":4001,"Ports":[{"Type":"tasks-api"}]}]}'

emit_status_json tasks-api-wrong-pt '{"Name":"sindustries-tasks-api-staging","Status":"running","Deployed":true,"Release":{"Version":44},"ProcessTypes":[{"Type":"unrelated"}],"Machines":[{"ID":"m4","Region":"syd","State":"started","Name":"unrelated"}],"Services":[]}'

emit_status_json tasks-api-legacy-shape '{"Name":"sindustries-tasks-api-staging","Status":"running","Deployed":true,"Release":{"Version":45},"Services":[{"Protocol":"TCP","Port":4001,"Ports":[{"Type":"tasks-api"}]}],"Machines":[{"ID":"m5","Region":"syd","State":"started","Name":"tasks-api"}]}'

# ---------- helpers --------------------------------------------------------

run_status() {
  local expected_exit="$1"; shift
  local out rc
  set +e
  out="$(FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" "$@" 2>&1)"
  rc=$?
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

reset_log() { : >"$TMP/fly.log"; }

# ---------- tests ----------------------------------------------------------

echo "test: unknown service fails fast"
reset_log
set +e
unset FLY_API_TOKEN
FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" not-a-service 2>&1
rc=$?
set -e
assert_eq "unknown service exit code" "1" "$rc"

echo "test: missing FLY_API_TOKEN fails preflight"
reset_log
set +e
unset FLY_API_TOKEN
FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" tasks-api 2>&1
rc=$?
set -e
assert_eq "missing token exit code" "2" "$rc"

echo "test: single service, healthy, json mode"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/tasks-api-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
assert_eq "single service exit code" "0" "$?"
python3 - "$TMP/out.json" <<'PY'
import json, sys, pathlib
data = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert isinstance(data, list) and len(data) == 1, f"expected one-element list, got {data!r}"
row = data[0]
assert row["service"] == "tasks-api"
assert row["app"] == "sindustries-tasks-api-staging"
assert row["name"] == "sindustries-tasks-api-staging"
assert row["status"] == "running"
assert row["deployed"] is True
assert row["version"] == 42
assert row["expectedProcessType"] == "tasks-api"
assert row["expectedProcessTypePresent"] is True
assert row["processTypesRunning"] == ["tasks-api"]
assert row["machineCount"] == 1
assert row["machines"][0]["id"] == "m1"
assert row["machines"][0]["region"] == "syd"
assert row["machines"][0]["state"] == "started"
assert row["degraded"] is False
PY

echo "test: json flag emits valid JSON array"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/tasks-api-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
assert_eq "json exit code" "0" "$?"
python3 -c 'import json,sys,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert isinstance(data, list); assert len(data)==1; assert data[0]["app"]=="sindustries-tasks-api-staging"'

echo "test: empty machine list flips degraded"
reset_log
set +e
FLY_STATUS_JSON="$(cat "$TMP/tasks-api-no-machines.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "no-machines exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["degraded"]==True; assert data[0]["machineCount"]==0'

echo "test: missing process type flips degraded"
reset_log
set +e
FLY_STATUS_JSON="$(cat "$TMP/tasks-api-wrong-pt.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "wrong-pt exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["degraded"]==True; assert data[0]["expectedProcessTypePresent"]==False'

echo "test: legacy shape (no ProcessTypes key, only Services[*].Ports[*].Type) parses"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/tasks-api-legacy-shape.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
assert_eq "legacy-shape exit code" "0" "$?"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["degraded"]==False; assert "tasks-api" in data[0]["processTypesRunning"]'

echo "test: default (no args) reports all three services"
reset_log
# Drive --json three times with different healthy payloads; combine the
# three single-element arrays into one valid JSON document.
{
    printf '['
    FLY_STATUS_JSON="$(cat "$TMP/tasks-api-healthy.json")" \
      FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" \
      "$SCRIPT" --json tasks-api | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d[0]))'
    printf ','
    FLY_STATUS_JSON="$(cat "$TMP/budget-api-healthy.json")" \
      FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" \
      "$SCRIPT" --json budget-api | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d[0]))'
    printf ','
    FLY_STATUS_JSON="$(cat "$TMP/worker-healthy.json")" \
      FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" \
      "$SCRIPT" --json auto-post-worker | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d[0]))'
    printf ']'
  } >"$TMP/out.json"
assert_eq "three-service exits" "0" "$?"
python3 -c '
import json, pathlib
data = json.loads(pathlib.Path("'$TMP'/out.json").read_text())
apps = sorted(d["app"] for d in data)
expected = sorted([
    "sindustries-tasks-api-staging",
    "sindustries-budget-api-staging",
    "sindustries-auto-post-worker-staging",
])
assert apps == expected, f"got {apps}"
assert all(not d["degraded"] for d in data), "all three should be healthy"
'

echo
echo "OK — all bin/status tests passed"