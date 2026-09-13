#!/usr/bin/env bash
# fly-deploy-trigger-paths.test.sh — AC1 + AC2 regression guard (task 2b66ae79, W38 T3).
#
# AC1: every Fly deploy workflow's `paths:` filter must include
#      `package-lock.json` (MCP also `package.json`) — the W38 audit found
#      three staging workflows pointing at `pnpm-lock.yaml` (which does not
#      exist at the repo root) and the MCP workflow pointing at neither
#      manifest nor lockfile, so a dependency-resolution-only commit could
#      pass CI without firing the affected deploys.
# AC2: synthetic-event generator proves the corrected `paths:` filters
#      select all four workflows on a lockfile-only commit and select
#      none on unrelated docs.
#
# The synthetic-event semantics match GitHub's `paths:` filter: a workflow
# fires when ANY of its declared paths matches (OR-semantics). All four
# workflows use literal-string paths today, not globs; if a future task
# adds glob patterns to one of these workflows, this fixture must be
# extended to honour them. Flagged in the Open Questions of the tech
# design (file: docs/specs/fly-deploy-trigger-paths-tech-design.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
STAGING_WORKFLOWS=(
  "$WORKFLOWS_DIR/deploy-staging-tasks-api.yml"
  "$WORKFLOWS_DIR/deploy-staging-budget-api.yml"
  "$WORKFLOWS_DIR/deploy-staging-auto-post-worker.yml"
)
MCP_WORKFLOW="$WORKFLOWS_DIR/gymtrack-mcp-deploy.yml"

FAIL=0

# Run the bulk of the checks in Python — PyYAML is on the standard image.
python3 - "$REPO_ROOT" "$WORKFLOWS_DIR" "${STAGING_WORKFLOWS[@]}" "$MCP_WORKFLOW" <<'PY' || FAIL=1
import sys, yaml, pathlib

repo_root = pathlib.Path(sys.argv[1])
wf_dir = pathlib.Path(sys.argv[2])
staging = [pathlib.Path(p) for p in sys.argv[3:-1]]
mcp = pathlib.Path(sys.argv[-1])
all_wfs = staging + [mcp]

def load_push_block(path):
    with open(path) as f:
        doc = yaml.safe_load(f)
    if not isinstance(doc, dict):
        raise ValueError(f"{path}: not a YAML mapping")
    # PyYAML coerces bare `on` to boolean True (YAML 1.1 boolean rule).
    on = doc.get("on", doc.get(True))
    if on is None:
        raise ValueError(f"{path}: missing `on:` key")
    if not isinstance(on, dict) or "push" not in on:
        raise ValueError(f"{path}: missing `on.push` mapping")
    push = on["push"]
    if not isinstance(push, dict):
        raise ValueError(f"{path}: `on.push` is not a mapping")
    return push

failures = []

# Static assertions
for path in all_wfs:
    try:
        push = load_push_block(path)
    except Exception as e:
        failures.append(str(e))
        continue
    paths = push.get("paths")
    branches = push.get("branches")
    rel = str(path.relative_to(repo_root))
    if not isinstance(paths, list):
        failures.append(f"{rel}: `on.push.paths` missing or not a list")
        continue
    if "package-lock.json" not in paths:
        failures.append(f"{rel}: `on.push.paths` missing 'package-lock.json' (have: {paths})")
    if not isinstance(branches, list) or "main" not in branches:
        failures.append(f"{rel}: `on.push.branches` must include 'main' (have: {branches})")

# MCP also lists package.json
mcp_push = load_push_block(mcp)
mcp_paths = mcp_push.get("paths") or []
if "package.json" not in mcp_paths:
    failures.append(
        f"{mcp.relative_to(repo_root)}: `on.push.paths` missing 'package.json' "
        f"(have: {mcp_paths})"
    )

# Staging workflows must NOT list pnpm-lock.yaml (regression guard).
# F6 keeps `agents/ash/pnpm-lock.yaml` and `services/tasks-api/pnpm-lock.yaml`
# as separate tracked files (Q3 outstanding); the workflows themselves must
# not select on a path that does not exist at the repo root.
for path in staging:
    push = load_push_block(path)
    paths = push.get("paths") or []
    rel = str(path.relative_to(repo_root))
    if "pnpm-lock.yaml" in paths:
        failures.append(f"{rel}: `on.push.paths` still lists 'pnpm-lock.yaml' (regression)")

# Synthetic-event assertions. GitHub treats `paths:` as OR-semantics: a
# workflow fires when ANY of its declared paths is touched by the commit.
# The four workflows use literal-string paths only (no globs), so a path
# "matches" iff it is one of the declared entries.
def fires_for(paths_list, changed):
    if not paths_list:
        return False  # a workflow with no `paths:` filter fires on every push
    return any(changed == p for p in paths_list)

def all_fires(changed):
    return [
        str(p.relative_to(repo_root))
        for p in all_wfs
        if fires_for(load_push_block(p).get("paths") or [], changed)
    ]

cases = [
    (["package-lock.json"], {str(p.relative_to(repo_root)) for p in all_wfs},
        "lockfile-only commit must select all four deploys"),
    (["package.json"], {str(p.relative_to(repo_root)) for p in all_wfs},
        "package.json commit must select all four deploys"),
    (["docs/specs/foo.md"], set(),
        "docs-only commit must select no deploys"),
    (["apps/website/src/App.jsx"], set(),
        "out-of-scope app source commit must select no deploys"),
]
for changed, expected, why in cases:
    got = set(all_fires(changed[0]))
    if got != expected:
        failures.append(
            f"synthetic commit {changed[0]!r}: expected {sorted(expected)}, "
            f"got {sorted(got)} ({why})"
        )

if failures:
    for msg in failures:
        print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)
PY

[[ "$FAIL" -eq 0 ]] || exit 1
echo "fly-deploy-trigger-paths: ok"