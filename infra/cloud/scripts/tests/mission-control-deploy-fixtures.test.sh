#!/usr/bin/env bash
# mission-control-deploy-fixtures.test.sh — structural guard for the
# Mission Control + Tasks app Vercel staging deployment fixtures.
#
# Catches regressions where a project loses its Vercel monorepo build
# contract or the retired Fly frontend deployment is reintroduced.
#
# The test asserts that for each app:
#   - apps/<app>/vercel.json exists at the configured Vercel project root
#   - each project runs its local Vite build and emits dist
#   - SPA routing rewrites unknown paths to index.html
#   - obsolete Fly/Docker/env frontend artifacts are absent
#
# (The prior "runbook mentions the app by name" check was dropped in PR
# #583 along with `infra/runbooks/mission-control-staging.md` — operational
# runbooks no longer live in this repo; see
# `agents/definitions/README.md` "Where operational runbooks live".)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

APPS=(mission-control tasks-app)

FAIL=0
for app in "${APPS[@]}"; do
  app_dir="$app"
  [[ "$app" == "tasks-app" ]] && app_dir="tasks"
  config="$REPO_ROOT/apps/$app_dir/vercel.json"
  if [[ ! -f "$config" ]]; then
    printf 'FAIL: missing %s\n' "${config#"$REPO_ROOT"/}" >&2
    FAIL=1
    continue
  fi

  node -e '
    const fs = require("node:fs");
    const [path, app] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    if (config.buildCommand !== "npm run build") throw new Error(`${app}: wrong buildCommand`);
    if (config.outputDirectory !== "dist") throw new Error(`${app}: wrong outputDirectory`);
    if (!config.rewrites?.some((row) => row.source === "/(.*)" && row.destination === "/index.html")) {
      throw new Error(`${app}: missing SPA rewrite`);
    }
  ' "$config" "$app" || FAIL=1
done

OBSOLETE=(
  infra/cloud/docker/mission-control.Dockerfile
  infra/cloud/docker/tasks-app.Dockerfile
  infra/cloud/docker/spa-nginx.conf
  infra/cloud/fly/mission-control.fly.toml
  infra/cloud/fly/tasks-app.fly.toml
  infra/cloud/env/mission-control.env.example
  infra/cloud/env/tasks-app.env.example
)
for path in "${OBSOLETE[@]}"; do
  if [[ -e "$REPO_ROOT/$path" ]]; then
    printf 'FAIL: obsolete Fly frontend artifact still exists: %s\n' "$path" >&2
    FAIL=1
  fi
done

if [[ -e "$REPO_ROOT/apps/tasks/pnpm-lock.yaml" ]]; then
  printf 'FAIL: apps/tasks/pnpm-lock.yaml makes Vercel select pnpm over the npm lockfile\n' >&2
  FAIL=1
fi

[[ "$FAIL" -eq 0 ]] || exit 1
echo "mission-control-vercel-deploy-fixtures: ok"
