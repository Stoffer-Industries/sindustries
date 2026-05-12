#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$ROOT_DIR/services/tasks-api"
BUDGET_API_DIR="$ROOT_DIR/services/budget-api"

# shellcheck source=./mode-env.sh
source "$ROOT_DIR/scripts/dev/mode-env.sh"

ensure_tasks_api_deps() {
  if [[ -x "$API_DIR/node_modules/.bin/prisma" ]]; then
    return 0
  fi

  echo "Prisma CLI not found in services/tasks-api/node_modules; installing dependencies..."
  (
    cd "$API_DIR"
    npm install
  )
}

ensure_budget_api_deps() {
  if [[ -x "$BUDGET_API_DIR/node_modules/.bin/prisma" ]]; then
    return 0
  fi

  echo "Prisma CLI not found in services/budget-api/node_modules; installing dependencies..."
  (
    cd "$BUDGET_API_DIR"
    npm install
  )
}

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required but not installed." >&2
  exit 1
fi

# psql doesn't accept Prisma-style query params (e.g. ?schema=tasks_api)
PSQL_DATABASE_URL="${DATABASE_URL%%\?*}"
PSQL_ADMIN_URL="${PSQL_DATABASE_URL%/*}/postgres"

SEED_DB="${SEED_DB:-$RESET_DB_SEED_DEFAULT}"

if [[ "$MODE" == "prodlike" && "$SEED_DB" == "true" ]]; then
  echo "Refusing to seed prodlike: SEED_DB=true is blocked for MODE=prodlike." >&2
  echo "This guard is intentional to prevent destructive data loss." >&2
  exit 1
fi

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "docker compose (plugin) or docker-compose is required." >&2
    exit 1
  fi
}

echo "Ensuring Postgres is running for MODE=$MODE..."
if ! compose_cmd -f "$ROOT_DIR/infra/docker-compose.dev.yml" up -d postgres >/dev/null 2>&1; then
  echo "Warning: compose up reported an error; continuing to probe DB availability..." >&2
fi

# Wait until postgres socket is accepting connections.
for i in {1..30}; do
  if psql "$PSQL_ADMIN_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 30 ]]; then
    echo "Postgres not ready on $PSQL_ADMIN_URL after 30s" >&2
    exit 1
  fi
done

# Ensure target DB exists before schema reset.
DB_EXISTS=$(psql "$PSQL_ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" || true)
if [[ "$DB_EXISTS" != "1" ]]; then
  psql "$PSQL_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${POSTGRES_DB}\";"
fi

echo "Resetting Postgres schemas for MODE=$MODE (${POSTGRES_DB})..."
psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS tasks_api CASCADE;
CREATE SCHEMA tasks_api;
DROP SCHEMA IF EXISTS tasks_app CASCADE;
CREATE SCHEMA tasks_app;
DROP SCHEMA IF EXISTS budget_api CASCADE;
CREATE SCHEMA budget_api;
SQL

(
  cd "$API_DIR"
  ensure_tasks_api_deps
  # Prisma Client is hoisted at repo root; regenerate for this schema before seeding.
  DATABASE_URL="$DATABASE_URL" npm run prisma:generate
  DATABASE_URL="$DATABASE_URL" npm run prisma:migrate
  DATABASE_URL="$DATABASE_URL" npm run prisma:generate

  if [[ "$SEED_DB" == "true" ]]; then
    echo "Seeding database (SEED_DB=true)..."
    DATABASE_URL="$DATABASE_URL" npm run prisma:seed
  else
    echo "Skipping seed (SEED_DB=$SEED_DB)."
  fi
)

(
  cd "$BUDGET_API_DIR"
  ensure_budget_api_deps
  # Prisma Client is hoisted at repo root; regenerate for this schema before seeding.
  DATABASE_URL="$BUDGET_DATABASE_URL" npm run prisma:generate
  DATABASE_URL="$BUDGET_DATABASE_URL" npm run prisma:migrate

  if [[ "$SEED_DB" == "true" ]]; then
    echo "Seeding budget-api (SEED_DB=true)..."
    DATABASE_URL="$BUDGET_DATABASE_URL" npm run prisma:seed
  else
    echo "Skipping budget-api seed (SEED_DB=$SEED_DB)."
  fi
)

echo "Database reset complete for MODE=$MODE."
