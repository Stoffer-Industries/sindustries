#!/usr/bin/env bash
set -euo pipefail

port_listener_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

kill_port_listener() {
  local port="$1"
  local label="$2"
  local pids

  pids="$(port_listener_pids "$port")"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "Found stale $label listener on :$port. Stopping it..."
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
  done <<< "$pids"

  sleep 1

  pids="$(port_listener_pids "$port")"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "Force-stopping stubborn $label listener on :$port..."
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -9 "$pid" 2>/dev/null || true
  done <<< "$pids"
}

cleanup_mode_ports() {
  kill_port_listener "$TASKS_APP_PORT" "tasks app"
  kill_port_listener "$TASKS_API_PORT" "tasks api"
  kill_port_listener "${BUDGET_API_PORT:-4002}" "budget api"
  kill_port_listener "$TILT_PORT" "Tilt"
}
