#!/usr/bin/env bash
# scripts/cloud/cutover/common.sh
#
# Shared helpers for the SIndustries production cutover harness
# (task 020f423e, "Execute production cloud cutover with rollback
# verification").
#
# Source this from any cutover script:
#   source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
#
# This file has no side effects beyond sourcing: it declares functions
# and constants. Callers set the operational environment (manifest path,
# artifact directory, run id) before invoking the guards.
#
# WHAT IS HERE
#   - the immutable run id every mutating command is bound to
#   - the operator lock, so two operators cannot drive one window
#   - the shared credential redactor, so a diagnostic never carries a
#     secret into a task comment
#   - the durable cutover state file (monotonic phases, bound to the
#     manifest hash and the route version)
#   - the phase/manifest/gate guards the scripts share
#
# WHY THE STATE FILE IS ITS OWN FILE
#   The cutover is resumable: an operator who is interrupted at 20:40
#   must be able to find out what phase the window reached, and resume
#   only if the live route still matches the recorded route version.
#   "running" and "resumed" are different states, so the state has to
#   survive the process.

set -euo pipefail

# shellcheck shell=bash

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The repository root (three levels up: scripts/ -> cloud/ -> scripts/).
CUTOVER_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$CUTOVER_REPO_ROOT/.git" ]]; then
  CUTOVER_REPO_ROOT="$(git -C "$CUTOVER_REPO_ROOT" rev-parse --show-toplevel)"
fi

# The shared credential redactor. Every operator surface that shows
# command output masks credentials with this ONE module, so two
# surfaces cannot drift apart.
CUTOVER_REDACT_OUTPUT="$CUTOVER_REPO_ROOT/infra/cloud/platform/redact-output.mjs"

# The route adapter and the manifest validator.
CUTOVER_ADAPTER="$CUTOVER_REPO_ROOT/infra/cloud/cutover/traffic-route.mjs"
CUTOVER_MANIFEST_MODULE="$CUTOVER_REPO_ROOT/infra/cloud/cutover/manifest.mjs"

# The probe suite. The probes run against the ACTIVE binding, so they
# are the only thing in the harness that talks to the services.
CUTOVER_PROBES="$CUTOVER_REPO_ROOT/tests/cloud/production-cutover-probes.mjs"

# Where the cutover's artifacts live. The manifest's evidence.artifactDir
# overrides this; the environment variable overrides the manifest.
CUTOVER_ARTIFACT_DIR="${SINDUSTRIES_CUTOVER_ARTIFACT_DIR:-$CUTOVER_REPO_ROOT/artifacts/cutover}"

# The operator lock file. One window, one operator.
#
# The lock is a DIRECTORY, not a file: `mkdir` is atomic on every
# POSIX system, while `flock` is a Linux utility and this harness has to
# run on the operator's Mac mini as well as on the CI runner.
CUTOVER_LOCK_DIR="$CUTOVER_ARTIFACT_DIR/cutover.lock"

# The durable cutover state file.
CUTOVER_STATE_FILE="$CUTOVER_ARTIFACT_DIR/cutover-state.json"

# The route state file (owned by the route adapter).
CUTOVER_ROUTE_STATE_FILE="${SINDUSTRIES_CUTOVER_STATE_FILE:-$CUTOVER_ARTIFACT_DIR/production-route.json}"

# The immutable run id. Every mutating command is bound to it, and it
# is what the operator types to confirm a change.
CUTOVER_RUN_ID="${CUTOVER_RUN_ID:-}"

# The manifest path. Callers set this before sourcing, or pass --manifest.
CUTOVER_MANIFEST_PATH="${CUTOVER_MANIFEST_PATH:-}"

# The environment the operator is allowed to touch. A script refuses to
# run against a manifest whose environment does not match.
CUTOVER_ENVIRONMENT="${CUTOVER_ENVIRONMENT:-production}"

# The typed confirmation every production-changing command requires.
# It is an environment variable, never a command-line flag, so a
# mistyped command alone can never start a production run.
CUTOVER_PRODUCTION_ACK_ENV="SINDUSTRIES_CUTOVER_PRODUCTION_ACK"

# The exact string the confirmation must carry.
CUTOVER_PRODUCTION_ACK_VALUE="CUTOVER PRODUCTION"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

cutover_info() { printf '\033[36m[cutover]\033[0m %s\n' "$*"; }
cutover_warn() { printf '\033[33m[cutover]\033[0m %s\n' "$*" >&2; }
cutover_fail() {
  printf '\033[31m[cutover]\033[0m %s\n' "$*" >&2
  exit "${2:-1}"
}

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Redact anything credential-shaped out of a string before it is shown
# or written to an artifact. Operator output ends up pasted into task
# comments on a public repo, so a token must never ride along.
#
# The rules live in infra/cloud/platform/redact-output.mjs — the same
# module the platform provisioning script uses — so the cutover surface
# and the platform surface cannot drift apart.
#
# It FAILS CLOSED: if the redactor cannot run, nothing is shown rather
# than the raw text.
cutover_redact() {
  local out
  if ! out="$(printf '%s' "$1" | node "$CUTOVER_REDACT_OUTPUT" 2>/dev/null)"; then
    out="(output could not be shown safely — the redactor failed)"
  fi
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Tooling
# ---------------------------------------------------------------------------

# Every script needs node (the adapter, the manifest validator and the
# probes are node modules). The digest helper falls back to node when
# sha256sum is absent, and the lock uses mkdir, so neither utility is
# required — the harness runs unchanged on macOS and on Linux.
cutover_require_commands() {
  local missing=()
  for command_name in node; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    cutover_fail "required tools are missing from PATH: ${missing[*]}" 2
  fi
  if [[ ! -f "$CUTOVER_REDACT_OUTPUT" ]]; then
    cutover_fail "credential redactor not found at $CUTOVER_REDACT_OUTPUT" 2
  fi
  if [[ ! -f "$CUTOVER_ADAPTER" ]]; then
    cutover_fail "route adapter not found at $CUTOVER_ADAPTER" 2
  fi
}

# ---------------------------------------------------------------------------
# Run id
# ---------------------------------------------------------------------------

# The run id is immutable for the whole window. It is generated once and
# then carried in the environment and in the state file, so every
# artifact, every route change and every confirmation names the same
# window.
cutover_run_id() {
  if [[ -z "$CUTOVER_RUN_ID" ]]; then
    CUTOVER_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(node -e "process.stdout.write(require('node:crypto').randomBytes(3).toString('hex'))")"
    export CUTOVER_RUN_ID
  fi
  printf '%s' "$CUTOVER_RUN_ID"
}

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

# The manifest path, resolved from the flag or the environment.
cutover_resolve_manifest() {
  local candidate="${1:-${CUTOVER_MANIFEST_PATH:-}}"
  if [[ -z "$candidate" ]]; then
    cutover_fail "a manifest is required (--manifest <path>)" 2
  fi
  if [[ ! -f "$candidate" ]]; then
    cutover_fail "manifest not found: $candidate" 2
  fi
  printf '%s' "$candidate"
}

# Validate the manifest through the shared validator and fail closed on
# any problem. The validator is the ONLY place the manifest shape is
# decided, so the scripts and the tests cannot drift apart.
cutover_validate_manifest() {
  local manifest_path="$1"
  local output
  if ! output="$(node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    const manifest = loadManifest(process.argv[1]);
    process.stdout.write(JSON.stringify({
      environment: manifest.environment,
      taskId: manifest.taskId,
      observationMinutes: manifest.run.observationMinutes,
      surfaces: manifest.surfaces.map((s) => s.id),
      phases: manifest.phases.map((p) => p.phase),
    }));
  " "$manifest_path" 2>&1)"; then
    cutover_fail "manifest validation failed: $(cutover_redact "$output")" 2
  fi
  printf '%s' "$output"
}

# The manifest's sha256. The state file is bound to it: resuming a
# window whose manifest has changed underneath it is not resuming, it
# is running a different window.
cutover_manifest_hash() {
  local manifest_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$manifest_path" | awk '{print $1}'
  else
    node -e "
      const { createHash } = require('node:crypto');
      const { readFileSync } = require('node:fs');
      process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));
    " "$manifest_path"
  fi
}

# The manifest's environment, read through the validator.
cutover_manifest_environment() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(loadManifest(process.argv[1]).environment);
  " "$1"
}

# ---------------------------------------------------------------------------
# Environment guard
# ---------------------------------------------------------------------------

# A script only ever touches the environment it was told to touch. A
# production manifest driven by a staging command (or the other way
# round) is refused here, not discovered later.
cutover_assert_environment() {
  local manifest_path="$1"
  local expected="$2"
  local actual
  actual="$(cutover_manifest_environment "$manifest_path")"
  if [[ "$actual" != "$expected" ]]; then
    cutover_fail "manifest declares environment '$actual' but this command is scoped to '$expected'" 2
  fi
}

# Production-changing commands need the typed confirmation, and the
# confirmation must arrive in the ENVIRONMENT, not on the command line.
cutover_assert_production_ack() {
  local value="${!CUTOVER_PRODUCTION_ACK_ENV:-}"
  if [[ "$value" != "$CUTOVER_PRODUCTION_ACK_VALUE" ]]; then
    cutover_fail "this command changes production and needs $CUTOVER_PRODUCTION_ACK_ENV=$CUTOVER_PRODUCTION_ACK_VALUE in the environment" 2
  fi
}

# ---------------------------------------------------------------------------
# Operator lock
# ---------------------------------------------------------------------------

# One window, one operator. The lock is held for the whole transition:
# a second operator who tries to start a cutover while one is running
# is refused rather than allowed to interleave route changes.
#
# A lock whose owning process is gone is STALE, not held: an operator
# whose terminal died must not leave the window permanently locked, and
# the stale lock is broken automatically with the reason recorded.
cutover_acquire_lock() {
  mkdir -p "$CUTOVER_ARTIFACT_DIR"
  local attempt=0
  while true; do
    if mkdir "$CUTOVER_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$CUTOVER_LOCK_DIR/pid"
      cutover_info "operator lock acquired ($CUTOVER_LOCK_DIR)"
      return 0
    fi
    local owner_pid=""
    [[ -f "$CUTOVER_LOCK_DIR/pid" ]] && owner_pid="$(cat "$CUTOVER_LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
      cutover_fail "another cutover operator (pid $owner_pid) holds $CUTOVER_LOCK_DIR — one window, one operator" 1
    fi
    if [[ "$attempt" -ge 1 ]]; then
      cutover_fail "the stale lock at $CUTOVER_LOCK_DIR could not be broken (owner pid ${owner_pid:-unknown})" 1
    fi
    cutover_warn "breaking a stale operator lock at $CUTOVER_LOCK_DIR (owner pid ${owner_pid:-unknown} is gone)"
    rm -rf "$CUTOVER_LOCK_DIR"
    attempt=$((attempt + 1))
  done
}

# ---------------------------------------------------------------------------
# Durable state
# ---------------------------------------------------------------------------

# The cutover state file. It records the phase the window reached, the
# manifest hash it was started with, the route version it observed, and
# the evidence artifacts it produced.
cutover_read_state() {
  if [[ ! -f "$CUTOVER_STATE_FILE" ]]; then
    printf '{"version":1,"phase":null,"manifestHash":null,"routeVersion":null,"runId":null,"artifacts":[]}'
    return
  fi
  node -e "
    const { readFileSync } = require('node:fs');
    process.stdout.write(readFileSync(process.argv[1], 'utf8'));
  " "$CUTOVER_STATE_FILE"
}

cutover_write_state() {
  local phase="$1" manifest_hash="$2" route_version="$3"
  mkdir -p "$CUTOVER_ARTIFACT_DIR"
  node --input-type=module -e "
    import { readFileSync, writeFileSync, renameSync } from 'node:fs';
    const [stateFile, phase, manifestHash, routeVersion, runId, artifact] = process.argv.slice(1);
    let state = { version: 1, phase: null, manifestHash: null, routeVersion: null, runId: null, artifacts: [] };
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      // A missing or unreadable state file starts a fresh window.
    }
    state.version = 1;
    state.phase = phase;
    state.manifestHash = manifestHash;
    state.routeVersion = Number.isInteger(routeVersion) ? routeVersion : null;
    state.runId = runId;
    state.updatedAt = new Date().toISOString();
    const artifacts = new Set(state.artifacts ?? []);
    if (artifact) artifacts.add(artifact);
    state.artifacts = [...artifacts];
    const temporary = stateFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, stateFile);
  " "$CUTOVER_STATE_FILE" "$phase" "$manifest_hash" "$route_version" "$(cutover_run_id)" "${CUTOVER_LAST_ARTIFACT:-}"
}

# The phase the window is in, or "start" when there is no state file.
cutover_current_phase() {
  cutover_read_state | node -e "
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      let state = {};
      try { state = JSON.parse(raw); } catch { state = {}; }
      process.stdout.write(state.phase ?? 'start');
    });
  "
}

# The live route version, read through the adapter.
cutover_route_version() {
  node "$CUTOVER_ADAPTER" get --state-file "$CUTOVER_ROUTE_STATE_FILE" 2>/dev/null \
    | node -e "
      let raw = '';
      process.stdin.on('data', (chunk) => { raw += chunk; });
      process.stdin.on('end', () => {
        let state = {};
        try { state = JSON.parse(raw); } catch { state = {}; }
        process.stdout.write(String(state.version ?? 0));
      });
    "
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

# The phases the manifest declares, in order.
cutover_manifest_phases() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    for (const phase of loadManifest(process.argv[1]).phases) {
      process.stdout.write(phase.phase + '\t' + phase.binding + '\t' + phase.holdSeconds + '\t' + phase.minSamples + '\n');
    }
  " "$1"
}

# The binding a phase runs under.
cutover_phase_binding() {
  cutover_manifest_phases "$1" | awk -F'\t' -v phase="$2" '$1 == phase { print $2; exit }'
}

# The hold and sample count a phase declares.
cutover_phase_hold() {
  cutover_manifest_phases "$1" | awk -F'\t' -v phase="$2" '$1 == phase { print $3; exit }'
}

cutover_phase_min_samples() {
  cutover_manifest_phases "$1" | awk -F'\t' -v phase="$2" '$1 == phase { print $4; exit }'
}

# The next phase after the one named, or an empty string at the end.
cutover_next_phase() {
  cutover_manifest_phases "$1" | awk -F'\t' -v phase="$2" '
    $1 == phase { found = 1; next }
    found == 1 { print $1; exit }
  '
}

# ---------------------------------------------------------------------------
# Route adapter helpers
# ---------------------------------------------------------------------------

# Apply a binding through the adapter with compare-and-set.
cutover_route_set() {
  local manifest_path="$1" binding="$2" expected_version="$3" run_id="$4"
  node "$CUTOVER_ADAPTER" set \
    --manifest "$manifest_path" \
    --binding "$binding" \
    --expected-version "$expected_version" \
    --run-id "$run_id" \
    --confirm "$run_id" \
    --state-file "$CUTOVER_ROUTE_STATE_FILE"
}

# The plan for a binding — read-only.
cutover_route_plan() {
  local manifest_path="$1" binding="$2"
  node "$CUTOVER_ADAPTER" plan \
    --manifest "$manifest_path" \
    --binding "$binding" \
    --state-file "$CUTOVER_ROUTE_STATE_FILE"
}

# The prodlike read-back: which in-scope surfaces still target prodlike.
cutover_route_readback() {
  local manifest_path="$1"
  node "$CUTOVER_ADAPTER" readback \
    --manifest "$manifest_path" \
    --state-file "$CUTOVER_ROUTE_STATE_FILE"
}

# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------

# The evidence directory for this run.
cutover_evidence_dir() {
  local run_id="$1"
  printf '%s/%s' "$CUTOVER_ARTIFACT_DIR" "$run_id"
}

# Write a redacted evidence file and print its path. The content is
# redacted on the way in, so nothing credential-shaped reaches the disk.
cutover_write_evidence() {
  local run_id="$1" name="$2" content="$3"
  local directory
  directory="$(cutover_evidence_dir "$run_id")"
  mkdir -p "$directory"
  local path="$directory/$name"
  printf '%s\n' "$(cutover_redact "$content")" > "$path"
  printf '%s' "$path"
}

# The sha256 of an artifact, recorded alongside it so the record can
# prove it was not edited after the fact.
cutover_digest() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    node -e "
      const { createHash } = require('node:crypto');
      const { readFileSync } = require('node:fs');
      process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));
    " "$path"
  fi
}
