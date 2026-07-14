---
status: draft
task_id: 326d4520-6a38-42df-b2c3-fc48c40af249
product_spec: brain/tasks/specs/incident-actioning-system.md
shipped_pr: null
shipped_date: null
authored_by: Rowan
authored_date: "2026-07-12"
---

# Incident actioning system — Rust-first tech design

**Task:** `326d4520-6a38-42df-b2c3-fc48c40af249`
**Repository:** `Stoffer-Industries/sindustries`
**Implementation branch:** `task-326d4520-incident-actioning-system` (proposed)
**Worktree:** `~/workspaces/rowan/sindustries-task-326d4520-incident-actioning-system` (proposed)
**Builds on:** task `75ec1c8c` — Unify agent incident schema
**Review status:** pending Quinn/Tom approval

## Product intent summary

Task `75ec1c8c` unified Quinn and Lox onto a shared incident schema and parser. That made incidents visible across agents, but did not make them actionable.

This task adds the missing runtime layer: route each incident to the right owner, select a runbook, perform only safe remediation, verify the result, back off between real attempts, and escalate to Tom only when Tom is literally required to unblock progress.

The important product decisions from Tom are:

1. **No Tasks API task creation for incidents.** Incident handling is runbook-driven, not task-driven.
2. **`owner` is the routing primitive.** The incident owner says which agent should action it now.
3. **`needsTom` means Tom-only unblock.** It must not mean “the agent failed N times.”
4. **No required persistent schema additions.** Use the existing unified incident schema plus optional `details` metadata.
5. **Prefer Rust for durable workflow/policy engines.** This system is state-machine/gate-enforcement code, like Feature Factory, so the actioning worker should be Rust-first.

## Goals

- Replace Quinn's passive incident loop with a Rust actioning worker that performs explicit runbook-driven remediation.
- Preserve the existing unified incident schema and backward compatibility with Quinn/Lox state files.
- Keep each agent the sole writer of its own state file.
- Prevent repeated re-actioning of Lox-origin incidents handed off to Quinn.
- Make `attempts` mean actual repair attempts only.
- Make `needsTom` low-noise and semantically strict.
- Provide a concrete Rowan review signal without auto-creating tasks.

## Non-goals

- No Tasks API task creation for incidents.
- No schema version bump.
- No shared DB, queue, or network coordination layer.
- No arbitrary shell-command runbooks.
- No automatic Rowan task creation.
- No direct `.openclaw/` config mutation.
- No broad cross-agent root-cause correlation beyond exact-slug handoff dedupe.
- No changes to Lox's existing infra remediation model beyond reading Quinn's mirror state for handoff closure.

## Architecture decision

### Use Rust for the actioning worker

Create a new Rust crate:

```text
agents/workflows/incident-action/
  Cargo.toml
  src/
    main.rs
    model.rs
    normalize.rs
    io.rs
    queue.rs
    runbook.rs
    handlers.rs
    action.rs
  runbooks/
    quinn/*.yaml
    lox/*.yaml          # optional future home; v1 only needs Quinn manifests
  fixtures/
  tests/
```

Binary name: `incident-action`.

Why Rust here:

- The worker is a state machine that mutates durable incident files.
- The bug class we care about is “silently did the wrong thing,” not “script took slightly longer to write.”
- We need strict parsing, typed transitions, deterministic backoff, atomic writes, and high-confidence tests.
- Feature Factory has already proven Rust is a good fit for workflow/policy enforcement in this repo.

Python remains only for compatibility wrappers and existing read-only helpers during migration. New incident actioning logic should not be added to Python.

### Existing Python compatibility

Keep `agents/lib/incident_state.py` for existing heartbeat roll-ups and tests, but narrow its role:

- read/normalize legacy incident state for callers that already depend on it;
- inject runtime `_sourceFile` alongside `_slug`;
- keep `needs_tom()` backward-compatible by default;
- add a direct-only helper for the new semantics.

Required Python API shape:

```python
def needs_tom(incidents, include_high_severity=True):
    """Backward-compatible: needsTom OR high/critical by default."""


def needs_direct_tom(incidents):
    """New strict helper: only incidents with needsTom == true."""
    return needs_tom(incidents, include_high_severity=False)
```

Quinn's attention count should use `needs_direct_tom()`. Other legacy callers may keep the old behavior until deliberately migrated.

## Data model

No new required schema fields.

The Rust worker reads the existing incident objects and may persist optional metadata inside `details.incidentAction`, which is already allowed by the schema's open `details` object.

```json
{
  "owner": "quinn",
  "status": "watching",
  "needsTom": false,
  "attempts": 1,
  "nextRetryAt": "2026-07-12T10:30:00Z",
  "linkedRunbook": "quinn-feature-task-lobster-stall",
  "details": {
    "incidentAction": {
      "sourceAgent": "lox",
      "sourceFile": "brain/state/lox-incident-state.json",
      "sourceSlug": "feature-task-lobster-stall",
      "claimedAt": "2026-07-12T09:00:00Z",
      "lastRunbookId": "quinn-feature-task-lobster-stall",
      "lastOutcome": "repair_failed",
      "rowanReviewNeeded": false,
      "rowanReviewReason": null
    }
  }
}
```

Runtime-only fields injected by parsers:

| Field | Persisted? | Purpose |
|---|---:|---|
| `_slug` | No | Key of the incident in its source file. |
| `_sourceFile` | No | State file path the incident came from. |

The Rust writer must never persist keys beginning with `_`.

## Domain boundary

### Lox-owned incidents

Lox owns incidents rooted in:

- infra, containers, hosts, network;
- process crashes and service availability;
- Docker/Compose lifecycle;
- Tasks API host or gateway host availability;
- cron host reliability.

Examples: container exited, disk full, service healthcheck failing, Tasks API unreachable at the network layer.

### Quinn-owned incidents

Quinn owns incidents rooted in:

- task workflow stalls: feature-task lobster, content-task lobster;
- bookmark pipeline stalls;
- `[openclaw-needed]` handoff stalls;
- tech-design approval stalls;
- automation state drift above the infra layer.

Examples: feature-task lobster stuck in `ready_checks_blocked`, bookmark pipeline not advancing despite eligible items, `[openclaw-needed]` unresolved for more than two heartbeats.

### Ambiguous incidents

If the symptom is in Quinn's workflow but the cause may be infra, **Lox keeps ownership until infra is ruled out**. Once Lox determines the incident is not infra-rooted, Lox hands off by writing the incident in its own file with `owner: "quinn"`.

## Cross-agent handoff and dedupe

### Constraint

Each agent writes only its own state file:

- Quinn writes `brain/state/quinn-ops-state.json`.
- Lox writes `brain/state/lox-incident-state.json`.

Quinn may read Lox's file. Lox may read Quinn's file. Neither agent writes the other's file.

### Problem to avoid

If Lox writes an incident in the Lox file with `owner: "quinn"`, and Quinn resolves it by writing a mirrored resolved entry in Quinn's file, the original Lox entry may still remain `watching` until Lox's next pass.

Without dedupe, Quinn would repeatedly action the stale Lox-origin incident.

### Solution: Quinn claim/mirror records

The Rust queue builder must treat the Quinn file as Quinn's action ledger.

Algorithm:

1. Strict-load both state files and inject `_slug` + `_sourceFile` at runtime.
2. Index incidents by exact slug.
3. For each Lox-file incident with `owner == "quinn"`:
   - if no Quinn-file incident exists for that slug, create a Quinn-file **claim mirror** with the same slug;
   - if a Quinn-file mirror exists and is newer/equivalent, suppress the Lox-origin record from the Quinn action queue;
   - if the Lox-origin record is newer than a resolved Quinn mirror, reopen the Quinn mirror as a recurrence and increment `recurrenceCount`.
4. After claim/mirror reconciliation, the action queue contains only Quinn-file incidents where:
   - `owner == "quinn"`;
   - `status not in {"resolved", "false_positive"}`;
   - `nextRetryAt` is absent or `<= now`;
   - `needsTom` is false, unless the command is explicitly listing Tom-needed incidents.

Newer/equivalent comparison uses the best available timestamp in this order:

1. `resolvedAt`
2. `lastCheckedAt`
3. `escalatedAt`
4. `firstSeen`

If timestamps are missing or unparsable, prefer the Quinn mirror to avoid repeated actioning.

### Lox closure

Lox remains responsible for eventually closing its own stale handoff entry. On its next pass, Lox can read Quinn's mirror by slug and mark the Lox entry `resolved` or `false_positive` if Quinn resolved it.

Even if Lox is delayed, Quinn will not re-action the stale Lox entry because the Quinn mirror is authoritative for Quinn's queue.

## Rust CLI contract

The Rust binary should expose subcommands that are useful both to heartbeat and tests:

```bash
incident-action validate \
  --workspace /Users/quinnstoffer/.openclaw/workspace

incident-action queue \
  --owner quinn \
  --workspace /Users/quinnstoffer/.openclaw/workspace \
  --json

incident-action run \
  --owner quinn \
  --workspace /Users/quinnstoffer/.openclaw/workspace \
  --dry-run=false \
  --json

incident-action needs-tom \
  --workspace /Users/quinnstoffer/.openclaw/workspace \
  --direct-only \
  --json
```

Every command used by cron/heartbeat should emit a JSON envelope:

```json
{
  "ok": true,
  "owner": "quinn",
  "actioned": 1,
  "resolved": 0,
  "skippedBackoff": 2,
  "claimed": 1,
  "rowanReviewNeeded": 0,
  "needsTom": 0,
  "errors": []
}
```

Non-zero exit means the actioning pass failed and did not safely complete. Malformed JSON, invalid manifests, unknown handlers, lock acquisition failure, and write failure are hard errors.

## IO and concurrency

### Two read modes

| Mode | Use | Failure behavior |
|---|---|---|
| Permissive | Legacy heartbeat roll-up | Return empty list and log warning, matching today's Python parser. |
| Strict | Rust actioning worker | Return error; do not action or write state. |

Actioning must always use strict mode. Treating malformed state as empty would drop active incidents from the queue.

### Locking

The Rust actioning pass must take an exclusive lock before read-modify-write of Quinn's file:

```text
brain/state/quinn-ops-state.json.lock
```

Use a best-effort timeout and fail clearly if another actioning pass is already running. This prevents overlapping heartbeat/cron runs from corrupting state or double-incrementing attempts.

### Atomic writes

Writes must be atomic:

1. Serialize to a temp file in the same directory.
2. Preserve existing file permissions where possible.
3. `fsync` the temp file.
4. Atomically rename over the destination.
5. Optionally keep a `.bak` copy of the previous file for one pass.

Rust crates likely needed:

```toml
anyhow = "1"
chrono = { version = "0.4", features = ["serde"] }
clap = { version = "4", features = ["derive"] }
fs2 = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
thiserror = "1"
tempfile = "3"
```

## Runbook model

### agent_validate handler type

Use `agent_validate` when a `status_check` or `verify` step requires LLM judgment to evaluate whether a condition is genuinely a problem, not merely whether a field has a specific value. Example: `5 bookmarks in spec_created state` is not enough by itself; the validation question is whether those bookmarks are genuinely stale or legitimately in-flight.

The Rust worker calls the OpenClaw sessions API (`sessions_spawn` with `mode: "run"`) with a structured prompt containing:

- the incident state;
- relevant workspace context;
- the specific validation question from the runbook manifest.

The spawned agent must respond with a JSON envelope:

```json
{"valid": bool, "reason": "string", "confidence": "high"|"medium"|"low"}
```

The Rust worker parses this envelope and routes the result:

| Response | Confidence | Routing |
|---|---|---|
| `valid: true` | `>= confidence_threshold` | Condition satisfied. |
| `valid: false` | `>= confidence_threshold` | Condition not satisfied; incident stays in its current state and `lastAction` is updated. |
| Any verdict | `< confidence_threshold` | Inconclusive → `watching`. |
| Timeout / parse failure | — | Fallback value, defaulting to `watching`. |

Manifest shape:

```yaml
status_check:
  type: agent_validate
  question: "Is the bookmark pipeline stall at {incident.slug} still a genuine problem? Run the bookmark state analyzer and check if approvalPendingCount > 0 or any spec_created items exist without a specPath. Respond with JSON: {valid: bool, reason: string, confidence: high|medium|low}"
  confidence_threshold: medium
  timeout_seconds: 60
  fallback: watching
```

Safety rules:

- `agent_validate` never mutates incident state itself — it only returns a verdict.
- Low-confidence responses default to `watching` and do not auto-resolve.
- Timeouts and failures fall back to `watching` by default and must never auto-resolve on failure.
- `fallback: resolved` must be rejected at manifest validation time.
- The Rust worker still owns all state mutations.

Deterministic Rust handlers are preferred wherever possible. Use `agent_validate` only when structural field checks are insufficient.

### No arbitrary shell in manifests

Runbook manifests must be declarative. They may reference deterministic Rust handler IDs or `agent_validate` specs (see Handler types section below), but must not contain arbitrary shell commands.

Reason: incident actioning will eventually run unattended. Shell strings in YAML create a policy-bypass surface and make review harder.

Each deterministic handler ID must be implemented in Rust and registered in a static allow-list. Unknown handler IDs fail validation. `agent_validate` specs are validated for required fields (`question`, `timeout_seconds`, `fallback`) at manifest load time, and `fallback: resolved` fails validation.

### Manifest location

Machine-readable manifests:

```text
agents/workflows/incident-action/runbooks/quinn/*.yaml
```

Human-readable runbooks:

```text
infra/runbooks/incidents/quinn/*.md
```

The manifest should link to the human runbook path.

### Manifest shape

```yaml
runbook_id: quinn-feature-task-lobster-stall
owner: quinn
human_runbook: infra/runbooks/incidents/quinn/feature-task-lobster-stall.md

match:
  slug_prefixes:
    - feature-task-lobster-stall
    - feature-task-ready-checks-blocked
  linked_runbook_values:
    - quinn-feature-task-lobster-stall

safety_class: external_write   # read_only | local_write | external_write | destructive
max_auto_attempts: 3
backoff_minutes: [30, 60, 120, 240, 480]

# Each handler field may be a deterministic Rust handler ID:
status_check: feature_task_status_check
repair: feature_task_lobster_retry
verify: feature_task_status_check

# Or, for status_check / verify when judgment is required, an agent_validate spec:
# status_check:
#   type: agent_validate
#   question: "Is the bookmark pipeline stall at {incident.slug} still a genuine problem?"
#   confidence_threshold: medium
#   timeout_seconds: 60
#   fallback: watching

on_exhausted: rowan_review_needed   # rowan_review_needed | watching | needs_tom
needs_tom_conditions:
  - missing_credentials
  - explicit_human_approval_required
```

### Handler types

The `status_check`, `repair`, and `verify` fields in a manifest may reference either a **deterministic Rust handler ID** or an **`agent_validate` spec**. Deterministic Rust handlers are the default and should be used whenever a structural field check or an idempotent API call is sufficient.

`agent_validate` exists only for cases where LLM judgment is required, such as distinguishing genuinely stalled bookmark items from legitimately in-flight ones or deciding whether a tech-design comment is substantively approved vs. incidentally matching a substring. It is not a replacement for ordinary deterministic handlers.

#### Deterministic handler IDs (Rust)

Deterministic handler references are string IDs that map to a static Rust allow-list. Unknown IDs fail manifest validation.

### Safety classes

| Class | Meaning | Auto-repair? |
|---|---|---:|
| `read_only` | Status checks only. | No |
| `local_write` | Writes only Quinn's own local state file. | Yes |
| `external_write` | Calls approved external APIs or existing idempotent workflow commands. | Yes, capped by `max_auto_attempts` |
| `destructive` | Irreversible or high-risk action. | No; requires Tom if action is necessary |

### Initial Quinn runbooks

Create both YAML manifests and human `.md` stubs for:

- `quinn-feature-task-lobster-stall`
- `quinn-content-task-lobster-stall`
- `quinn-bookmark-pipeline-stall`
- `quinn-openclaw-handoff-stall`
- `quinn-tech-design-approval-stall`
- `quinn-incident-no-runbook`

Unknown slugs must route to `quinn-incident-no-runbook`; they must not just log and disappear.

## Action loop semantics

### Queue processing pseudocode

```rust
fn run_once(owner: Owner, workspace: PathBuf, dry_run: bool) -> Result<Envelope> {
    let _lock = StateLock::acquire(workspace.quinn_lock_path())?;

    let mut state = StateStore::load_strict(workspace)?;
    let claim_summary = state.claim_foreign_quinn_incidents()?;
    let queue = Queue::build(&state, owner, Utc::now())?;

    for incident_ref in queue {
        let runbook = RunbookRegistry::resolve(&state[incident_ref])
            .unwrap_or_else(|| RunbookRegistry::fallback_no_runbook());

        let status = runbook.status_check(&state[incident_ref])?;
        if status.is_ok() {
            state.mark_resolved(incident_ref, runbook.id(), "status check passed")?;
            continue;
        }

        let decision = runbook.repair_decision(&state[incident_ref])?;
        match decision {
            RepairDecision::Unsafe { reason, tom_required } => {
                state.record_no_attempt(incident_ref, reason)?;
                if tom_required {
                    state.mark_needs_tom(incident_ref, reason)?;
                } else {
                    state.throttle_without_attempt(incident_ref, runbook.next_backoff_without_attempt())?;
                }
            }
            RepairDecision::RowanReviewNeeded { reason } => {
                state.mark_rowan_review_needed(incident_ref, reason)?;
                state.throttle_without_attempt(incident_ref, runbook.next_backoff_without_attempt())?;
            }
            RepairDecision::Repair(handler) => {
                if state[incident_ref].attempts >= runbook.max_auto_attempts {
                    state.handle_exhausted(incident_ref, runbook.on_exhausted)?;
                    continue;
                }

                if !dry_run {
                    handler.run(&state[incident_ref])?;
                }
                state.increment_attempts(incident_ref)?;

                let verified = runbook.verify(&state[incident_ref])?;
                if verified.is_ok() {
                    state.mark_resolved(incident_ref, runbook.id(), "repair verified")?;
                } else if verified.requires_tom() {
                    state.mark_needs_tom(incident_ref, verified.reason())?;
                } else {
                    state.set_backoff_after_attempt(incident_ref, runbook.backoff_for_attempt())?;
                }
            }
        }
    }

    if !dry_run {
        state.write_quinn_atomic()?;
    }
    Ok(state.envelope(claim_summary))
}
```

### Attempts

`attempts` increments **only** after a repair handler actually runs.

It must not increment for:

- passive status checks;
- backoff skips;
- no-runbook fallback classification;
- unsafe repair decisions;
- dry runs;
- missing credentials discovered before a repair attempt;
- incidents skipped because Tom is required.

`nextRetryAt` may still be set without incrementing `attempts` to avoid noisy re-processing of known unsafe/no-runbook cases. In that case `lastAction` must clearly say no repair attempt was made.

### Backoff

Default repair-attempt backoff:

| Attempts after failed repair | Next retry |
|---:|---:|
| 1 | +30 min |
| 2 | +1 h |
| 3 | +2 h |
| 4 | +4 h |
| 5+ | +8 h cap |

Runbook manifests may specify a shorter list, but the cap must not be lower than 30 minutes unless the runbook is `read_only`.

### Exhaustion

Exhausting `max_auto_attempts` does **not** automatically set `needsTom`.

The runbook decides the exhausted behavior:

- `rowan_review_needed`: set `details.incidentAction.rowanReviewNeeded = true`, keep `needsTom = false`.
- `watching`: stop auto-repair and leave visible in Quinn's incident state.
- `needs_tom`: allowed only when the runbook's failure mode means Tom is literally required.

This preserves Tom's decision that repeated failures are not, by themselves, Tom-actionable.

## `needsTom` semantics

After this feature, `needsTom: true` means:

> Tom's direct action, approval, credentials, or decision are required before the incident can progress.

Examples that may set `needsTom: true`:

- missing credentials only Tom can rotate or provide;
- billing/quota intervention only Tom controls;
- explicit approval required before a destructive or externally visible repair;
- tech design approval is blocked waiting for Tom.

Examples that must **not** set `needsTom: true`:

- the runbook has failed N times;
- the incident is likely a Rowan code bug;
- the incident is high/critical severity but still agent-actionable;
- a status check was inconclusive.

Quinn's heartbeat attention count should use direct-only `needsTom`. High severity can be surfaced elsewhere, but it must not inflate “Tom needs to act” counts.

## Rowan review signal

No Rowan task is auto-created.

When Quinn determines an incident is likely a Rowan-domain code/workflow bug, the Rust worker writes a concrete durable signal into Quinn's own incident entry:

```json
{
  "status": "watching",
  "needsTom": false,
  "lastAction": "Rowan review needed: feature-task runbook exhausted after verified repair attempts",
  "details": {
    "incidentAction": {
      "rowanReviewNeeded": true,
      "rowanReviewReason": "feature-task runbook exhausted after verified repair attempts",
      "lastRunbookId": "quinn-feature-task-lobster-stall"
    }
  }
}
```

Rowan's heartbeat/feature workflow should scan Quinn incidents for:

```text
owner == "quinn"
status == "watching"
needsTom == false
details.incidentAction.rowanReviewNeeded == true
```

That gives Rowan a concrete pickup path without creating unwanted Tasks API dependency chains.

## Heartbeat integration

### Quinn heartbeat replacement behavior

Replace the passive OPS STATE MANAGEMENT loop with:

1. Run `incident-action run --owner quinn --workspace <workspace> --json`.
2. If the command fails, surface the failure clearly; do not treat missing/malformed state as zero incidents.
3. Run `incident-action needs-tom --direct-only --json` for Tom attention count.
4. Report:
   - incidents actioned;
   - incidents resolved;
   - incidents in backoff;
   - incidents requiring Rowan review;
   - incidents requiring Tom.
5. Do not increment attempts in heartbeat prompt text; the Rust worker owns attempt mutation.

### Cron / prompt files

Update the relevant heartbeat/cron prompt in the repo so it calls the Rust worker instead of implementing incident retries in prompt prose.

If a `.openclaw/` runtime config change is required, Rowan must not apply it directly. Use the existing `[openclaw-needed]` / `[openclaw-done]` handoff path.

## File/module scope

### New files

```text
agents/workflows/incident-action/Cargo.toml
agents/workflows/incident-action/src/main.rs
agents/workflows/incident-action/src/model.rs
agents/workflows/incident-action/src/normalize.rs
agents/workflows/incident-action/src/io.rs
agents/workflows/incident-action/src/queue.rs
agents/workflows/incident-action/src/runbook.rs
agents/workflows/incident-action/src/handlers.rs
agents/workflows/incident-action/src/action.rs
agents/workflows/incident-action/runbooks/quinn/*.yaml
agents/workflows/incident-action/fixtures/*.json
infra/runbooks/incidents/quinn/*.md
```

### Existing files to update

```text
agents/lib/incident_state.py
agents/lib/test_incident_state.py
agents/crons/prompts/*heartbeat*.md or Quinn heartbeat prompt location
MEMORY/agent heartbeat docs only if required by the repo conventions
```

Do not edit `.openclaw/` files in this task unless Tom explicitly approves an `[openclaw-needed]` handoff.

## AC mapping

### AC1 — Incident routing schema / owner classification

Satisfied by:

- preserving `owner` as the routing primitive;
- strict Quinn/Lox domain boundary;
- Rust queue builder filtering by owner and source file;
- Lox→Quinn claim/mirror algorithm.

### AC2 — Auto-task creation trigger and assignment logic

Superseded by Tom's decision: **there is no auto-task creation**.

Replacement:

```text
incident detected
  → owner assigned
  → runbook resolved
  → direct safe remediation attempted
  → Rowan review signal OR Tom-only escalation if needed
```

### AC3 — Lifecycle: incident → task → resolved

Superseded by no-task decision.

Updated lifecycle:

```text
incident detected
  → owner assigned
  → Quinn claim/mirror if Lox-origin owner=quinn
  → runbook selected
  → status check
      → OK: resolved
      → not OK: safe repair decision
          → repair runs: attempts + 1, verify, backoff/resolve
          → unsafe/no runbook: visible lastAction, no attempts increment
          → Tom required: needsTom true, escalated
          → Rowan bug likely: rowanReviewNeeded true, watching
```

### AC4 — `needsTom` gate

Satisfied by strict direct-only semantics and the Rust `needs-tom --direct-only` command.

### AC5 — Backward compatibility

Satisfied by:

- no required schema additions;
- preserving Python parser compatibility;
- adding optional `include_high_severity` without breaking old `needs_tom()` default behavior;
- normalizing legacy Quinn `ops` and Lox `incidents` shapes in Rust parity tests.

### AC6 — No schema changes unless strictly necessary

Satisfied. No required schema fields are added. Optional metadata lives under `details.incidentAction`, which the existing schema permits.

## Test plan

### Rust unit tests

- Quinn legacy state normalizes to unified incidents.
- Lox state normalizes to unified incidents.
- Runtime `_slug` and `_sourceFile` are injected and never persisted.
- Malformed JSON fails in strict mode.
- Malformed JSON returns empty only in permissive mode.
- Atomic write strips runtime `_` fields.
- Lock prevents overlapping actioning passes.
- Lox-origin `owner=quinn` incident creates a Quinn claim mirror.
- Existing Quinn resolved mirror suppresses stale Lox-origin incident.
- Newer Lox-origin recurrence reopens/increments the Quinn mirror.
- Queue skips `resolved` and `false_positive` statuses.
- Queue skips future `nextRetryAt` without incrementing `attempts`.
- Unknown runbook routes to `quinn-incident-no-runbook`.
- Unknown handler ID fails manifest validation.
- Manifest containing arbitrary command fields fails validation.
- `attempts` increments only when a repair handler runs.
- Unsafe repair does not increment `attempts`.
- Dry run does not write or increment `attempts`.
- Exhaustion does not set `needsTom` unless runbook explicitly maps that condition to Tom-required.
- `needs-tom --direct-only` returns only `needsTom == true` incidents.
- `agent_validate` timeout falls back to `watching` and does not auto-resolve.
- `agent_validate` low-confidence response (below threshold) leaves incident in `watching` and does not auto-resolve.
- `agent_validate` `valid: true` with high confidence marks the incident resolved (when used as status_check) or advances the repair flow (when used as verify).
- `agent_validate` `valid: false` with high confidence leaves incident in current state with updated `lastAction`.
- `agent_validate` manifest missing required fields (`question`, `timeout_seconds`, `fallback`) fails validation.
- `agent_validate` `fallback: resolved` is rejected at manifest validation time.

### Python compatibility tests

Update/add tests in `agents/lib/test_incident_state.py`:

- `parse_file()` injects `_sourceFile`.
- `_sourceFile` matches the file path read.
- `needs_tom()` default remains backward-compatible: `needsTom` OR high/critical severity.
- `needs_tom(include_high_severity=False)` returns only direct Tom incidents.
- `needs_direct_tom()` returns only direct Tom incidents.

### Integration tests / fixtures

Create fixture workspaces under `agents/workflows/incident-action/fixtures/`:

1. Quinn file malformed, Lox valid → strict run fails, no writes.
2. Lox handoff only → run claims into Quinn file, no repair yet if dry-run.
3. Lox handoff + Quinn resolved mirror → run does not re-action.
4. Backoff incident → run skips and does not increment attempts.
5. Repair success → attempts increments once, status resolved, `needsTom=false`.
6. Repair failure → attempts increments once, `nextRetryAt` set.
7. Exhausted Rowan-domain incident → `rowanReviewNeeded=true`, `needsTom=false`.
8. Missing credential incident → `needsTom=true`, status escalated.

### Commands to validate before PR

```bash
cargo test --manifest-path agents/workflows/incident-action/Cargo.toml
python3 -m pytest agents/lib/test_incident_state.py
incident-action run --owner quinn --workspace agents/workflows/incident-action/fixtures/lox-handoff --dry-run --json
```

If the repo has a global test/lint command for agents, run that as well.

## Rollout plan

1. Implement Rust crate with strict parser, queue builder, dry-run mode, and tests.
2. Add runbook manifest validation with no repair handlers enabled.
3. Add Quinn claim/mirror dedupe and strict `needs-tom` listing.
4. Enable read-only/status-check runbooks.
5. Enable low-risk `local_write` repairs.
6. Enable selected `external_write` repairs only after each handler has idempotency tests.
7. Update Quinn heartbeat to call the Rust worker.
8. Run in dry-run for at least one heartbeat cycle and compare output to current passive incident list.
9. Switch to live mode after dry-run output is sane.
10. Clean up legacy `needsTom=true` incidents that were escalated only because old attempts reached a threshold.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| State file corruption | Exclusive lock + atomic write + strict parse + backup. |
| Repeated actioning of Lox handoffs | Quinn claim/mirror ledger and source-file-aware queue. |
| No-runbook incidents vanish | Mandatory fallback runbook that writes visible `lastAction`. |
| `needsTom` count changes surprise callers | Keep Python default backward-compatible; use new direct-only helper/CLI for Quinn attention count. |
| Runbook manifests become arbitrary automation | Declarative YAML only; no shell strings; static Rust handler allow-list. |
| Auto-repair does too much | Start read-only/local; require explicit handler tests before external writes. |
| Rust and Python parsers diverge | Fixture parity tests for legacy Quinn and Lox shapes. |
| Rowan-domain issues get lost | Durable `details.incidentAction.rowanReviewNeeded` signal and heartbeat scan. |
| Agent validate call fails or times out | Fallback to `watching`; never auto-resolve on agent failure. |
| `agent_validate` returns low-confidence verdict | Routed to `watching`; does not auto-resolve until confidence meets threshold. |
| `agent_validate` spawns agent that mutates state | Safety rule: agent returns verdict JSON only; Rust worker owns all mutations. Enforce at manifest validation. |

## Definition of done

- Rust `incident-action` crate implemented with passing unit/integration tests.
- Quinn/Lox legacy fixtures parse correctly in Rust and Python.
- Quinn actioning pass uses strict IO and atomic writes.
- Lox→Quinn handoff dedupe prevents stale re-actioning.
- `attempts` increments only after real repair handlers run.
- Unknown/no-runbook incidents remain visible through fallback runbook.
- Direct-only `needsTom` count is available and used by Quinn heartbeat.
- Rowan review signal is concrete and documented.
- No Tasks API incident tasks are created.
- No `.openclaw/` files are modified without explicit handoff.
- System documentation is updated when the implementation ships.
