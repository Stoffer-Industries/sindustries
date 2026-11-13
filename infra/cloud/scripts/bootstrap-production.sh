#!/usr/bin/env bash
# bootstrap-production.sh — thin wrapper over the shared, environment-aware
# bootstrap (task fb1240c0, Slice B).
#
# The production facts (app name, source names, required sources, deploy
# gate) live in the environment manifest, not in this file. This wrapper
# only selects the environment:
#
#   infra/cloud/scripts/bootstrap-platform.sh --environment production
#
# PRODUCTION IS ONE APP. The production environment runs the consolidated
# platform app (sindustries-platform-production) with every service as a
# supervisor child in ONE Fly process group. The per-service apps were
# never created in production and must not be: the platform's auto-post
# worker is a consumer of the same BullMQ queue as a retired worker app
# would be, so a second consumer would process every scheduled post twice,
# silently, with no error anywhere.
#
# The production path is deliberately narrow:
#
#   - it creates the consolidated production app ONLY if it is absent;
#   - it registers production secrets through the shared provisioner, so a
#     local bootstrap and the CI deploy path cannot register different
#     secrets on the same app;
#   - it runs migrations only when --migrate is passed;
#   - it deploys only when --deploy is passed AND
#     PRODUCTION_PLATFORM_DEPLOY_ENABLED=true;
#   - it never creates a retired per-service app.
#
# The operator contract for the source values is
# infra/cloud/env/bootstrap-production.env.example (placeholders only) and
# docs/cloud/production-source-contract.md (owners and rotation).
#
# Usage:
#   infra/cloud/scripts/bootstrap-production.sh
#   infra/cloud/scripts/bootstrap-production.sh --yes
#   infra/cloud/scripts/bootstrap-production.sh --yes --migrate --deploy
#
# Exit codes:
#   0 = success
#   1 = pre-flight failure (missing CLI / missing env file / missing secret values)
#   2 = Fly API failure (auth, quota, app-create collision that we can't recover)
#   3 = migration failure
#   4 = smoke-deploy failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

exec "${REPO_ROOT}/infra/cloud/scripts/bootstrap-platform.sh" --environment production "$@"
