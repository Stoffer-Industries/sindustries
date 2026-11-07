#!/usr/bin/env bash
# retired-staging-apps.test.sh — the retired per-service staging apps must
# not come back (task 219fb673).
#
# The staging cutover (2026-11-07) destroyed the four per-service staging
# Fly apps:
#
#   sindustries-tasks-api-staging
#   sindustries-budget-api-staging
#   sindustries-content-scheduler-api-staging
#   sindustries-auto-post-worker-staging
#
# Staging is ONE app now: the consolidated platform
# (sindustries-platform-staging), which hosts all four services as
# supervisor children.
#
# WHY THIS IS A GUARD AND NOT A COMMENT: the platform's auto-post worker
# consumes the same BullMQ queue as the retired worker app. An operator
# path that still resolved to the retired worker app would put TWO
# consumers on one queue, and every scheduled post would be processed
# twice — silently, with no error anywhere, because both consumers are
# healthy. The same path would also re-create the retired apps, which is
# the compute cost the consolidation removed.
#
# The guard is on the EXECUTABLE surfaces: the operator scripts and the
# bootstrap script. Comments may name the retired apps (the header blocks
# explain what was retired and why), so comment lines are stripped before
# the check. A retired app name in an executable position is a failure.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

RETIRED_APPS=(
  sindustries-tasks-api-staging
  sindustries-budget-api-staging
  sindustries-content-scheduler-api-staging
  sindustries-auto-post-worker-staging
)

# The executable surfaces that used to target the retired apps.
OPERATOR_SURFACES=(
  infra/cloud/bin/deploy
  infra/cloud/bin/status
  infra/cloud/bin/rollback
  infra/cloud/scripts/bootstrap-staging.sh
)

failures=0

strip_comments() {
  # Full-line comments only. A trailing comment could hide a retired app
  # name in an executable position, but these scripts keep their prose in
  # full-line comment blocks, and the check below is about CODE.
  grep -v '^[[:space:]]*#' "$1" || true
}

for surface in "${OPERATOR_SURFACES[@]}"; do
  path="$REPO_ROOT/$surface"
  if [[ ! -f "$path" ]]; then
    echo "FAIL: $surface is missing" >&2
    failures=$((failures + 1))
    continue
  fi

  code="$(strip_comments "$path")"

  for app in "${RETIRED_APPS[@]}"; do
    if grep -qF "$app" <<<"$code"; then
      echo "FAIL: $surface still references the retired app $app" >&2
      grep -nF "$app" <<<"$code" | sed 's/^/  /' >&2
      failures=$((failures + 1))
    fi
  done

  # The consolidated app must be the one the operator surfaces name.
  if ! grep -qF "sindustries-platform-staging" <<<"$code"; then
    echo "FAIL: $surface does not reference the consolidated platform app" >&2
    failures=$((failures + 1))
  fi
done

# The per-service fly.toml files are staging configs for apps that no
# longer exist. They are retained as templates for the production
# migration, but no operator surface may deploy them.
for surface in "${OPERATOR_SURFACES[@]}"; do
  path="$REPO_ROOT/$surface"
  [[ -f "$path" ]] || continue
  code="$(strip_comments "$path")"
  for toml in tasks-api budget-api content-scheduler-api auto-post-worker; do
    if grep -qF "infra/cloud/fly/${toml}.fly.toml" <<<"$code"; then
      echo "FAIL: $surface still deploys the retired per-service config infra/cloud/fly/${toml}.fly.toml" >&2
      failures=$((failures + 1))
    fi
  done
done

# The consolidated platform's own config is the only staging config the
# DEPLOYING surfaces may use. `bin/status` does not deploy anything and
# never referenced a fly.toml, so it is not part of this check.
DEPLOYING_SURFACES=(
  infra/cloud/bin/deploy
  infra/cloud/bin/rollback
  infra/cloud/scripts/bootstrap-staging.sh
)
for surface in "${DEPLOYING_SURFACES[@]}"; do
  path="$REPO_ROOT/$surface"
  [[ -f "$path" ]] || continue
  code="$(strip_comments "$path")"
  if grep -qF "infra/cloud/fly/platform.fly.toml" <<<"$code"; then
    continue
  fi
  echo "FAIL: $surface does not reference infra/cloud/fly/platform.fly.toml" >&2
  failures=$((failures + 1))
done

if [[ "$failures" -gt 0 ]]; then
  echo "retired-staging-apps: $failures failure(s)" >&2
  exit 1
fi

echo "retired-staging-apps: ok (${#OPERATOR_SURFACES[@]} operator surfaces)"
