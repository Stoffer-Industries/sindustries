#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=./mode-env.sh
source "$ROOT_DIR/scripts/dev/mode-env.sh"

# argv from Makefile > env var > default on
OBSERVABILITY="${1:-${OBSERVABILITY:-1}}"
export OBSERVABILITY

# Pin DOCKER_HOST to colima's socket when available. Without this,
# /var/run/docker.sock often symlinks to Docker Desktop on hosts that have
# it installed (e.g. this Mac mini), and `docker info` returns Docker
# Desktop's daemon — fooling the preflight below into thinking colima is
# healthy when it isn't. Setting DOCKER_HOST explicitly here ensures every
# docker CLI call in this script (and the exec'd Tilt process) hits
# colima, not whatever else is listening on /var/run/docker.sock.
if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
fi

# shellcheck source=./port-cleanup.sh
source "$ROOT_DIR/scripts/dev/port-cleanup.sh"

expected_db_port_for_api_port() {
  case "$1" in
    4000) echo "6432" ;;
    4001) echo "7432" ;;
    *) echo "" ;;
  esac
}

EXPECTED_DB_PORT="$(expected_db_port_for_api_port "$TASKS_API_PORT")"
if [[ -n "$EXPECTED_DB_PORT" && "$POSTGRES_PORT" != "$EXPECTED_DB_PORT" ]]; then
  echo "Unsafe mode configuration: API port $TASKS_API_PORT expects DB port $EXPECTED_DB_PORT, got $POSTGRES_PORT." >&2
  echo "Check scripts/dev/mode-env.sh before starting the stack." >&2
  exit 1
fi

if ! command -v colima >/dev/null 2>&1; then
  echo "colima is required but not installed." >&2
  exit 1
fi

if ! command -v tilt >/dev/null 2>&1; then
  echo "tilt is required but not installed." >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is required but not installed." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "docker compose (plugin) or docker-compose is required but not installed." >&2
  exit 1
fi

ensure_dev_workspace_deps() {
  local missing=0

  for path in \
    "$ROOT_DIR/node_modules/.bin/tsx" \
    "$ROOT_DIR/node_modules/.bin/vite" \
    "$ROOT_DIR/node_modules/@vitejs/plugin-react/package.json"; do
    if [[ ! -e "$path" ]]; then
      missing=1
      break
    fi
  done

  if [[ "$missing" == "0" ]]; then
    return 0
  fi

  echo "Installing missing JS workspace dependencies..."
  (
    cd "$ROOT_DIR"
    npm install \
      --workspace @sindustries/tasks-api \
      --workspace @sindustries/budget-api \
      --workspace @sindustries/content-scheduler-api \
      --workspace @sindustries/tasks-app \
      --workspace @sindustries/mission-control
  )
}

ensure_dev_workspace_deps

if ! colima status >/dev/null 2>&1; then
  echo "Starting Colima..."
  colima start
fi

# Preflight: confirm dockerd is actually reachable. `colima status` only
# checks the Colima metadata; it returns OK even when the underlying
# Lima VM has died and dockerd is gone. Detect that case and recover
# (escalating from stop+start to delete+start if needed) before
# continuing. Falls back to Docker Desktop if colima recovery fails.
ensure_docker_daemon() {
  # Verify the responding daemon is actually the colima VM. Without this
  # check, `docker info >/dev/null` returns 0 for *any* reachable daemon
  # (e.g. Docker Desktop, Rancher Desktop, OrbStack) and the preflight
  # passes even when colima itself is wedged — which is the failure mode
  # that prompted this PR.
  if docker info 2>/dev/null | grep -q '^Name: colima'; then
    return 0
  fi

  echo "Docker daemon is responding but is NOT colima (or colima is unreachable)."
  echo "Detected: $(docker info 2>&1 | grep -E '^(Operating System|Name):' | head -2 | tr '\n' ' | ')"
  echo "Expected: a daemon reporting \`Name: colima\`."
  echo "Attempting Colima recovery (stop+start, then delete+start if needed)..."

  # First attempt: stop + start (handles stale metadata where colima status
  # says 'running' but VM is actually stopped).
  colima stop 2>/dev/null || true
  if colima start --runtime docker; then
    local attempts=0
    while (( attempts < 30 )); do
      if docker info 2>/dev/null | grep -q '^Name: colima'; then
        echo "Docker daemon recovered (colima VM via stop+start)."
        return 0
      fi
      sleep 1
      attempts=$((attempts + 1))
    done
  fi

  # Second attempt: nuke and rebuild from scratch (handles wedged VM where
  # stop+start doesn't recover — common when VZ driver is in a bad state).
  echo "colima stop+start did not recover daemon — trying colima delete + start..."
  colima delete --force 2>/dev/null || true
  if colima start --runtime docker; then
    local attempts=0
    while (( attempts < 45 )); do
      if docker info 2>/dev/null | grep -q '^Name: colima'; then
        echo "Docker daemon recovered (colima VM after delete+start; VM boot takes longer after full wipe)."
        return 0
      fi
      sleep 1
      attempts=$((attempts + 1))
    done
  fi

  # Final fallback: if Docker Desktop daemon is responsive, use it. The
  # host's /var/run/docker.sock may symlink to Docker Desktop when colima
  # is wedged beyond software recovery — don't fail the whole make up in
  # that case. Honors the directive "make up needs to handle this gracefully".
  local desktop_sock="/Users/quinnstoffer/.docker/run/docker.sock"
  if [[ -S "$desktop_sock" ]] && /usr/local/bin/docker --context=desktop-linux info 2>/dev/null | grep -q '^Server Version'; then
    echo "WARNING: colima recovery failed (stop+start and delete+start both tried) but Docker Desktop daemon is responsive."
    echo "         Continuing with Docker Desktop as fallback (colima DOCKER_HOST not enforced)." >&2
    return 0
  fi

  echo "ERROR: Docker daemon still unreachable. Colima recovery failed (stop+start, delete+start both tried) and Docker Desktop also down." >&2
  echo "       Manual recovery: try 'colima restart' or 'colima delete --force && colima start --runtime docker'." >&2
  exit 1
}

ensure_docker_daemon

# Preflight: clear stale local listeners for this mode before Tilt boots.
cleanup_mode_ports

append_env_local_overrides() {
  local env_file="$1"
  local local_file="${env_file}.local"

  if [[ ! -f "$local_file" ]]; then
    return 0
  fi

  {
    echo
    echo "# Local overrides from $(basename "$local_file")"
    # Only allow a small, explicit set of vars to be merged to avoid surprises.
    # (This is primarily for secrets that shouldn't be auto-generated.)
    grep -E '^(AKAHU_CLIENT_ID|AKAHU_CLIENT_SECRET|AKAHU_REDIRECT_URI|AKAHU_DEV_USER_ACCESS_TOKEN|X_CLIENT|X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_TOKEN_SECRET|X_HANDLE|TASKS_API_APPROVAL_USERS|TASKS_API_APPROVAL_SERVICE_CREDENTIALS)=' "$local_file" || true
  } >>"$env_file"
}

cat > "$ROOT_DIR/$TASKS_API_ENV_FILE" <<EOF
# Auto-generated by scripts/dev/up.sh for MODE=$MODE
PORT=$TASKS_API_PORT
DATABASE_URL="$DATABASE_URL"
CORS_ALLOWED_ORIGINS="$CORS_ALLOWED_ORIGINS"
# Content Scheduler auto-post — durable adapter. Without these, the
# tasks-api process falls back to CONTENT_SCHEDULER_JOB_ADAPTER=in-process
# (in-memory setTimeouts lost on restart; see task 1945f8a2). Set here
# for every mode so the prodlike path is exercised by the same 'make up'
# workflow as dev.
CONTENT_SCHEDULER_JOB_ADAPTER=bullmq
CONTENT_SCHEDULER_REDIS_URL=redis://localhost:${REDIS_PORT}
EOF

if [[ "$OBSERVABILITY" == "1" ]]; then
  cat >> "$ROOT_DIR/$TASKS_API_ENV_FILE" <<EOF

# OpenTelemetry (on: stack infra/docker-compose.observability.yml; default unless OBSERVABILITY=0)
OTEL_SERVICE_NAME=tasks-api
OTEL_SERVICE_NAMESPACE=sindustries
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:$OTLP_HTTP_PORT
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=none
OTEL_ENVIRONMENT=$MODE
EOF
else
  cat >> "$ROOT_DIR/$TASKS_API_ENV_FILE" <<EOF

# OpenTelemetry off (make up OBSERVABILITY=0; avoids export errors when collector is down)
OTEL_SDK_DISABLED=1
EOF
fi

append_env_local_overrides "$ROOT_DIR/$TASKS_API_ENV_FILE"

cat > "$ROOT_DIR/$BUDGET_API_ENV_FILE" <<EOF
# Auto-generated by scripts/dev/up.sh for MODE=$MODE
PORT=$BUDGET_API_PORT
DATABASE_URL="$BUDGET_DATABASE_URL"
CORS_ALLOWED_ORIGINS="$CORS_ALLOWED_ORIGINS"
EOF

append_env_local_overrides "$ROOT_DIR/$BUDGET_API_ENV_FILE"

echo "Starting $MODE stack"
echo "  API: $TASKS_API_BASE_URL"
echo "  Budget API: $BUDGET_API_BASE_URL"
echo "  Content Scheduler API: $CONTENT_SCHEDULER_API_BASE_URL"
echo "  App: http://localhost:$TASKS_APP_PORT"
echo "  Mission Control: http://localhost:$MISSION_CONTROL_PORT"
echo "  Postgres: localhost:$POSTGRES_PORT/$POSTGRES_DB"
if [[ "$OBSERVABILITY" == "1" ]]; then
  echo "  Observability: Grafana http://localhost:$GRAFANA_PORT (Tempo :$TEMPO_PORT, Prometheus :$PROMETHEUS_PORT, OTLP :$OTLP_HTTP_PORT)"
fi

cd "$ROOT_DIR"
exec env \
  TILT_OBSERVABILITY="$OBSERVABILITY" \
  OBSERVABILITY="$OBSERVABILITY" \
  MODE="$MODE" \
  tilt up --file infra/tilt/Tiltfile --port "$TILT_PORT"
