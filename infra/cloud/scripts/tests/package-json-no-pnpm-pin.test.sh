#!/usr/bin/env bash
# package-json-no-pnpm-pin.test.sh — AC3 regression guard (npm-toolchain).
#
# AC3 (post path-(b) decision, Quinn [quinn-decision] id 8d35d4e1 on task
# 5baf6809 at 2026-08-27T02:32:03Z): the repo is npm-managed. This test fails
# CI if any `packageManager` field in the repo-root package.json points at
# pnpm, which would re-introduce the unverified-claim trap from PR #535
# (a one-line pnpm pin that pinned a version nothing actually exercised
# while the Dockerfile install kept failing). Closes W35 audit OQ1.
#
# Refs:
#   - 5baf6809 [quinn-decision] (b) align to repo's npm toolchain.
#   - W35 repo audit (PR #520): "corepack-pnpm drift" finding, now resolved
#     by removing the dual-manager surface.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
PKG_JSON="$REPO_ROOT/package.json"
[[ -f "$PKG_JSON" ]] || { echo "FAIL: $PKG_JSON not found (REPO_ROOT=$REPO_ROOT)"; exit 1; }

# Extract via python3 — robust to whitespace and other formatting noise.
PKG_MANAGER=$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("packageManager", ""))
' "$PKG_JSON")

# A non-empty packageManager pointing at pnpm re-introduces the dual-manager
# trap (PR #535 lesson). An empty/missing packageManager is the npm-only
# state we want; repointing to npm is allowed but discouraged (the field
# exists for non-npm managers and npm doesn't honor it the same way).
if [[ -n "$PKG_MANAGER" ]] && [[ "$PKG_MANAGER" == pnpm@* ]]; then
  printf 'FAIL: packageManager=%q (repo is npm-only; remove the pnpm pin)\n' "$PKG_MANAGER" >&2
  exit 1
fi

echo "package-json-no-pnpm-pin: ok (no pnpm pin)"
