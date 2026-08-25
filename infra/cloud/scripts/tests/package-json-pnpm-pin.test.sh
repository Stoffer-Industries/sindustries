#!/usr/bin/env bash
# package-json-pnpm-pin.test.sh — AC3 regression guard.
#
# AC3: pin `packageManager` in the repo-root package.json so Corepack
# downloads a pnpm version that still understands the npm-style
# `workspaces` field (apps/*, packages/*, services/*). pnpm 11.x dropped
# npm-style workspace support; pnpm 10.14.0 retains it. Pinning also
# makes Docker builds reproducible across host machines.
#
# Refs:
#   - W35 repo audit (PR #520, merged): "corepack-pnpm drift" finding
#     recommends pinning packageManager in root package.json.
#   - 5baf6809 tech design: bundle the pin into the Fly-staging-deploy-fixes
#     PR per Quinn's (a) decision (2026-08-25T16:17:43Z approval note).

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

if [[ "$PKG_MANAGER" != "pnpm@10.14.0" ]]; then
  printf 'FAIL: packageManager=%q (expected "pnpm@10.14.0")\n' "$PKG_MANAGER" >&2
  exit 1
fi

echo "package-json-pnpm-pin: ok ($PKG_MANAGER)"
