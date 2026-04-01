#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$ROOT_DIR/services/tasks-api"
BUDGET_API_DIR="$ROOT_DIR/services/budget-api"
KNOWN_DRIFT_MIGRATION="20260308000000_add_blocked_ready_columns"

# shellcheck source=./mode-env.sh
source "$ROOT_DIR/scripts/dev/mode-env.sh"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

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

if ! need_cmd psql; then
  echo "psql is required but not installed." >&2
  exit 1
fi

if ! need_cmd pg_dump; then
  echo "pg_dump is required but not installed." >&2
  exit 1
fi

# psql/pg_dump do not accept Prisma's ?schema=... query parameter.
PSQL_DATABASE_URL="${DATABASE_URL%%\?*}"
PSQL_ADMIN_URL="${PSQL_DATABASE_URL%/*}/postgres"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/.db-backups/$MODE}"

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

prisma_cmd() {
  DATABASE_URL="$DATABASE_URL" npm exec prisma -- "$@"
}

has_known_blocked_ready_drift() {
  local log_file="$1"
  local log_contents
  local unfinished_count
  local migration_table_exists

  log_contents="$(<"$log_file")"
  if [[ "$log_contents" != *"Error: P3018"* ]]; then
    return 1
  fi

  if [[ "$log_contents" != *"Migration name: ${KNOWN_DRIFT_MIGRATION}"* ]]; then
    return 1
  fi

  if [[ "$log_contents" != *'column "blocked" of relation "Task" already exists'* ]]; then
    return 1
  fi

  migration_table_exists="$(
    psql "$PSQL_DATABASE_URL" -tAc "SELECT to_regclass('tasks_api.\"_prisma_migrations\"') IS NOT NULL" || true
  )"
  if [[ "$migration_table_exists" != "t" ]]; then
    return 1
  fi

  unfinished_count="$(
    psql "$PSQL_DATABASE_URL" -tAc \
      "SELECT COUNT(*) FROM tasks_api.\"_prisma_migrations\" WHERE migration_name='${KNOWN_DRIFT_MIGRATION}' AND finished_at IS NULL AND rolled_back_at IS NULL" || true
  )"
  unfinished_count="${unfinished_count//[[:space:]]/}"

  [[ "$unfinished_count" =~ ^[0-9]+$ ]] && (( unfinished_count >= 1 ))
}

recover_known_blocked_ready_drift() {
  echo "Detected partially-applied blocked/ready migration; auto-recovering..."

  # Ensure the schema matches the checked-in migration before resolving it.
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE tasks_api."Task" ADD COLUMN IF NOT EXISTS "blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks_api."Task" ADD COLUMN IF NOT EXISTS "ready" BOOLEAN NOT NULL DEFAULT false;
SQL

  (
    cd "$API_DIR"
    prisma_cmd migrate resolve --applied "$KNOWN_DRIFT_MIGRATION"
  )
}

run_prisma_migrate_with_auto_recover() {
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/sindustries-migrate.XXXXXX.log")"

  if (
    cd "$API_DIR"
    DATABASE_URL="$DATABASE_URL" npm run prisma:migrate
  ) >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 0
  fi

  cat "$log_file" >&2

  if has_known_blocked_ready_drift "$log_file"; then
    recover_known_blocked_ready_drift
    echo "Retrying Prisma migrations after auto-recovery..."
    rm -f "$log_file"
    (
      cd "$API_DIR"
      DATABASE_URL="$DATABASE_URL" npm run prisma:migrate
    )
    return 0
  fi

  rm -f "$log_file"
  return 1
}

echo "Ensuring Postgres is running for MODE=$MODE..."
if ! compose_cmd -f "$ROOT_DIR/infra/docker-compose.dev.yml" up -d postgres >/dev/null 2>&1; then
  echo "Warning: compose up reported an error; continuing to probe DB availability..." >&2
fi

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

DB_EXISTS=$(psql "$PSQL_ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" || true)
if [[ "$DB_EXISTS" == "1" ]]; then
  mkdir -p "$BACKUP_ROOT"
  TIMESTAMP="$(date -u +%Y%m%d-%H%M%SZ)"
  BACKUP_BASE="pre-migrate-${POSTGRES_DB}-${TIMESTAMP}"
  BACKUP_PATH="$BACKUP_ROOT/${BACKUP_BASE}.dump"
  MANIFEST_PATH="$BACKUP_ROOT/${BACKUP_BASE}.txt"

  echo "Creating backup before migration..."
  echo "  $BACKUP_PATH"
  pg_dump "$PSQL_DATABASE_URL" --format=custom --no-owner --file "$BACKUP_PATH"

  cat > "$MANIFEST_PATH" <<EOF
mode=$MODE
database=$POSTGRES_DB
host=localhost
port=$POSTGRES_PORT
created_at_utc=$TIMESTAMP
backup_file=$BACKUP_PATH
restore_example=pg_restore --clean --if-exists --no-owner --dbname "postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${POSTGRES_DB}" "$BACKUP_PATH"
EOF
else
  echo "Database $POSTGRES_DB does not exist yet; skipping backup."
  psql "$PSQL_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${POSTGRES_DB}\";"
fi

echo "Applying Prisma migrations for MODE=$MODE..."
ensure_tasks_api_deps
run_prisma_migrate_with_auto_recover
(
  cd "$API_DIR"
  DATABASE_URL="$DATABASE_URL" npm run prisma:generate
)

echo "Applying Prisma migrations for budget-api (MODE=$MODE)..."
ensure_budget_api_deps
(
  cd "$BUDGET_API_DIR"
  DATABASE_URL="$BUDGET_DATABASE_URL" npm run prisma:migrate
)

echo "Migration complete for MODE=$MODE."
if [[ "$DB_EXISTS" == "1" ]]; then
  echo "Backup saved under $BACKUP_ROOT"
fi
