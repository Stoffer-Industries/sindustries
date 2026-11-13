#!/usr/bin/env bash
# bootstrap-staging.sh — thin wrapper over the shared, environment-aware
# bootstrap (task fb1240c0, Slice B).
#
# The staging facts (app name, source names, required sources, deploy gate)
# live in the environment manifest, not in this file. This wrapper only
# selects the environment:
#
#   infra/cloud/scripts/bootstrap-platform.sh --environment staging
#
# Usage:
#   infra/cloud/scripts/bootstrap-staging.sh                # interactive (default)
#   infra/cloud/scripts/bootstrap-staging.sh --yes          # non-interactive; secrets + create only
#   infra/cloud/scripts/bootstrap-staging.sh --yes --migrate --deploy
#                                                          # full bootstrap, no prompts
#   infra/cloud/scripts/bootstrap-staging.sh --service platform --yes
#                                                          # the only service (default)
#
# STAGING IS ONE APP (task 219fb673; cutover 2026-11-07). The four
# per-service staging Fly apps — sindustries-tasks-api-staging,
# sindustries-budget-api-staging, sindustries-content-scheduler-api-staging
# and sindustries-auto-post-worker-staging — were destroyed at the cutover.
# Staging now runs the consolidated platform app
# (sindustries-platform-staging), which hosts all four services as
# supervisor children in ONE Fly process group. The retired per-service
# apps must not be recreated: the platform's auto-post worker is a consumer
# of the same BullMQ queue as the retired worker app, so a resurrected
# per-service worker would process every scheduled post twice, silently,
# with no error anywhere.
#
# Exit codes:
#   0 = success
#   1 = pre-flight failure (missing CLI / missing .env.local / missing secret values)
#   2 = Fly API failure (auth, quota, app-create collision that we can't recover)
#   3 = migration failure
#   4 = smoke-deploy failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

exec "${REPO_ROOT}/infra/cloud/scripts/bootstrap-platform.sh" --environment staging "$@"
