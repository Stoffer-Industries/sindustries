#!/usr/bin/env bash
# status.test.sh — regression guard for infra/cloud/bin/status.
#
# Stages a stub `flyctl` that emits canned JSON for `status --json` and a
# stub `curl` that emits the supervisor's canned `/__status` payload, then
# verifies bin/status:
#
#   1. Unknown service fails fast (exit 1).
#   2. Missing FLY_API_TOKEN fails preflight (exit 2).
#   3. With no target, the consolidated platform is reported ONCE (staging
#      is one Fly app after the cutover — task 219fb673).
#   4. A service name is an alias: it reports the same app, plus the
#      state of ITS child inside that app, read from the supervisor's
#      `/__status` payload.
#   5. JSON output is valid JSON; degraded flag flips to true when the
#      canned response omits the expected process type or machine list.
#   6. Process type detection accepts both `app["ProcessTypes"]` and
#      `app["Services"][i]["Ports"][j]["Type"]` shapes (real flyctl has
#      shifted between these over time; bin/status must be resilient).
#   7. An unreadable supervisor payload is reported as unknown, not as
#      healthy: the report is degraded and says so.
#   8. A child that is not running degrades the report for that service.
#   9. The LIVE flyctl 0.4.111 envelope (no "Services"/"ProcessTypes"/
#      "Release" key, lowercase machine fields) is parsed correctly, and a
#      machine env value never rides out in the report.
#  10. A failing flyctl surfaces its reason — with anything credential-
#      shaped redacted — instead of a bare "status failed".
#  11. EVERY credential shape the review named is redacted in the
#      operator output: a DSN, a URL credential, a JSON credential field,
#      an Authorization header, Fly's own FlyV1 header, a NAME=value
#      assignment, a bare credential keyword and a keyword assignment.
#  12. The flyctl call runs with DIRECT egress (the operator shell's
#      proxy variables are unset), and the documented escape hatch keeps
#      them when the operator asks for it.

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
# The proxy variables are recorded too: the flyctl call must run with
# direct egress unless the operator asked for the escape hatch. The CA
# bundle variables are recorded for the same reason — on this host the
# ambient SSL_CERT_FILE points at the egress proxy's trust bundle.
printf 'ENV: HTTP_PROXY=%s HTTPS_PROXY=%s http_proxy=%s https_proxy=%s SSL_CERT_FILE=%s SSL_CERT_DIR=%s\n' \
  "${HTTP_PROXY-<unset>}" "${HTTPS_PROXY-<unset>}" \
  "${http_proxy-<unset>}" "${https_proxy-<unset>}" \
  "${SSL_CERT_FILE-<unset>}" "${SSL_CERT_DIR-<unset>}" >>"$FLY_LOG"
case "$1" in
  status)
    # The stub honours the FLY_STATUS_JSON env to swap the canned payload
    # per test (degraded / healthy / older-shape variants), and
    # FLY_STATUS_EXIT/FLY_STATUS_STDERR to simulate a failing flyctl.
    if [[ "${FLY_STATUS_EXIT:-0}" != "0" ]]; then
      printf '%s' "${FLY_STATUS_STDERR:-flyctl: failed}" >&2
      exit "$FLY_STATUS_EXIT"
    fi
    printf '%s' "${FLY_STATUS_JSON:-${FLY_DEFAULT_STATUS_JSON:-[]}}"
    ;;
  *)
    exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"

# The supervisor's status endpoint, read through the platform's router.
# It is the only per-child signal after the consolidation.
cat >"$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: curl %s\n' "$*" >>"$FLY_LOG"
if [[ "${SUPERVISOR_CURL_EXIT:-0}" != "0" ]]; then
  exit "$SUPERVISOR_CURL_EXIT"
fi
printf '%s' "$SUPERVISOR_DEFAULT_JSON"
STUB
chmod +x "$TMP/bin/curl"

# Default canned Fly payload: the consolidated platform app with one
# machine and the platform process type under the modern `ProcessTypes`
# key.
FLY_DEFAULT_STATUS_JSON='{"Name":"sindustries-platform-staging","Status":"running","Deployed":true,"Release":{"Version":42,"CreatedAt":"2026-09-15T08:00:00Z","Description":"stub"},"ProcessTypes":[{"Type":"platform"}],"Machines":[{"ID":"m5","Region":"syd","State":"started","Name":"platform"}],"Services":[{"Protocol":"TCP","Port":8080,"Ports":[{"Type":"platform"}]}]}'
export FLY_DEFAULT_STATUS_JSON

# Default canned supervisor payload: the router and all four children
# running.
SUPERVISOR_DEFAULT_JSON='{"app":"sindustries-platform-staging","ready":true,"router":{"name":"nginx","state":"running","port":8080,"restarts":0},"children":[{"name":"tasks-api","role":"service","state":"running","pid":614,"port":4001,"restarts":0,"exitCode":null,"rssKb":68064},{"name":"budget-api","role":"service","state":"running","pid":615,"port":4002,"restarts":0,"exitCode":null,"rssKb":68696},{"name":"content-scheduler-api","role":"service","state":"running","pid":616,"port":4003,"restarts":0,"exitCode":null,"rssKb":68092},{"name":"auto-post-worker","role":"service","state":"running","pid":617,"port":null,"restarts":0,"exitCode":null,"rssKb":41000}]}'
export SUPERVISOR_DEFAULT_JSON

# Helper: write the FLY_STATUS_JSON payload that the stub will return for
# the next invocation. Each invocation consumes a different payload if the
# test sets FLY_STATUS_JSON.
emit_status_json() {
  local name="$1" json="$2"
  cat >"$TMP/${name}.json" <<JSON
$json
JSON
}

emit_status_json platform-healthy '{"Name":"sindustries-platform-staging","Status":"running","Deployed":true,"Release":{"Version":5},"ProcessTypes":[{"Type":"platform"}],"Machines":[{"ID":"m5","Region":"syd","State":"started","Name":"platform"}],"Services":[{"Protocol":"TCP","Port":8080,"Ports":[{"Type":"platform"}]}]}'

emit_status_json platform-no-machines '{"Name":"sindustries-platform-staging","Status":"running","Deployed":true,"Release":{"Version":43},"ProcessTypes":[{"Type":"platform"}],"Machines":[],"Services":[{"Protocol":"TCP","Port":8080,"Ports":[{"Type":"platform"}]}]}'

emit_status_json platform-wrong-pt '{"Name":"sindustries-platform-staging","Status":"running","Deployed":true,"Release":{"Version":44},"ProcessTypes":[{"Type":"unrelated"}],"Machines":[{"ID":"m4","Region":"syd","State":"started","Name":"unrelated"}],"Services":[]}'

emit_status_json platform-legacy-shape '{"Name":"sindustries-platform-staging","Status":"running","Deployed":true,"Release":{"Version":45},"Services":[{"Protocol":"TCP","Port":8080,"Ports":[{"Type":"platform"}]}],"Machines":[{"ID":"m5","Region":"syd","State":"started","Name":"platform"}]}'

# The LIVE flyctl 0.4.111 envelope, captured 2026-11-07 from
# `flyctl status --app sindustries-platform-staging --json`.
#
# It carries NO "Services", NO "ProcessTypes" and NO "Release" key, and its
# machine fields are LOWERCASE ("id"/"name"/"state"/"region"). The only
# process-type signal in this envelope is the machine's own
# FLY_PROCESS_GROUP env var, which is why the machine env is carried here.
# The env also carries a fake credential, because the report must never
# carry an env value out with it.
emit_status_json platform-live-flyctl-0-4-111 '{"AppURL":"https://2a09:8280:1::1ed:3207:0","Deployed":true,"Hostname":"sindustries-platform-staging.fly.dev","ID":"sindustries-platform-staging","Machines":[{"id":"84eed25a455e48","name":"white-sea-2302","state":"started","region":"syd","instance_id":"01M6V05DVMWC3P5WJ583DHDKHM","version":"01M6V05DVMWC3P5WJ583DHDKHM","private_ip":"fdaa:a8:d25a:7e:23f:4e2:48f:2","created_at":"2026-11-07T08:32:56Z","updated_at":"2026-11-07T12:36:38Z","checks":[],"config":{"env":{"FLY_PROCESS_GROUP":"platform","PLATFORM_TASKS_API_DATABASE_URL":"postgres://staging:***@db.example/staging","PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS":"https://mission-control.staging.sindustries.co.nz"}}}],"Name":"sindustries-platform-staging","Organization":{"id":"org","slug":"personal"},"PlatformVersion":"machines","Status":"deployed","Version":12}'

# The supervisor payload with one child down.
SUPERVISOR_DEGRADED_JSON='{"app":"sindustries-platform-staging","ready":false,"router":{"name":"nginx","state":"running","port":8080,"restarts":0},"children":[{"name":"tasks-api","role":"service","state":"running","pid":614,"port":4001,"restarts":0,"exitCode":null,"rssKb":68064},{"name":"budget-api","role":"service","state":"crashed","pid":null,"port":4002,"restarts":4,"exitCode":1,"rssKb":0},{"name":"content-scheduler-api","role":"service","state":"running","pid":616,"port":4003,"restarts":0,"exitCode":null,"rssKb":68092},{"name":"auto-post-worker","role":"service","state":"running","pid":617,"port":null,"restarts":0,"exitCode":null,"rssKb":41000}]}'

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
    echo "FAIL: $1 — expected [$2], got [$3]]" >&2
    exit 1
  fi
}

reset_log() { : >"$TMP/fly.log"; }

# The redaction marker the shared redactor writes, and the credential
# value the redaction cases assert on. Both are assembled at runtime so
# this file does not itself carry a credential-shaped literal.
MARKER='[redacted]'
SECRET_VALUE="s3cr3t-value-$$"

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

echo "test: the default target reports the consolidated platform ONCE"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json >"$TMP/out.json"
assert_eq "default target exit code" "0" "$?"
python3 - "$TMP/out.json" <<'PY'
import json, sys, pathlib
data = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert isinstance(data, list) and len(data) == 1, f"expected one-element list, got {data!r}"
row = data[0]
assert row["service"] == "platform"
assert row["app"] == "sindustries-platform-staging"
assert row["name"] == "sindustries-platform-staging"
assert row["status"] == "running"
assert row["deployed"] is True
assert row["expectedProcessType"] == "platform"
assert row["expectedProcessTypePresent"] is True
assert row["processTypesRunning"] == ["platform"]
assert row["machineCount"] == 1
assert row["machines"][0]["id"] == "m5"
assert row["machines"][0]["region"] == "syd"
assert row["machines"][0]["state"] == "started"
assert row["degraded"] is False
assert row["supervisorStatusAvailable"] is True
assert row["platformReady"] is True
assert [c["name"] for c in row["children"]] == [
    "tasks-api", "budget-api", "content-scheduler-api", "auto-post-worker"
]
assert all(c["state"] == "running" for c in row["children"])
PY

echo "test: the supervisor status is read from the platform's /__status"
# stable-fallback: provider URL pending the stable-hostname CNAME move (task 5cb4a8fe)
grep -qF "curl --fail --silent --show-error --max-time 10 https://sindustries-platform-staging.fly.dev/__status" "$TMP/fly.log" || {
  echo "FAIL: expected the supervisor status to be read from /__status" >&2
  cat "$TMP/fly.log" >&2
  exit 1
}

echo "test: a service name is an alias for the platform app, with its own child state"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
assert_eq "alias exit code" "0" "$?"
python3 - "$TMP/out.json" <<'PY'
import json, sys, pathlib
data = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert len(data) == 1
row = data[0]
assert row["service"] == "tasks-api"
assert row["app"] == "sindustries-platform-staging"
assert row["expectedProcessType"] == "platform"
assert row["child"]["name"] == "tasks-api"
assert row["child"]["state"] == "running"
assert row["child"]["port"] == 4001
assert row["childHealthy"] is True
assert row["degraded"] is False
PY

echo "test: json flag emits valid JSON array"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
assert_eq "json exit code" "0" "$?"
python3 -c 'import json,sys,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert isinstance(data, list); assert len(data)==1; assert data[0]["app"]=="sindustries-platform-staging"'

echo "test: empty machine list flips degraded"
reset_log
set +e
FLY_STATUS_JSON="$(cat "$TMP/platform-no-machines.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "no-machines exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["degraded"]==True; assert data[0]["machineCount"]==0'

echo "test: missing process type flips degraded"
reset_log
set +e
FLY_STATUS_JSON="$(cat "$TMP/platform-wrong-pt.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "wrong-pt exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["degraded"]==True; assert data[0]["expectedProcessTypePresent"]==False'

echo "test: the legacy flyctl shape is still detected"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/platform-legacy-shape.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json >"$TMP/out.json"
assert_eq "legacy shape exit code" "0" "$?"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["expectedProcessTypePresent"]==True; assert data[0]["degraded"]==False'

echo "test: an unreadable supervisor payload is unknown, not healthy"
reset_log
set +e
SUPERVISOR_CURL_EXIT=7 FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json tasks-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "unreadable supervisor exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["supervisorStatusAvailable"]==False; assert data[0]["childHealthy"] is None; assert data[0]["degraded"]==True'

echo "test: a crashed child degrades the report for that service"
reset_log
set +e
SUPERVISOR_DEFAULT_JSON="$SUPERVISOR_DEGRADED_JSON" FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json budget-api >"$TMP/out.json"
rc=$?
set -e
assert_eq "crashed child exit code" "3" "$rc"
python3 -c 'import json,pathlib; data=json.loads(pathlib.Path("'$TMP'/out.json").read_text()); assert data[0]["child"]["state"]=="crashed"; assert data[0]["child"]["restarts"]==4; assert data[0]["childHealthy"] is False; assert data[0]["degraded"]==True'

echo "test: the live flyctl 0.4.111 envelope is parsed"
reset_log
FLY_STATUS_JSON="$(cat "$TMP/platform-live-flyctl-0-4-111.json")" FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json >"$TMP/out.json"
assert_eq "live flyctl envelope exit code" "0" "$?"
python3 - "$TMP/out.json" <<'PY'
import json, sys, pathlib
row = json.loads(pathlib.Path(sys.argv[1]).read_text())[0]
assert row["degraded"] is False, row
assert row["expectedProcessTypePresent"] is True, row
assert row["processTypesRunning"] == ["platform"], row
assert "machine-env" in row["processTypeSource"], row
assert row["processTypesDetected"] is True, row
assert row["version"] == 12, row
assert row["machineCount"] == 1, row
m = row["machines"][0]
assert m["id"] == "84eed25a455e48", m
assert m["region"] == "syd", m
assert m["state"] == "started", m
assert m["name"] == "white-sea-2302", m
# The machine env must never ride out in the report.
blob = json.dumps(row)
assert "hunter2" not in blob, "a machine env value leaked into the report"
assert "DATABASE_URL" not in blob, "a machine env key leaked into the report"
PY

echo "test: a failing flyctl surfaces a sanitized reason"
reset_log
set +e
FLY_STATUS_EXIT=1 FLY_STATUS_STDERR='Error: failed to run query: tls: x509: certificate is not trusted (token=fly_abc1234567890xyz)' FLY_API_TOKEN=stub FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" tasks-api >"$TMP/out.txt" 2>&1
rc=$?
set -e
assert_eq "failing flyctl exit code" "2" "$rc"
grep -q "certificate is not trusted" "$TMP/out.txt" || {
  echo "FAIL: expected flyctl's reason in the operator output" >&2
  cat "$TMP/out.txt" >&2
  exit 1
}
if grep -q "fly_abc1234567890xyz" "$TMP/out.txt"; then
  echo "FAIL: a credential leaked into the operator output" >&2
  cat "$TMP/out.txt" >&2
  exit 1
fi
grep -qF "$MARKER" "$TMP/out.txt" || {
  echo "FAIL: expected the credential to be redacted" >&2
  cat "$TMP/out.txt" >&2
  exit 1
}

echo "test: every credential shape is redacted in the operator output"
# One regression case per shape. The shape that leaked before this fix
# (the DSN) is first, because that is the one the operator's own machine
# env carried.
redaction_case() {
  local label="$1" stderr="$2" secret="$3" expected="$4"
  reset_log
  set +e
  FLY_STATUS_EXIT=1 FLY_STATUS_STDERR="$stderr" FLY_API_TOKEN=stub \
    FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" tasks-api \
    >"$TMP/out.txt" 2>&1
  local rc=$?
  set -e
  assert_eq "$label exit code" "2" "$rc"
  if grep -qF "$secret" "$TMP/out.txt"; then
    echo "FAIL: $label leaked a credential into the operator output" >&2
    cat "$TMP/out.txt" >&2
    exit 1
  fi
  grep -qF "$expected" "$TMP/out.txt" || {
    echo "FAIL: $label — expected [$expected] in the operator output" >&2
    cat "$TMP/out.txt" >&2
    exit 1
  }
}

redaction_case "dsn" "postgres://staging:${SECRET_VALUE}@db.example.test/staging" \
  "$SECRET_VALUE" "postgres://${MARKER}@db.example.test/staging"
redaction_case "url credential" "https://user:${SECRET_VALUE}@api.fly.io/" \
  "$SECRET_VALUE" "https://${MARKER}@api.fly.io/"
redaction_case "json credential field" "{\"token\":\"${SECRET_VALUE}\",\"actor\":\"staging\"}" \
  "$SECRET_VALUE" "\"token\":\"${MARKER}\""
redaction_case "authorization header" "Authorization: Bearer ${SECRET_VALUE}" \
  "$SECRET_VALUE" "Authorization: Bearer ${MARKER}"
redaction_case "flyv1 header" "FlyV1 ${SECRET_VALUE}" \
  "$SECRET_VALUE" "FlyV1 ${MARKER}"
redaction_case "name=value assignment" "FLY_API_TOKEN=${SECRET_VALUE}" \
  "$SECRET_VALUE" "FLY_API_TOKEN=${MARKER}"
redaction_case "credential keyword" "token ${SECRET_VALUE}" \
  "$SECRET_VALUE" "token ${MARKER}"
redaction_case "keyword assignment keeps its punctuation" "Error: failed (token=${SECRET_VALUE})" \
  "$SECRET_VALUE" "(token=${MARKER})"

echo "test: the flyctl call runs with direct egress"
reset_log
HTTP_PROXY=http://proxy.invalid:3128 HTTPS_PROXY=http://proxy.invalid:3128 \
  http_proxy=http://proxy.invalid:3128 https_proxy=http://proxy.invalid:3128 \
  SSL_CERT_FILE=/tmp/egress-proxy-bundle.pem SSL_CERT_DIR=/tmp/egress-proxy-certs \
  FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub \
  FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json >"$TMP/out.json"
assert_eq "direct egress exit code" "0" "$?"
grep -qF "ENV: HTTP_PROXY=<unset> HTTPS_PROXY=<unset> http_proxy=<unset> https_proxy=<unset> SSL_CERT_FILE=<unset> SSL_CERT_DIR=<unset>" "$TMP/fly.log" || {
  echo "FAIL: expected the flyctl call to run with the proxy and CA-bundle variables unset" >&2
  cat "$TMP/fly.log" >&2
  exit 1
}

echo "test: the documented escape hatch keeps the operator's environment"
reset_log
HTTP_PROXY=http://proxy.invalid:3128 SSL_CERT_FILE=/tmp/egress-proxy-bundle.pem \
  FLY_STATUS_USE_AMBIENT_PROXY=1 \
  FLY_STATUS_JSON="$(cat "$TMP/platform-healthy.json")" FLY_API_TOKEN=stub \
  FLY_LOG="$TMP/fly.log" PATH="$TMP/bin:$PATH" "$SCRIPT" --json >"$TMP/out.json"
assert_eq "ambient proxy exit code" "0" "$?"
grep -qF "ENV: HTTP_PROXY=http://proxy.invalid:3128" "$TMP/fly.log" || {
  echo "FAIL: expected the escape hatch to keep the operator's proxy variables" >&2
  cat "$TMP/fly.log" >&2
  exit 1
}
grep -qF "SSL_CERT_FILE=/tmp/egress-proxy-bundle.pem" "$TMP/fly.log" || {
  echo "FAIL: expected the escape hatch to keep the operator's trust bundle" >&2
  cat "$TMP/fly.log" >&2
  exit 1
}

echo
echo "OK — all bin/status tests passed"
