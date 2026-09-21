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
    local parent_pid
    local parent_command
    parent_pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -n "$parent_pid" ]]; then
      parent_command="$(ps -o command= -p "$parent_pid" 2>/dev/null || true)"
    else
      parent_command=""
    fi

    # `tsx watch` supervises the actual Node listener. Killing only the child
    # makes the watcher immediately respawn it, racing the replacement Tilt
    # resource and producing EADDRINUSE. Stop the watcher when it is the direct
    # parent; otherwise retain the original listener-only behavior.
    if [[ "$parent_command" == *"tsx watch"* ]]; then
      kill "$parent_pid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
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
  kill_port_listener "${MISSION_CONTROL_PORT:-5174}" "mission control"
  kill_port_listener "$TASKS_API_PORT" "tasks api"
  kill_port_listener "${BUDGET_API_PORT:-4002}" "budget api"
  kill_port_listener "${CONTENT_SCHEDULER_API_PORT:-4003}" "content scheduler api"
  kill_port_listener "$TILT_PORT" "Tilt"
  # Do not kill Redis/Postgres listeners here. Under Colima they are SSH
  # forwards owned by Lima's shared ControlMaster; killing one tears down the
  # Docker socket and every forwarded container port. Compose reconciles those
  # resources after Tilt connects to the daemon.
}
