#!/usr/bin/env bash
# fly-toml-context.test.sh — Fly build-path regression guard.
#
# `context` and `dockerfile` in Fly config are resolved relative to the
# config file's location. Every cloud image needs the repo root as context
# because its Dockerfile copies workspace packages and root manifests.
#
# This test resolves every Fly config under infra/cloud instead of comparing
# literal relative strings, so configs can live at different directory depths.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# Fallback for non-git checkouts where the relative walk could go weird.
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
FAIL=0
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  # Ignore operator-local/generated Fly configs that are deliberately not
  # tracked. The regression guard is for deployable repository configs.
  CONFIG_FILES="$(git -C "$REPO_ROOT" ls-files | awk '$0 ~ /^infra\/cloud\// && ($0 ~ /(^|\/)fly\.toml$/ || $0 ~ /\.fly\.toml$/) {print}')"
else
  CONFIG_FILES="$(find "$REPO_ROOT/infra/cloud" -type f \( -name 'fly.toml' -o -name '*.fly.toml' \) | sort)"
fi

while IFS= read -r toml; do
  config_dir="$(dirname "$toml")"
  ctx=$(awk -F"'" '/^[[:space:]]*context[[:space:]]*=/ {print $2; exit}' "$toml")
  dockerfile=$(awk -F"'" '/^[[:space:]]*dockerfile[[:space:]]*=/ {print $2; exit}' "$toml")
  if [[ -z "$ctx" || ! -d "$config_dir/$ctx" ]]; then
    printf 'FAIL: %s has invalid build context=%q\n' \
      "${toml#"$REPO_ROOT"/}" "$ctx" >&2
    FAIL=1
    continue
  fi
  resolved_ctx="$(cd "$config_dir/$ctx" && pwd -P)"
  if [[ "$resolved_ctx" != "$REPO_ROOT" ]]; then
    printf 'FAIL: %s context=%q resolves to %s (expected repo root)\n' \
      "${toml#"$REPO_ROOT"/}" "$ctx" "$resolved_ctx" >&2
    FAIL=1
  fi
  if [[ -z "$dockerfile" || ! -f "$config_dir/$dockerfile" ]]; then
    printf 'FAIL: %s dockerfile=%q does not resolve relative to the config file\n' \
      "${toml#"$REPO_ROOT"/}" "$dockerfile" >&2
    FAIL=1
  fi
  if grep -q '^\[\[services\.http_checks\]\]' "$toml"; then
    printf 'FAIL: %s mixes [http_service] with [[services.http_checks]]; use [[http_service.checks]]\n' \
      "${toml#"$REPO_ROOT"/}" >&2
    FAIL=1
  fi
done < <(printf '%s\n' "${CONFIG_FILES}" | sed '/^$/d' | while IFS= read -r rel; do
  if [[ "${rel}" = /* ]]; then
    printf '%s\n' "${rel}"
  else
    printf '%s/%s\n' "${REPO_ROOT}" "${rel}"
  fi
done | sort)

# Fly passes release_command directly to the image entrypoint. Keep Prisma
# migrations on npm workspace scripts so no shell builtin (`cd`) is required
# and each service selects its own schema from the repository root.
for spec in \
  "infra/cloud/fly/tasks-api.fly.toml|services/tasks-api" \
  "infra/cloud/fly/budget-api.fly.toml|services/budget-api" \
  "infra/cloud/fly/content-scheduler-api.fly.toml|services/content-scheduler-api"; do
  config_path="${spec%%|*}"
  workspace="${spec#*|}"
  release_command="$(awk -F"'" '/^[[:space:]]*release_command[[:space:]]*=/ {print $2; exit}' "$REPO_ROOT/$config_path")"
  expected="npm run prisma:migrate --workspace $workspace"
  if [[ "$release_command" != "$expected" ]]; then
    printf 'FAIL: %s release_command=%q (expected %q)\n' \
      "$config_path" "$release_command" "$expected" >&2
    FAIL=1
  fi
done

# Prisma's Alpine engine selection requires OpenSSL to exist before npm
# installs or `prisma generate` runs. Without it, release migrations select
# the OpenSSL 1.1 engine and fail before deployment promotion.
for dockerfile in \
  "infra/cloud/docker/tasks-api.Dockerfile" \
  "infra/cloud/docker/budget-api.Dockerfile" \
  "infra/cloud/docker/content-scheduler-api.Dockerfile" \
  "infra/cloud/docker/auto-post-worker.Dockerfile"; do
  if ! grep -Eq '^RUN apk add --no-cache openssl$' "$REPO_ROOT/$dockerfile"; then
    printf 'FAIL: %s must install OpenSSL for Prisma Alpine engines\n' "$dockerfile" >&2
    FAIL=1
  fi
done

[[ "$FAIL" -eq 0 ]] || exit 1
echo "fly-toml-context: ok"
