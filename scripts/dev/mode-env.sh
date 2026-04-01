#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-dev}"

case "$MODE" in
  dev)
    export MODE
    export COMPOSE_PROJECT_NAME="sindustries-dev"
    export STACK_LABEL="dev"
    export POSTGRES_PORT="6432"
    export TASKS_API_PORT="4000"
    export BUDGET_API_PORT="4002"
    export TASKS_APP_PORT="5173"
    export TILT_PORT="10350"
    export POSTGRES_DB="sindustries_dev"
    export POSTGRES_CONTAINER_NAME="sindustries-postgres-dev"
    export TASKS_SCHEMA="tasks_api"
    export BUDGET_SCHEMA="budget_api"
    export TASKS_API_BASE_URL="http://localhost:${TASKS_API_PORT}/api/v1"
    export TASKS_API_ENV_FILE="services/tasks-api/.env.dev"
    export BUDGET_API_BASE_URL="http://localhost:${BUDGET_API_PORT}/api/v1"
    export BUDGET_API_ENV_FILE="services/budget-api/.env.dev"
    export RESET_DB_SEED_DEFAULT="true"
    # Observability ports (per-mode isolation)
    export O11Y_PROJECT_NAME="sindustries-dev-o11y"
    export GRAFANA_PORT="3000"
    export PROMETHEUS_PORT="9090"
    export TEMPO_PORT="3200"
    export OTLP_GRPC_PORT="4317"
    export OTLP_HTTP_PORT="4318"
    ;;
  prodlike)
    export MODE
    export COMPOSE_PROJECT_NAME="sindustries-prodlike"
    export STACK_LABEL="prodlike"
    export POSTGRES_PORT="7432"
    export TASKS_API_PORT="4001"
    export BUDGET_API_PORT="4003"
    export TASKS_APP_PORT="5174"
    export TILT_PORT="10351"
    export POSTGRES_DB="sindustries_prodlike"
    export POSTGRES_CONTAINER_NAME="sindustries-postgres-prodlike"
    export TASKS_SCHEMA="tasks_api"
    export BUDGET_SCHEMA="budget_api"
    export TASKS_API_BASE_URL="http://localhost:${TASKS_API_PORT}/api/v1"
    export TASKS_API_ENV_FILE="services/tasks-api/.env.prodlike"
    export BUDGET_API_BASE_URL="http://localhost:${BUDGET_API_PORT}/api/v1"
    export BUDGET_API_ENV_FILE="services/budget-api/.env.prodlike"
    export RESET_DB_SEED_DEFAULT="false"
    # Observability ports (per-mode isolation)
    export O11Y_PROJECT_NAME="sindustries-prodlike-o11y"
    export GRAFANA_PORT="3001"
    export PROMETHEUS_PORT="9091"
    export TEMPO_PORT="3201"
    export OTLP_GRPC_PORT="4327"
    export OTLP_HTTP_PORT="4328"
    ;;
  *)
    echo "Unsupported MODE: $MODE (expected: dev | prodlike)" >&2
    exit 1
    ;;
esac

export TASKS_DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?schema=${TASKS_SCHEMA}"
export BUDGET_DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?schema=${BUDGET_SCHEMA}"

# Back-compat default used by existing tasks scripts.
export DATABASE_URL="$TASKS_DATABASE_URL"
export CORS_ALLOWED_ORIGINS="http://localhost:${TASKS_APP_PORT},http://127.0.0.1:${TASKS_APP_PORT}"
