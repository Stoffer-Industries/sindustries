#!/usr/bin/env bash
# Scripted negative control for the merge-gate secret scan (task 2b3962b1).
#
# The static and behavioural contract tests prove the entrypoint detects a
# synthetic secret. They do not prove that the *merge gate* fails, because
# that is a property of the workflow, not of the script. This control
# produces that evidence: it publishes a synthetic canary token on a
# throwaway branch, opens a pull request so the `pull_request` trigger runs,
# reads the `gitleaks secret scan` and `merge gate` job conclusions, and
# asserts that both are `failure`.
#
# The canary token is a synthetic, non-credential marker detected by the
# test-only rule `sindustries-secret-scan-canary` in .gitleaks.toml. It
# cannot leak anything, and the branch and pull request are deleted when
# the control finishes.
#
# Usage:
#   secret-scan-negative-control.sh [--keep]
#
#   --keep   leave the throwaway branch and pull request in place (for
#            debugging a failed control); they are closed otherwise.
#
# Requirements: `gh` authenticated with push access to the repository, and
# a clean working tree on the canonical checkout.

set -euo pipefail

KEEP=0
if [ "${1:-}" = "--keep" ]; then
  KEEP=1
elif [ "$#" -gt 0 ]; then
  echo "usage: secret-scan-negative-control.sh [--keep]" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CANARY_FILE="infra/cloud/secret-scan-canary.txt"
CANARY_VALUE="SINDUSTRIES_SECRET_SCAN_CANARY_$(date +%s)0123456789ABCDEF"
BRANCH="ci/secret-scan-negative-control"
REPO_SLUG="Stoffer-Industries/sindustries"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh-quinn}"

if ! command -v gh >/dev/null 2>&1; then
  echo "negative-control: gh not found on PATH" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "negative-control: the working tree is dirty; commit or stash first" >&2
  exit 1
fi

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "negative-control: --keep given; leaving the branch and pull request in place" >&2
    return
  fi
  if [ -n "${PR_NUMBER:-}" ]; then
    gh pr close "$PR_NUMBER" --repo "$REPO_SLUG" --comment \
      "Secret-scan negative control: synthetic canary, expected to fail." >/dev/null 2>&1 || true
  fi
  git push origin --delete "$BRANCH" >/dev/null 2>&1 || true
  git checkout -q main 2>/dev/null || true
  git branch -q -D "$BRANCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "negative-control: publishing the synthetic canary on $BRANCH"
git fetch -q origin main
git checkout -q -B "$BRANCH" origin/main
mkdir -p "$(dirname "$CANARY_FILE")"
printf '%s\n' "$CANARY_VALUE" > "$CANARY_FILE"
git add "$CANARY_FILE"
git commit -q -m "test(ci): synthetic secret-scan canary for the merge-gate negative control"
git push -q --force-with-lease origin "$BRANCH"

echo "negative-control: opening the pull request"
PR_NUMBER="$(gh pr create --repo "$REPO_SLUG" --base main --head "$BRANCH" \
  --title "test(ci): synthetic secret-scan canary (negative control)" \
  --body "Synthetic canary token for the merge-gate secret-scan negative control. The \`gitleaks secret scan\` and \`merge gate\` jobs are expected to FAIL. This pull request is closed and its branch deleted when the control finishes." \
  | grep -oE '[0-9]+$')"
echo "negative-control: pull request #$PR_NUMBER"

HEAD_SHA="$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)"
echo "negative-control: head $HEAD_SHA"

echo "negative-control: waiting for the pull-request run"
RUN_ID=""
for _ in $(seq 1 60); do
  sleep 15
  RUN_ID="$(gh run list --repo "$REPO_SLUG" --branch "$BRANCH" --limit 20 \
    --json databaseId,headSha,event,status \
    --jq "[.[] | select(.headSha == \"$HEAD_SHA\" and .event == \"pull_request\")][0].databaseId // empty")"
  if [ -n "$RUN_ID" ]; then
    break
  fi
  echo "negative-control: no run for $HEAD_SHA yet"
done
if [ -z "$RUN_ID" ]; then
  echo "negative-control: no pull_request run appeared for $HEAD_SHA" >&2
  exit 1
fi
echo "negative-control: run $RUN_ID"

echo "negative-control: waiting for the run to finish"
gh run watch "$RUN_ID" --repo "$REPO_SLUG" --exit-status >/dev/null 2>&1 || true

SCAN_CONCLUSION="$(gh run view "$RUN_ID" --repo "$REPO_SLUG" --json jobs \
  --jq '[.jobs[] | select(.name == "gitleaks secret scan")][0].conclusion // "missing"')"
GATE_CONCLUSION="$(gh run view "$RUN_ID" --repo "$REPO_SLUG" --json jobs \
  --jq '[.jobs[] | select(.name == "merge gate")][0].conclusion // "missing"')"

echo "negative-control: run URL   https://github.com/$REPO_SLUG/actions/runs/$RUN_ID"
echo "negative-control: gitleaks secret scan -> $SCAN_CONCLUSION"
echo "negative-control: merge gate           -> $GATE_CONCLUSION"

if [ "$SCAN_CONCLUSION" != "failure" ]; then
  echo "negative-control: FAILED — the secret-scan job concluded '$SCAN_CONCLUSION', expected 'failure'" >&2
  exit 1
fi
if [ "$GATE_CONCLUSION" != "failure" ]; then
  echo "negative-control: FAILED — the merge gate concluded '$GATE_CONCLUSION', expected 'failure'" >&2
  exit 1
fi

echo "negative-control: OK — a synthetic secret fails both the secret scan and the merge gate"
