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

# The consolidated app every staging surface resolves to now.
CONSOLIDATED_PLATFORM_APP="sindustries-platform-staging"

# The executable surfaces that used to target the retired apps, plus the
# two surfaces that still reference them after the cutover: the guided
# failure drill (its scenarios scaled the per-service apps) and the
# staging validation workflow (it woke a per-service Machine and read its
# targets from staging environment variables).
#
# The bootstrap is NOT in this list: since task fb1240c0 (Slice B) it
# resolves the app name from the ENVIRONMENT MANIFEST instead of naming
# an app literally, so "does this surface name the consolidated app" is
# the wrong question for it — the right question is "does this surface
# resolve the app name from the manifest, and does the manifest name the
# consolidated app". BOOTSTRAP_SURFACES below asserts exactly that.
OPERATOR_SURFACES=(
  infra/cloud/bin/deploy
  infra/cloud/bin/status
  infra/cloud/bin/rollback
  infra/cloud/observability/failure-inject.sh
  .github/workflows/cloud-staging-validate.yml
)

# The bootstrap surfaces: the shared implementation and its two thin
# wrappers.
BOOTSTRAP_SURFACES=(
  infra/cloud/scripts/bootstrap-platform.sh
  infra/cloud/scripts/bootstrap-staging.sh
  infra/cloud/scripts/bootstrap-production.sh
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
for surface in "${OPERATOR_SURFACES[@]}" "${BOOTSTRAP_SURFACES[@]}"; do
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

# ---------- the bootstrap surfaces resolve the app from the manifest ------
#
# The bootstrap must not carry a SECOND copy of the environment facts: an
# app name hard-coded in the script is a copy that drifts, and a drifted
# copy provisions the wrong app. So the bootstrap surfaces must NOT name
# a platform app literally, and the manifest must name the consolidated
# app (and the shared config) for both environments.
for surface in "${BOOTSTRAP_SURFACES[@]}"; do
  path="$REPO_ROOT/$surface"
  if [[ ! -f "$path" ]]; then
    echo "FAIL: $surface is missing" >&2
    failures=$((failures + 1))
    continue
  fi
  code="$(strip_comments "$path")"
  for app in sindustries-platform-staging sindustries-platform-production sindustries-health-probe-staging sindustries-health-probe-production; do
    if grep -qF "$app" <<<"$code"; then
      echo "FAIL: $surface hard-codes the app name '$app'; the app name belongs to the environment manifest" >&2
      failures=$((failures + 1))
    fi
  done
  for app in "${RETIRED_APPS[@]}"; do
    if grep -qF "$app" <<<"$code"; then
      echo "FAIL: $surface still references the retired app $app" >&2
      failures=$((failures + 1))
    fi
  done
done

FACTS_CLI="$REPO_ROOT/infra/cloud/platform/platform-environment-facts.mjs"
if [[ ! -f "$FACTS_CLI" ]]; then
  echo "FAIL: $FACTS_CLI is missing — the bootstrap resolves the app name from it" >&2
  failures=$((failures + 1))
else
  for surface in "${BOOTSTRAP_SURFACES[@]}"; do
    path="$REPO_ROOT/$surface"
    code="$(strip_comments "$path")"
    if ! grep -qF "platform-environment-facts.mjs" <<<"$code" \
       && ! grep -qF "bootstrap-platform.sh" <<<"$code"; then
      echo "FAIL: $surface does not resolve the environment facts (or delegate to the shared bootstrap)" >&2
      failures=$((failures + 1))
    fi
  done
  # The manifest side of the contract: the consolidated staging app, the
  # production app, and the shared config path both environments deploy.
  if [[ "$(node "$FACTS_CLI" --environment staging --field platformApp)" != "$CONSOLIDATED_PLATFORM_APP" ]]; then
    echo "FAIL: the environment manifest does not name the consolidated staging app" >&2
    failures=$((failures + 1))
  fi
  if [[ "$(node "$FACTS_CLI" --environment production --field platformApp)" != "sindustries-platform-production" ]]; then
    echo "FAIL: the environment manifest does not name the consolidated production app" >&2
    failures=$((failures + 1))
  fi
  for environment in staging production; do
    if [[ "$(node "$FACTS_CLI" --environment "$environment" --field artefacts.flyConfig.shared)" != "infra/cloud/fly/platform.fly.toml" ]]; then
      echo "FAIL: the $environment environment does not deploy the consolidated platform config" >&2
      failures=$((failures + 1))
    fi
  done
fi

if [[ "$failures" -gt 0 ]]; then
  echo "retired-staging-apps: $failures failure(s)" >&2
  exit 1
fi

# The service-scoped outage scenarios must REFUSE the consolidated
# platform app. Scaling it to 0 machines takes down ALL FOUR services, so
# a "tasks-api-down" drill that scaled the platform would be a
# full-platform outage wearing a service-scoped label — the exact silent
# hazard this guard exists to prevent. Assert the behaviour, not a
# comment: the refusal must be called from the scenario body.
FAILURE_INJECT="infra/cloud/observability/failure-inject.sh"

scenario_body() {
  # Print the body of a shell function up to its closing brace.
  awk -v fn="$1" '
    $0 ~ "^"fn"\\(\\) \\{" { inside=1; next }
    inside && /^}/ { exit }
    inside { print }
  ' "$2"
}

for scenario in scenario_tasks_api_down scenario_budget_api_down; do
  body="$(scenario_body "${scenario}" "${REPO_ROOT}/${FAILURE_INJECT}")"
  if [[ -z "${body}" ]]; then
    echo "FAIL: ${FAILURE_INJECT} has no ${scenario} function" >&2
    failures=$((failures + 1))
    continue
  fi
  if ! grep -q "refuse_service_scoped_target" <<<"${body}"; then
    echo "FAIL: ${FAILURE_INJECT} ${scenario} does not refuse a service-scoped target" >&2
    failures=$((failures + 1))
  fi
done

# Assert the refusal BEHAVIOURS, not just that a call is present:
#   --dry-run  must exit 0 and say REFUSED (the task-31233a0a contract is
#              "a preview has no side effects and needs no credentials"),
#              and must NOT print the command it refused.
#   real run   must exit 1 without touching Fly — including when the target
#              is the consolidated platform, which is the footgun this
#              guard exists to prevent.
for scenario in tasks-api-down budget-api-down tasks-api-up budget-api-up; do
  set +e
  dry_out="$(bash "${REPO_ROOT}/${FAILURE_INJECT}" "${scenario}" --dry-run 2>&1)"
  dry_code=$?
  real_out="$(bash "${REPO_ROOT}/${FAILURE_INJECT}" "${scenario}" --app "${CONSOLIDATED_PLATFORM_APP}" 2>&1)"
  real_code=$?
  set -e
  if [[ "${dry_code}" -ne 0 ]]; then
    echo "FAIL: ${FAILURE_INJECT} ${scenario} --dry-run exited ${dry_code}; the preview contract is exit 0" >&2
    failures=$((failures + 1))
  elif ! grep -q "REFUSED" <<<"${dry_out}"; then
    echo "FAIL: ${FAILURE_INJECT} ${scenario} --dry-run does not report the refusal" >&2
    failures=$((failures + 1))
  elif grep -q "scale count" <<<"${dry_out}"; then
    echo "FAIL: ${FAILURE_INJECT} ${scenario} --dry-run prints the command it refused" >&2
    failures=$((failures + 1))
  fi
  if [[ "${real_code}" -eq 0 ]]; then
    echo "FAIL: ${FAILURE_INJECT} ${scenario} against the consolidated platform exited 0; it must refuse" >&2
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  echo "retired-staging-apps: $failures failure(s)" >&2
  exit 1
fi

echo "retired-staging-apps: ok (${#OPERATOR_SURFACES[@]} operator surfaces)"
