#!/usr/bin/env bash
# shellcheck shell=bash
# restore-result-dir.test.sh — static check that the restore stage writes
# its artifacts into the directory the workflow actually uploads.
#
# Regression guard for task d37681e1. drill.sh receives `--archive-dir`
# (the workflow's `$RUNNER_TEMP/cloud-staging-artifacts`) and passes it to
# migrate.sh and reconcile.mjs as `--result-dir`, but it did NOT pass it to
# restore.sh, and restore.sh had no such option — it hardcoded
# RESULT_PATH="./artifacts/cloud-staging/restore-${CLOUD_DB_RUN_ID}.json".
# The restore result envelope and the pg_restore log therefore landed in a
# repo-relative directory that the upload step never globs, so a failed
# restore produced NO error text in any run artifact. Diagnosing run
# 39545146216 was blocked on exactly this.
#
# This test asserts the four invariants that keep the path threaded end to
# end. It is static (no PostgreSQL needed) and runs in CI via
# `npm run test:cloud-db`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

RESTORE_SH="$REPO_ROOT/scripts/cloud/database/restore.sh"
DRILL_SH="$REPO_ROOT/scripts/cloud/database/drill.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/cloud-staging-db-drill.yml"

for f in "$RESTORE_SH" "$DRILL_SH" "$WORKFLOW"; do
  [[ -f "$f" ]] || { echo "FAIL: $f not found"; exit 1; }
done

failures=0

check() {
  local desc="$1"; shift
  if "$@"; then
    echo "  ok $desc"
  else
    echo "  FAIL $desc"
    failures=$((failures + 1))
  fi
}

# 1. restore.sh must not hardcode the old relative artifact path.
check "restore.sh derives RESULT_PATH from RESULT_DIR" \
  grep -qE '^RESULT_PATH="\$\{RESULT_DIR\}/restore-' "$RESTORE_SH"
check "restore.sh has no hardcoded ./artifacts/cloud-staging RESULT_PATH" \
  bash -c "! grep -qE 'RESULT_PATH=\"\./artifacts' '$RESTORE_SH'"

# 2. restore.sh must accept --result-dir and default it.
check "restore.sh accepts --result-dir" \
  grep -qE '^\s+--result-dir\)' "$RESTORE_SH"
check "restore.sh defaults RESULT_DIR to ./artifacts/cloud-staging" \
  grep -qE '^RESULT_DIR="\$\{RESULT_DIR:-\./artifacts/cloud-staging\}"' "$RESTORE_SH"
check "restore.sh creates the result dir" \
  grep -qE '^mkdir -p "\$RESULT_DIR"' "$RESTORE_SH"

# 3. drill.sh must pass --result-dir at BOTH restore.sh call sites
#    (the normal path and the recovery path). Count restore.sh
#    invocations and how many of those blocks carry the flag. A naive
#    grep for `--result-dir "$ARCHIVE_DIR"` would also match the
#    migrate.sh calls, so walk the continuation blocks instead.
restore_blocks="$(
  awk '
    /restore\.sh" *\\$/ { inb = 1; has = 0; next }
    inb && /--result-dir/ { has = 1 }
    inb && !/ *\\$/ { total++; if (has) good++; inb = 0 }
    END { printf "%d %d", total + 0, good + 0 }
  ' "$DRILL_SH"
)"
block_total="${restore_blocks%% *}"
block_good="${restore_blocks##* }"
check "drill.sh has 2 restore.sh call sites (found ${block_total})" \
  test "$block_total" -eq 2
check "every drill.sh restore call passes --result-dir (${block_good}/${block_total})" \
  test "$block_good" -eq "$block_total"

# 4. The workflow upload glob must include *.log, otherwise the pg_restore
#    error text is still dropped even with the path fixed.
check "workflow uploads *.log artifacts" \
  grep -qE '\$\{\{ runner\.temp \}\}/cloud-staging-artifacts/\*\.log' "$WORKFLOW"

if (( failures > 0 )); then
  echo "FAIL: ${failures} restore result-dir check(s) failed"
  exit 1
fi

echo "ALL restore result-dir checks passed"