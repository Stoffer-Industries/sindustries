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

# The harness scripts live next to this file. They are invoked by
# ABSOLUTE path: a sibling script reached by a relative path only works
# when the operator happens to be standing in the repository root, and a
# cutover must not depend on the operator's working directory.
# shellcheck disable=SC2034 # consumed by scripts that source this file
CUTOVER_SCRIPTS_DIR="${CUTOVER_SCRIPTS_DIR_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# The shared credential redactor. Every operator surface that shows
# command output masks credentials with this ONE module, so two
# surfaces cannot drift apart.
CUTOVER_REDACT_OUTPUT="$CUTOVER_REPO_ROOT/infra/cloud/platform/redact-output.mjs"
CUTOVER_REDACT_MODULE="$CUTOVER_REDACT_OUTPUT"

# The route adapter and the manifest validator.
CUTOVER_ADAPTER="$CUTOVER_REPO_ROOT/infra/cloud/cutover/traffic-route.mjs"
CUTOVER_MANIFEST_MODULE="$CUTOVER_REPO_ROOT/infra/cloud/cutover/manifest.mjs"

# The abort-threshold evaluator. It owns the MEANING of the manifest's
# run.abortThresholds, so the executor and the tests cannot drift apart
# on what "errorRate" or "p95LatencyMs" means.
CUTOVER_THRESHOLDS_MODULE="$CUTOVER_REPO_ROOT/infra/cloud/cutover/thresholds.mjs"

# The probe suite. The probes run against the ACTIVE binding, so they
# are the only thing in the harness that talks to the services.
# shellcheck disable=SC2034 # consumed by scripts that source this file
CUTOVER_PROBES="${CUTOVER_PROBES_OVERRIDE:-$CUTOVER_REPO_ROOT/tests/cloud/production-cutover-probes.mjs}"

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

# The root the caller's base URLs are resolved against.
#
# The route IS the caller's base URL, so a route change is a change to
# the files the callers live in. The root defaults to the repository
# the harness is running from, and the environment variable exists so
# the test suite can point the adapter at a fixture tree instead of
# rewriting the real callers. Mutating commands additionally require
# the environment variable to be set explicitly: the default repository
# root is read-only planning convenience, not a production route.
CUTOVER_CALLER_ROOT="${SINDUSTRIES_CUTOVER_CALLER_ROOT:-$CUTOVER_REPO_ROOT}"

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
# The message is $1 and the exit code is $2. The message must NOT include
# the exit code: these lines get pasted into task comments and runbooks,
# and a trailing "2" reads as part of the sentence.
cutover_fail() {
  printf '\033[31m[cutover]\033[0m %s\n' "$1" >&2
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

# Redact a JSON document WITHOUT flattening or capping it.
#
# `cutover_redact` is the OPERATOR shape: one flattened line, capped at
# 400 characters, because an operator reads it in a terminal and pastes
# it into a task comment. The probe samples are not operator text —
# they are a machine-read window that the threshold evaluator parses —
# so flattening would merge the samples and capping would truncate one
# into invalid JSON.
#
# The masking RULES are the same ones; only the shape is preserved.
cutover_redact_json() {
  node --input-type=module -e "
    import { redactOutput } from '${CUTOVER_REDACT_MODULE}';
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    process.stdout.write(redactOutput(raw));
  "
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
  command -v node >/dev/null 2>&1 || missing+=("node")
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
#
# The validator's message is the operator-facing reason: a node stack
# trace is not a reason, and it carries absolute paths that have no
# business in a task comment.
cutover_validate_manifest() {
  local manifest_path="$1"
  local output
  if ! output="$(node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    try {
      const manifest = loadManifest(process.argv[1]);
      process.stdout.write(JSON.stringify({
        environment: manifest.environment,
        taskId: manifest.taskId,
        observationMinutes: manifest.run.observationMinutes,
        surfaces: manifest.surfaces.map((s) => s.id),
        phases: manifest.phases.map((p) => p.phase),
      }));
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(String(error && error.message ? error.message : error));
    }
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
#
# It FAILS CLOSED on an invalid manifest. Reading the environment
# directly out of the manifest module let an invalid manifest raise an
# unhandled node exception, so the caller died with a stack trace and
# exit 1 instead of a named refusal — which is indistinguishable from a
# crash, and reads as one in an operator's log.
cutover_manifest_environment() {
  local summary
  summary="$(cutover_validate_manifest "$1")"
  printf '%s' "$summary" | node -e "
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      try {
        process.stdout.write(JSON.parse(raw).environment);
      } catch {
        process.stdout.write('unknown');
      }
    });
  "
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
# Clock
# ---------------------------------------------------------------------------

# The current time, in epoch seconds.
#
# The hold and observation durations are the core of the cutover's
# safety property, so the clock they are measured against has to be
# CONTROLLABLE. A test that waits out a 300-second hold in real time is
# a test nobody runs, and a test that stubs the duration away proves
# nothing. CUTOVER_CLOCK_FILE lets a test pin a virtual clock and
# advance it deliberately, so the rule is exercised for real without
# costing the wall clock.
cutover_now() {
  if [[ -n "${CUTOVER_CLOCK_FILE:-}" && -f "${CUTOVER_CLOCK_FILE}" ]]; then
    cat "${CUTOVER_CLOCK_FILE}"
    return
  fi
  date -u +%s
}

# Sleep for a number of seconds, through the same controllable clock.
#
# CUTOVER_SLEEP_COMMAND lets a test substitute a command that advances
# the virtual clock and returns immediately, so a 300-second hold can
# be exercised in milliseconds without weakening the rule the hold
# exists to enforce.
cutover_sleep() {
  local seconds="${1:-0}"
  if [[ -n "${CUTOVER_SLEEP_COMMAND:-}" ]]; then
    "${CUTOVER_SLEEP_COMMAND}" "${seconds}"
    return
  fi
  sleep "${seconds}"
}

# ---------------------------------------------------------------------------
# Durable state
# ---------------------------------------------------------------------------

# The cutover state file. It records the phase the window reached, the
# manifest hash it was started with, the route version it observed, and
# the evidence artifacts it produced.
#
# A MISSING state file is a fresh window — that is the normal first
# run. A state file that EXISTS but cannot be parsed is NOT a fresh
# window: it is a window whose state is unknown. Treating it as fresh
# is how one window silently starts twice, and how a resume lands on a
# phase the previous operator never reached. It fails closed.
cutover_read_state() {
  if [[ ! -f "$CUTOVER_STATE_FILE" ]]; then
    printf '{"version":1,"phase":null,"manifestHash":null,"routeVersion":null,"runId":null,"artifacts":[]}'
    return 0
  fi
  if ! node -e "
    const { readFileSync } = require('node:fs');
    const raw = readFileSync(process.argv[1], 'utf8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      process.stderr.write('the state file is not a JSON object');
      process.exit(1);
    }
    process.stdout.write(raw);
  " "$CUTOVER_STATE_FILE" 2>/dev/null; then
    cutover_fail "the cutover state at $CUTOVER_STATE_FILE cannot be read as a state document — refusing to treat an unreadable window as a fresh one" 2
  fi
}

# One field of the durable state, read through the state document.
#
# A missing field reads as an EMPTY STRING, never as a default. The
# resume gate distinguishes "the window recorded no route version"
# (which must refuse) from "the route is at version 0", and a default
# would erase that distinction.
cutover_state_value() {
  local key="$1"
  cutover_read_state | node -e "
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      let state = {};
      try { state = JSON.parse(raw); } catch { state = {}; }
      const value = state[process.argv[1]];
      if (value === null || value === undefined) process.stdout.write('');
      else process.stdout.write(String(value));
    });
  " "$key"
}

# ---------------------------------------------------------------------------
# Resume gate
# ---------------------------------------------------------------------------

# A resume is only a resume if it is the SAME window: the same
# manifest, and the same live route. Resuming on a changed manifest is
# running a different window; resuming on a moved route means the
# route changed while nobody was watching. Both are refusals.
#
# It is a helper rather than inline code in the executor so the rule
# can be exercised on its own, without standing up a whole cutover
# window to reach it.
cutover_assert_resumable() {
  local recorded_manifest_hash="$1" recorded_route_version="$2" manifest_hash="$3" live_route_version="$4"
  if [[ -z "$recorded_manifest_hash" ]]; then
    cutover_fail "cannot resume: the recorded state carries no manifest hash — the window it describes cannot be identified" 1
  fi
  if [[ "$recorded_manifest_hash" != "$manifest_hash" ]]; then
    cutover_fail "cannot resume: the recorded window was started with a different manifest (recorded $recorded_manifest_hash, this manifest $manifest_hash) — that is a different window, not a resume" 1
  fi
  if [[ -z "$recorded_route_version" ]]; then
    cutover_fail "cannot resume: the recorded state carries no route version — the live route cannot be checked against the one the window applied" 1
  fi
  if [[ "$live_route_version" != "$recorded_route_version" ]]; then
    cutover_fail "cannot resume: the live route is at version $live_route_version but the window recorded version $recorded_route_version — the route moved underneath the window" 1
  fi
}

# ---------------------------------------------------------------------------
# Abort thresholds
# ---------------------------------------------------------------------------

# Evaluate the manifest's abort thresholds against a window's samples.
#
# The MEANING of the thresholds lives in one node module, so the
# executor, the runbook and the tests cannot drift apart on what
# "errorRate" or "p95LatencyMs" means.
#
# The exit code is the whole point of this helper:
#
#   0  the window breaches nothing
#   1  the window breaches at least one threshold
#   2  the window could NOT be evaluated
#
# Code 2 is NOT a pass. An evaluator that cannot read its manifest or
# its samples must never be read as "no breach": a threshold gate that
# cannot see the window has to stop the window, not bless it.
#
# The report is printed on stdout so the caller can put the reason in
# the abort message and in the evidence.
cutover_evaluate_thresholds() {
  local manifest="$1" samples_file="$2"
  node "$CUTOVER_THRESHOLDS_MODULE" --manifest "$manifest" --samples "$samples_file"
}

# ---------------------------------------------------------------------------
# Phase timing
# ---------------------------------------------------------------------------

# Whether a phase still owes work.
#
# A phase runs for AT LEAST the declared hold AND collects AT LEAST the
# declared minimum samples — whichever takes longer. Enforcing only the
# sample count let a 300-second phase finish after about 60 seconds and
# the 3600-second observation finish after about 5, so the observation
# period the manifest declares was never the observation period that
# happened.
#
# The rule lives in one place so the executor and the test agree about
# it.
cutover_phase_should_continue() {
  local deadline="$1" samples="$2" min_samples="$3"
  if (( samples < min_samples )); then
    return 0
  fi
  if (( $(cutover_now) < deadline )); then
    return 0
  fi
  return 1
}

cutover_write_state() {
  local phase="$1" manifest_hash="$2" route_version="$3"
  local existing_state
  existing_state="$(cutover_read_state)"
  mkdir -p "$CUTOVER_ARTIFACT_DIR"
  node --input-type=module -e "
    import { writeFileSync, renameSync } from 'node:fs';
    const [stateFile, rawState, phase, manifestHash, routeVersion, runId, artifact] = process.argv.slice(1);
    const state = JSON.parse(rawState);
    state.version = 1;
    state.phase = phase;
    state.manifestHash = manifestHash;
    // The route version arrives from bash as a STRING, so it is
    // PARSED here rather than tested with Number.isInteger on the
    // raw argument — which was always false, and so the route version
    // was recorded as null on every single write. A state file that
    // never records the route version cannot gate a resume on it.
    if (!/^\\d+$/.test(routeVersion)) {
      throw new Error('routeVersion must be a non-negative integer');
    }
    const parsedRouteVersion = Number(routeVersion);
    if (!Number.isSafeInteger(parsedRouteVersion)) {
      throw new Error('routeVersion is outside the safe integer range');
    }
    state.routeVersion = parsedRouteVersion;
    state.runId = runId;
    state.updatedAt = new Date().toISOString();
    const artifacts = new Set(state.artifacts ?? []);
    if (artifact) artifacts.add(artifact);
    state.artifacts = [...artifacts];
    const temporary = stateFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, stateFile);
  " "$CUTOVER_STATE_FILE" "$existing_state" "$phase" "$manifest_hash" "$route_version" "$(cutover_run_id)" "${CUTOVER_LAST_ARTIFACT:-}"
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
  if [[ -z "${SINDUSTRIES_CUTOVER_CALLER_ROOT:-}" ]]; then
    cutover_fail "SINDUSTRIES_CUTOVER_CALLER_ROOT must name the live OpenClaw runtime root before a route can change — a checkout-local edit is not a production cutover" 2
  fi
  node "$CUTOVER_ADAPTER" set \
    --manifest "$manifest_path" \
    --binding "$binding" \
    --expected-version "$expected_version" \
    --run-id "$run_id" \
    --confirm "$run_id" \
    --state-file "$CUTOVER_ROUTE_STATE_FILE" \
    --caller-root "$CUTOVER_CALLER_ROOT"
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
    --state-file "$CUTOVER_ROUTE_STATE_FILE" \
    --caller-root "$CUTOVER_CALLER_ROOT"
}

# ---------------------------------------------------------------------------
# Rehearsal result
# ---------------------------------------------------------------------------

# Build local-recovery evidence from the observed fallback check.
cutover_local_recovery_result() {
  local run_id="$1" reference="$2" fallback_verdict="$3" restore_performed="$4"
  node --input-type=module -e "
    const [runId, reference, fallbackVerdict, restorePerformed] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      version: 1,
      kind: 'local-recovery-result',
      runId,
      reference,
      fallbackHealthVerdict: fallbackVerdict,
      isolatedRestorePerformed: restorePerformed === '1',
      liveFallbackOverwritten: false,
      fallbackRetained: true,
      at: new Date().toISOString(),
    }, null, 2));
  " "$run_id" "$reference" "$fallback_verdict" "$restore_performed"
}

# Build the rollback result from the state captured around the live
# route change. Keeping this boundary in a tested helper prevents the
# shell from silently omitting values consumed through process.argv.
cutover_rollback_result() {
  local run_id="$1" reason="$2" mode="$3" before="$4" after="$5"
  node --input-type=module -e "
    const [runId, reason, mode, before, after] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      version: 1,
      kind: 'rollback-result',
      runId,
      reason,
      mode,
      runtimeRollbackComplete: true,
      dataLayerRecoveryRequired: mode === 'data-layer',
      before: JSON.parse(before),
      after: JSON.parse(after),
      cloudDeploymentRetained: true,
      prodlikeRetained: true,
      at: new Date().toISOString(),
    }, null, 2));
  " "$run_id" "$reason" "$mode" "$before" "$after"
}

# Build the rehearsal result from observed gate outcomes. The caller
# passes exit-derived values; this helper never asserts success itself.
cutover_rehearsal_result() {
  local run_id="$1" probes_verdict="$2" injection_performed="$3" injection_status="$4"
  local recovery_performed="$5" recovery_status="$6" rollback_executed="$7" rollback_idempotent="$8"
  node --input-type=module -e "
    const [runId, probesVerdict, injectionPerformed, injectionStatus, recoveryPerformed, recoveryStatus, rollbackExecuted, rollbackIdempotent] = process.argv.slice(1);
    const failureInjected = injectionPerformed === '1' && injectionStatus === '0';
    const failureRecovered = recoveryPerformed === '1' && recoveryStatus === '0';
    const rolledBack = rollbackExecuted === '1';
    const idempotent = rollbackIdempotent === '1';
    const complete =
      failureInjected &&
      failureRecovered &&
      rolledBack &&
      idempotent &&
      probesVerdict === 'PASS';
    process.stdout.write(JSON.stringify({
      version: 1,
      kind: 'rehearsal-result',
      runId,
      environment: 'staging',
      probesVerdict,
      failureInjected,
      failureInjectionStatus: Number(injectionStatus),
      failureRecovered,
      failureRecoveryStatus: Number(recoveryStatus),
      rollbackExecuted: rolledBack,
      rollbackIdempotent: idempotent,
      verdict: complete ? 'PASS' : 'INCOMPLETE',
      at: new Date().toISOString(),
    }, null, 2));
  " "$run_id" "$probes_verdict" "$injection_performed" "$injection_status" "$recovery_performed" "$recovery_status" "$rollback_executed" "$rollback_idempotent"
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
