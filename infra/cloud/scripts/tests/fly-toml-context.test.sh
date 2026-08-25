#!/usr/bin/env bash
# fly-toml-context.test.sh — AC2 regression guard.
#
# `context` in fly.toml is resolved relative to the file's location, so
# for files at `infra/cloud/fly/<svc>.fly.toml` the repo root is exactly
# three levels up: `../../..`. The previous value `../../` resolved to
# `infra/`, which only "worked" because the broken tasks-api Dockerfile
# happened to be invoked from a CI working dir that papered over it.
#
# This test fails CI if any `infra/cloud/fly/*.fly.toml` regresses to
# the old `../../` (or any non-repo-root value).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
FLY_DIR="$REPO_ROOT/infra/cloud/fly"

FAIL=0
shopt -s nullglob
for toml in "$FLY_DIR"/*.fly.toml; do
  ctx=$(awk -F"'" '/^[[:space:]]*context[[:space:]]*=/ {print $2; exit}' "$toml")
  if [[ "$ctx" != "../../.." ]]; then
    printf 'FAIL: %s context=%q (expected "../../..")\n' \
      "${toml#"$REPO_ROOT"/}" "$ctx" >&2
    FAIL=1
  fi
done
shopt -u nullglob

[[ "$FAIL" -eq 0 ]] || exit 1
echo "fly-toml-context: ok"
