#!/usr/bin/env bash
# shellcheck shell=bash
# source-schema-model-match.test.sh — regression guard for the source
# schema gate added by task f2c23e26 (production data migration).
#
# The failure this guards:
#
#   The restore copies the source schema wholesale -- every table, every
#   row, including tables the repository's schema.prisma does not model.
#   The drill's cleanup step drops the live destination schemas first, so
#   an unmodelled source table lands in production as permanent drift,
#   after the destination has already been destroyed.
#
#   Measured on the live prodlike source (read-only, 2026-11-23): the
#   tasks_api schema carries ContentSchedulerItem (29 rows, orphaned by
#   the schema split) and Task_blocked_ready_backup (48 rows, left behind
#   by the rolled-back add_blocked_ready_columns migration). Neither is
#   modelled by services/tasks-api/prisma/schema.prisma, and no later
#   `prisma migrate` run would ever reconcile or prune them.
#
#   The gate is read-only and runs BEFORE the destination cleanup, so a
#   source that does not match the model refuses while the live
#   destination is still intact.
#
# It is behavioural rather than a grep over source: a stub psql on PATH
# answers the catalogue queries with canned rows, and the real script
# runs its real comparison against them. No PostgreSQL needed.
#
# It also pins the ORDERING that makes the gate worth having: the drill
# must run the gate before it runs the destructive destination cleanup.
#
# Runs in CI via the `offline contract tests` job.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-toplevel 2>/dev/null || git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

GATE_SH="$REPO_ROOT/scripts/cloud/database/assert-source-schema-matches-model.sh"
DRILL_SH="$REPO_ROOT/scripts/cloud/database/drill.sh"

for f in "$GATE_SH" "$DRILL_SH"; do
  [[ -f "$f" ]] || { echo "FAIL: $f not found"; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "  ok $1"; }
fail() { echo "  FAIL $1"; failures=$((failures + 1)); }

# ---------------------------------------------------------------------------
# Stub toolchain
# ---------------------------------------------------------------------------

BIN="$WORK/bin"
mkdir -p "$BIN"

cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
# Stub psql: answers the source table inventory from env vars and logs
# every statement it is handed, so a test can assert the gate never
# issues a write.
if [[ "$*" == *"--version"* ]]; then
  echo "psql (PostgreSQL) 18.3"
  exit 0
fi

printf '%s\n' "$*" >> "${STUB_PSQL_LOG:-/dev/null}"

dbname=""
for arg in "$@"; do
  case "$arg" in
    --dbname=*) dbname="${arg#--dbname=}" ;;
  esac
done

if [[ "$dbname" == *"tasks"* ]]; then
  printf '%s' "${STUB_TASKS_INVENTORY:-[]}"
else
  printf '%s' "${STUB_CONTENT_INVENTORY:-[]}"
fi
STUB
chmod +x "$BIN/psql"

cat > "$BIN/pg_dump" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "pg_dump (PostgreSQL) 18.3"
  exit 0
fi
exit 0
STUB
chmod +x "$BIN/pg_dump"

cat > "$BIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "pg_restore (PostgreSQL) 18.3"
  exit 0
fi
exit 0
STUB
chmod +x "$BIN/pg_restore"

cat > "$BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
exec shasum -a 256 "$@"
STUB
chmod +x "$BIN/sha256sum"

cat > "$BIN/openssl" <<'STUB'
#!/usr/bin/env bash
exec /usr/bin/openssl "$@"
STUB
chmod +x "$BIN/openssl"

export PATH="$BIN:$PATH"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

TASKS_DSN_FILE="$WORK/tasks-source.dsn"
CS_DSN_FILE="$WORK/content-scheduler-source.dsn"
printf '%s' "postgresql://stage_user@127.0.0.1:5432/sindustries_staging_tasks_src" > "$TASKS_DSN_FILE"
printf '%s' "postgresql://stage_user@127.0.0.1:5432/sindustries_staging_cs_src" > "$CS_DSN_FILE"
chmod 0600 "$TASKS_DSN_FILE" "$CS_DSN_FILE"

RESULTS_DIR="$WORK/results"
mkdir -p "$RESULTS_DIR"

# The repository's own model lists drive the comparison, so the expected
# inventory is read from the same schema files the gate reads.
expected_tasks_tables() {
  python3 - "$REPO_ROOT/services/tasks-api/prisma/schema.prisma" <<'PY'
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
names = []
for match in re.finditer(r"^model\s+(\w+)\s*\{", text, re.MULTILINE):
    start = match.end()
    depth, index = 1, start
    while index < len(text) and depth > 0:
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    block = text[start:index]
    renamed = re.search(r'@@map\(\s*"([^"]+)"\s*\)', block)
    names.append(renamed.group(1) if renamed else match.group(1))
print(json.dumps([{"table_name": n, "estimated_rows": 3} for n in sorted(names)]))
PY
}

expected_cs_tables() {
  python3 - "$REPO_ROOT/services/content-scheduler-api/prisma/schema.prisma" <<'PY'
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
names = []
for match in re.finditer(r"^model\s+(\w+)\s*\{", text, re.MULTILINE):
    start = match.end()
    depth, index = 1, start
    while index < len(text) and depth > 0:
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    block = text[start:index]
    renamed = re.search(r'@@map\(\s*"([^"]+)"\s*\)', block)
    names.append(renamed.group(1) if renamed else match.group(1))
print(json.dumps([{"table_name": n, "estimated_rows": 3} for n in sorted(names)]))
PY
}

MATCHING_TASKS="$(expected_tasks_tables)"
MATCHING_CS="$(expected_cs_tables)"

run_gate() {
  # run_gate <tasks-inventory-json> <content-inventory-json>
  STUB_TASKS_INVENTORY="$1" \
  STUB_CONTENT_INVENTORY="$2" \
  STUB_PSQL_LOG="$WORK/psql.log" \
  "$GATE_SH" \
    --source-tasks-dsn-file "$TASKS_DSN_FILE" \
    --source-content-scheduler-dsn-file "$CS_DSN_FILE" \
    --result-dir "$RESULTS_DIR" \
    --environment staging \
    > "$WORK/stdout.txt" 2> "$WORK/stderr.txt"
}

# ---------------------------------------------------------------------------
# Case 1: a source that matches the model passes
# ---------------------------------------------------------------------------

if run_gate "$MATCHING_TASKS" "$MATCHING_CS"; then
  pass "a source schema matching the repository model passes"
else
  fail "a source schema matching the repository model should pass: $(cat "$WORK/stderr.txt")"
fi

# ---------------------------------------------------------------------------
# Case 2: an unmodelled source table refuses, and is named
# ---------------------------------------------------------------------------

UNEXPECTED="$(python3 - "$MATCHING_TASKS" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
rows.append({"table_name": "ContentSchedulerItem", "estimated_rows": 29})
print(json.dumps(rows))
PY
)"

if run_gate "$UNEXPECTED" "$MATCHING_CS"; then
  fail "a source carrying an unmodelled table should refuse"
else
  pass "a source carrying an unmodelled table refuses"
  if grep -q "ContentSchedulerItem" "$WORK/stderr.txt"; then
    pass "the refusal names the unmodelled table"
  else
    fail "the refusal must name the unmodelled table; got: $(cat "$WORK/stderr.txt")"
  fi
  if grep -q "29" "$WORK/stderr.txt"; then
    pass "the refusal reports the row count the table would carry"
  else
    fail "the refusal should report the estimated row count"
  fi
fi

# ---------------------------------------------------------------------------
# Case 3: a source missing a modelled table refuses, and is named
# ---------------------------------------------------------------------------

MISSING="$(python3 - "$MATCHING_TASKS" <<'PY'
import json, sys
rows = [r for r in json.loads(sys.argv[1]) if r["table_name"] != "TaskApproval"]
print(json.dumps(rows))
PY
)"

if run_gate "$MISSING" "$MATCHING_CS"; then
  fail "a source missing a modelled table should refuse"
else
  pass "a source missing a modelled table refuses"
  if grep -q "TaskApproval" "$WORK/stderr.txt"; then
    pass "the refusal names the missing table"
  else
    fail "the refusal must name the missing table; got: $(cat "$WORK/stderr.txt")"
  fi
fi

# ---------------------------------------------------------------------------
# Case 4: the gate is read-only
# ---------------------------------------------------------------------------

: > "$WORK/psql.log"
run_gate "$UNEXPECTED" "$MATCHING_CS" >/dev/null 2>&1 || true
if grep -qiE '\b(insert|update|delete|drop|alter|create|truncate)\b' "$WORK/psql.log"; then
  fail "the gate must only read the source; it issued a write: $(cat "$WORK/psql.log")"
else
  pass "the gate only reads the source"
fi

# ---------------------------------------------------------------------------
# Case 5: the drill runs the gate BEFORE the destructive cleanup
# ---------------------------------------------------------------------------

gate_line="$(grep -n 'assert-source-schema-matches-model.sh' "$DRILL_SH" | head -1 | cut -d: -f1)"
cleanup_line="$(grep -n 'cleanup-destination.sh' "$DRILL_SH" | head -1 | cut -d: -f1)"

if [[ -z "$gate_line" || -z "$cleanup_line" ]]; then
  fail "the drill must invoke both the gate and the destination cleanup"
elif (( gate_line < cleanup_line )); then
  pass "the drill runs the gate before the destination cleanup (gate line ${gate_line}, cleanup line ${cleanup_line})"
else
  fail "the gate must run BEFORE the destructive cleanup (gate line ${gate_line}, cleanup line ${cleanup_line})"
fi

# ---------------------------------------------------------------------------
# Case 6: the gate is wired into the drill, not merely present
# ---------------------------------------------------------------------------

if grep -q 'assert-source-schema-matches-model.sh' "$DRILL_SH"; then
  pass "the drill invokes the source schema gate"
else
  fail "the drill must invoke the source schema gate"
fi

if [[ -n "$(ls -1 "$RESULTS_DIR" 2>/dev/null)" ]]; then
  pass "the gate writes a redacted result envelope"
else
  fail "the gate must write a result envelope"
fi

# ---------------------------------------------------------------------------

if (( failures > 0 )); then
  echo "FAIL: ${failures} source-schema-model-match check(s) failed"
  exit 1
fi

echo "ALL source-schema-model-match checks passed"
