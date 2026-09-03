#!/usr/bin/env bash
# mission-control-deploy-fixtures.test.sh — structural guard for the
# Mission Control + Tasks app staging deployment fixtures.
#
# Catches the regression mode where someone ships the Dockerfile
# without the fly.toml (or the fly.toml without the .env.example), so
# the deploy command in the runbook fails at the first `fly deploy`.
#
# The test asserts that for each app:
#   - infra/cloud/docker/<app>.Dockerfile exists
#   - infra/cloud/fly/<app>.fly.toml exists with context = '../../..'
#     (also covered by fly-toml-context.test.sh; repeated here so the
#     four-tuple is checked together)
#   - infra/cloud/env/<app>.env.example exists with at least one
#     VITE_-prefixed build arg documented
#   - infra/runbooks/mission-control-staging.md mentions the app by name
#     so the runbook stays in sync with the deployable units

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

APPS=(mission-control tasks-app)
RUNBOOK="$REPO_ROOT/infra/runbooks/mission-control-staging.md"

FAIL=0
for app in "${APPS[@]}"; do
  dockerfile="$REPO_ROOT/infra/cloud/docker/$app.Dockerfile"
  fly_toml="$REPO_ROOT/infra/cloud/fly/$app.fly.toml"
  env_example="$REPO_ROOT/infra/cloud/env/$app.env.example"

  # 1. Dockerfile exists.
  if [[ ! -f "$dockerfile" ]]; then
    printf 'FAIL: missing %s\n' "${dockerfile#"$REPO_ROOT"/}" >&2
    FAIL=1
  fi

  # 2. fly.toml exists and context = '../../..' (matches existing
  #    fly-toml-context.test.sh rule — repeated for atomicity).
  if [[ ! -f "$fly_toml" ]]; then
    printf 'FAIL: missing %s\n' "${fly_toml#"$REPO_ROOT"/}" >&2
    FAIL=1
  else
    ctx=$(awk -F"'" '/^[[:space:]]*context[[:space:]]*=/ {print $2; exit}' "$fly_toml")
    if [[ "$ctx" != "../../.." ]]; then
      printf 'FAIL: %s context=%q (expected "../../..")\n' \
        "${fly_toml#"$REPO_ROOT"/}" "$ctx" >&2
      FAIL=1
    fi
    dockerfile_ref=$(awk -F"'" '/^[[:space:]]*dockerfile[[:space:]]*=/ {print $2; exit}' "$fly_toml")
    expected="infra/cloud/docker/$app.Dockerfile"
    if [[ "$dockerfile_ref" != "$expected" ]]; then
      printf 'FAIL: %s dockerfile=%q (expected %q)\n' \
        "${fly_toml#"$REPO_ROOT"/}" "$dockerfile_ref" "$expected" >&2
      FAIL=1
    fi
  fi

  # 3. .env.example exists with at least one VITE_-prefixed build arg.
  if [[ ! -f "$env_example" ]]; then
    printf 'FAIL: missing %s\n' "${env_example#"$REPO_ROOT"/}" >&2
    FAIL=1
  else
    if ! grep -qE '^[[:space:]]*VITE_[A-Z0-9_]+=' "$env_example"; then
      printf 'FAIL: %s has no VITE_-prefixed build arg\n' \
        "${env_example#"$REPO_ROOT"/}" >&2
      FAIL=1
    fi
  fi

  # 4. Runbook mentions the app by name.
  if [[ ! -f "$RUNBOOK" ]]; then
    printf 'FAIL: missing %s\n' "${RUNBOOK#"$REPO_ROOT"/}" >&2
    FAIL=1
  elif ! grep -q "$app" "$RUNBOOK"; then
    printf 'FAIL: runbook does not mention %s\n' "$app" >&2
    FAIL=1
  fi
done

if [[ ! -f "$REPO_ROOT/infra/cloud/docker/spa-nginx.conf" ]]; then
  printf 'FAIL: missing %s\n' "infra/cloud/docker/spa-nginx.conf" >&2
  FAIL=1
fi

[[ "$FAIL" -eq 0 ]] || exit 1
echo "mission-control-deploy-fixtures: ok"
