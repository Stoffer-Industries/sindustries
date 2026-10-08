#!/usr/bin/env bash
# manifest-constraints.test.sh — static check on the reconciliation manifests.
#
# The naive `;\n` SQL splitter in reconcile.mjs is exact only if the
# manifests avoid a small set of patterns that would defeat it:
#   - `$$ ... $$` dollar-quoted bodies
#   - `E'...'` escape-string literals
#   - backslashes inside a single-quoted string literal
#   - embedded single quotes inside a single-quoted string literal
#     (i.e. two adjacent single-quoted strings — Postgres concatenates
#      them at parse time, the splitter would not)
#
# Every manifest must also end its final statement with `;` followed by
# a newline so the splitter's `;\s*\n` regex matches.
#
# This test grep's each manifest for the forbidden patterns and exits
# non-zero on any hit. It is intended to run in CI alongside
# common.test.sh via `npm run test:cloud-db`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

MANIFESTS=(
  "$REPO_ROOT/services/tasks-api/ops/reconciliation.sql"
  "$REPO_ROOT/services/budget-api/ops/reconciliation.sql"
)

# Patterns are intentionally grep -E extended regexes; the test reports
# each forbidden pattern in plain English on failure.
forbidden=(
  "dollar-quoted body|\\$\\$"
  "escape-string literal|\\bE'[^']"
  "backslash inside single-quoted literal|'[^']*\\\\[^']*'"
  "adjacent single-quoted literals|'[^']*'[[:space:]]*'[^']*'"
)

fail=0
for manifest in "${MANIFESTS[@]}"; do
  if [[ ! -f "$manifest" ]]; then
    echo "FAIL: $manifest not found" >&2
    fail=1
    continue
  fi
  for entry in "${forbidden[@]}"; do
    name="${entry%%|*}"
    pattern="${entry#*|}"
    if grep -nE -- "$pattern" "$manifest" >/dev/null 2>&1; then
      echo "FAIL: $manifest contains forbidden pattern: $name" >&2
      grep -nE -- "$pattern" "$manifest" >&2 || true
      fail=1
    fi
  done
  # Every statement must end with `;` then newline so the splitter's
  # `;\s*\n` regex matches. The splitter tolerates trailing comments
  # and whitespace, so we check the last non-empty, non-comment line.
  last_stmt_line="$(
    grep -vE '^\s*(--|$)' "$manifest" | tail -n 1
  )"
  if [[ -n "$last_stmt_line" ]] && ! [[ "$last_stmt_line" =~ \;[[:space:]]*$ ]]; then
    echo "FAIL: $manifest: final statement does not end with ';' (line: $last_stmt_line)" >&2
    fail=1
  fi
done

if (( fail )); then
  exit 1
fi

echo "ALL reconciliation-manifest constraint checks passed"
