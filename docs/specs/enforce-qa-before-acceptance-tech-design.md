---
status: draft
task_id: fb5c4e40-e3ba-4413-a040-47b2b56ddd35
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Enforce QA Before Acceptance Status — Tech Design

**Task:** `fb5c4e40-e3ba-4413-a040-47b2b56ddd35` — Enforce QA before acceptance status
**Branch:** `task-fb5c4e40-enforce-qa-before-acceptance`
**Worktree:** `/Volumes/WD1/worktrees/rowan/task-fb5c4e40-enforce-qa-before-acceptance`
**Repository:** `Stoffer-Industries/sindustries`
**Owner:** Rowan
**Task type:** `code` (tech design gate is optional for code tasks; a full design is provided because this change spans the Tasks API boundary and the Lobster workflow in two different languages)

## Product intent

A task must not reach `acceptance` — Tom's human sign-off gate — until Ash's structured `qa_agent` approval has actually been granted. Today it can, and it has: three tasks (`a890e036-42f5-4858-87c7-47ea81ddb94d`, `05cc9c02-4a49-4a96-9b41-7f6c4f6666ab`, `88cd00e0-50ee-4733-8a59-670282525eb6`) were promoted to `acceptance` with their `qa_agent` approval still `pending`.

The intent is that the ordering is **enforced by the system, not by convention**. Two layers currently trust that callers behave:

1. The Tasks API validates that a requested status is a valid enum member, but nothing about *whether that transition is legal*.
2. The Lobster's `verify_delivery` stage checks the `qa_agent` gate, but only when it runs — and it exits early for a task that is already past `doing`.

Either layer alone can be bypassed by a well-meaning caller (a script, an agent, a UI action) that moves the task directly. The durable fix is to make the illegal transition **impossible to express**, and to make the already-damaged state **detectable and reconcilable**.

## Root cause (current state)

### Layer 1 — the API accepts any valid status transition

`services/tasks-api/src/routes/tasks.ts:699-705` (PATCH `/tasks/:id`):

```js
if (req.body?.status !== undefined) {
  if (!validStatuses.has(req.body.status)) {
    return badRequest(res, 'INVALID_STATUS_VALUE', 'Invalid status value');
  }
  updates.status = req.body.status;
  updates.statusChangedAt = new Date();
  updates.completedAt = req.body.status === 'done' ? new Date() : null;
}
```

`validStatuses` (`services/tasks-api/src/routes/tasks/_constants.ts:7`) is only the enum vocabulary:

```js
export const validStatuses = new Set(['open', 'ready', 'doing', 'acceptance', 'done']);
```

So `PATCH {status: "acceptance"}` on a task in `doing` with a `pending` `qa_agent` approval is a **200 OK**. The approval prerequisite exists only in the caller's head.

### Layer 2 — the Lobster's guard is skipped for already-promoted tasks

`agents/workflows/feature-task/src/verify_delivery.rs:463-468` sits near the top of `verify_delivery`, *before* any `qa_agent` audit:

```rust
if is_past(&env.task, "doing") {
    env.already_past = true;
    env.criteria_met = true;
    env.action_taken = "already_past_doing".to_string();
    return Ok(env);
}
```

`is_past` (`agents/workflows/feature-task/src/lobster_state.rs:203-205`) is a pure rank comparison:

```rust
pub(crate) fn is_past(task: &Task, stage: &str) -> bool {
    status_rank(&task.status) > status_rank(stage)
}
```

Because `acceptance` ranks above `doing`, a task that was promoted early satisfies `is_past(task, "doing")` and returns `already_past_doing` with `criteria_met = true`. **The Lobster treats the gate as satisfied because the task is already past it** — the exact inversion of what the gate is for. The `qa_agent` predicate (`agents/workflows/feature-task/src/task_approvals.rs:100-102`) is never consulted for such a task:

```rust
pub(crate) fn qa_agent_verified(task: &Task) -> bool {
    task_approval_granted(task, "qa_agent") && !qa_agent_deferred(task) && !qa_agent_blocked(task)
}
```

and the underlying grant check (`agents/workflows/feature-task/src/task_approvals.rs:56-60`) is exactly the predicate AC1 needs:

```rust
task.approvals.iter().any(|a| a.approval_type == approval_type && a.state == "approved")
```

So the correct predicate already exists in the Lobster, and the correct data already exists in the database — they are simply not consulted at the two points where the decision is made.

### Consequence

Because `workflowGates` are derived from current status, an early promotion makes the pending `qa_agent` gate dormant and invisible: the only visible gate left is the final `accepted` gate owned by Tom. The skipped QA step is not merely out of order — it is erased from the surface operators read.

## Scope

**In scope**

- Enforce the `qa_agent` precondition on the `doing → acceptance` transition **at the Tasks API boundary** (AC1, AC2, AC4).
- Make the Lobster's `verify_delivery` detect and report tasks that are already `acceptance` with a missing/revoked `qa_agent` approval, instead of reporting `already_past_doing` (AC3).
- Identify the existing affected tasks and route them for manual state repair or QA rerun, **without** synthesising any QA or acceptance approval (AC5).

**Out of scope**

- Changing the Lobster's *ordering* on the happy path — the existing `qa_agent` gate already blocks a clean `doing → acceptance` promotion. AC3 is about the reconciliation path, not about re-implementing the gate.
- Any change to the `qa_agent` grant endpoint's attestation rules (`services/tasks-api/src/routes/taskApprovals.ts:94-110`). That path already refuses unattested grants; this task only consumes the result.
- Retro-fixing or re-approving the three damaged tasks. AC5 is explicitly "identify ... for manual state repair or QA rerun" — the repair is a separate, human-authorised action.
- Any change to `content` / `research` task types, which do not require `qa_agent` (see "Ownership boundary" below).

## Ownership boundary

**Natural source of truth: database-backed domain data, read through an API-owned contract.**

- The `qa_agent` approval state lives in the `TaskApproval` table (`services/tasks-api/prisma/schema.prisma:198-235`) — `type`, `state` (`pending` / `approved` / `revoked`), `revokedAt`, plus the evidence pins `verifiedPrNumber` / `verifiedPrHeadSha` / `verifiedAcSectionDigest`. This is already the single source of truth for every approval-aware predicate in the system, and the Lobster reads it from the same rows.
- *Which* approvals a task type requires is **config-driven**, not hardcoded: `services/tasks-api/src/config/requiredApprovals.ts` loads `.openclaw/tasks-api/required-approvals.yaml` at startup, with built-in defaults `feature: [spec, tech_design, qa_agent, accepted]`, `code: [tech_design, qa_agent, accepted]`, `content: []`, `research: []`.

**Decision: the API enforces the transition, deriving the required set from the existing config rather than hardcoding `qa_agent`.**

The alternative — hardcoding "if status becomes acceptance, require an approved `qa_agent` row" — is simpler to write but creates a second source of truth for *which approvals gate which transition*, and it silently breaks the moment Quinn or Tom edits the YAML to add or remove a gate for a task type. Reusing `requiredApprovalsFor(loadRequiredApprovalsConfig(), task.taskType)` keeps one policy, one place to edit, and no deploy.

**Why the API and not the Lobster.** The Lobster is the workflow's *driver*, not its boundary. Any caller — a Lobster run, a script, the Tasks UI, another agent using an API token — can reach `PATCH /tasks/:id`. Enforcing in the Lobster alone leaves the illegal transition expressible by every other caller; enforcing in the API alone leaves the Lobster blind to already-damaged rows. Both layers are needed, and they are not duplicates: the API layer is *prevention* (AC1, AC2), the Lobster layer is *detection and reconciliation* (AC3).

**Why not the UI.** The UI is the least reliable enforcement point — it is one of several callers, it is client-side, and it can be bypassed by any API client. AC1 says the transition must not be possible, which is an API-boundary property.

**Service ownership.** This change touches the `services/tasks-api` service and the `agents/workflows/feature-task` workflow crate. No new service, no new table, no new external dependency, and no cross-service data migration. The `TaskApproval` table is unchanged — this task only *reads* it from a second place.

## Implementation plan

### WS1 — API boundary enforcement (AC1, AC2, AC4)

**File:** `services/tasks-api/src/routes/tasks.ts` (PATCH `/tasks/:id`, status branch at `:699`)

Extract the status transition into a small pure helper so it is unit-testable without a database, in keeping with the existing `_validation.ts` convention:

- New module `services/tasks-api/src/routes/tasks/_statusTransitions.ts`
  - `export function statusTransitionError(fromStatus, toStatus, taskType, approvals): { code, message } | null`
  - Returns a non-null error only for an *illegal* transition. `null` means "allowed".
  - Rule set (initially):
    - `doing → acceptance` is illegal unless the task type's required-approvals set includes `qa_agent` **and** the task has a `qa_agent` approval row with `state === 'approved'` and `revokedAt === null`.
    - `acceptance → done` is illegal unless the `accepted` approval is granted (this mirrors the Lobster's existing `accepted_structured` check, `agents/workflows/feature-task/src/task_approvals.rs:73-74`) — the task description's AC4 requires coverage of "the existing acceptance-to-done path", and today the API does not enforce it either.
  - Any other transition is allowed, preserving current behaviour (including the `acceptance → doing` regression path that `tasks.ts:788-793` already special-cases for attention owners).

- The PATCH handler calls the helper before mutating, and on a violation returns **409 Conflict** with a stable machine-readable code:
  - `QA_APPROVAL_REQUIRED` — the transition needs `qa_agent` and it is `pending` or absent.
  - `QA_APPROVAL_REVOKED` — a `qa_agent` row exists but is `revoked`.
  - `ACCEPTANCE_APPROVAL_REQUIRED` — the `acceptance → done` transition without an approved `accepted` row.

  **On the status code:** 409 Conflict, not 400. 400 means "the request is malformed and will never be valid"; 409 means "the request is well-formed but conflicts with current server state" — which is exactly the situation. The existing `taskApprovals.ts:28` already uses 409 (`TASK_IMMUTABLE`) for a comparable conflict, so this is consistent with house convention.

- **Critical constraint (AC2): the task status must be left unchanged.** The validation must run *before* the `prisma.$transaction` block that applies `updates`, and must not write anything — not the status, not `statusChangedAt`, not `completedAt`. The existing handler already builds `updates` before the transaction, so the check slots in cleanly at the point where `updates.status` is set.

- **The error body must not leak.** It should name the missing approval type and the task's current status, and point at the resolution (the gate owner), but must not include approval row internals beyond what the caller already sees from `GET /tasks/:id/approvals`.

**Files:**
- `services/tasks-api/src/routes/tasks/_statusTransitions.ts` (new — pure helper)
- `services/tasks-api/src/routes/tasks.ts` (wire the check into the PATCH handler)
- `services/tasks-api/src/routes/tasks/_constants.ts` (error-code constants, if the house style prefers them here)

### WS2 — Lobster reconciliation for already-promoted tasks (AC3)

**File:** `agents/workflows/feature-task/src/verify_delivery.rs`

The `is_past(&env.task, "doing")` early return at `:463` is the idempotency hole Quinn identified. It must not be deleted — it exists so a re-run of the stage on a task that has *legitimately* passed the gate is a no-op. But it must distinguish two cases that are currently conflated:

- **The task is past `doing` *and* the `qa_agent` gate was genuinely satisfied.** → keep `already_past_doing`, `criteria_met = true`. No behaviour change.
- **The task is past `doing` *and* the `qa_agent` approval is missing, `pending`, or `revoked`.** → this is a damaged task, and the stage must **not** report success.

For the second case, `verify_delivery` should return a blocked envelope that:

1. Sets `env.criteria_met = false` and records a `failureFingerprint` that names the skipped gate — e.g. `verify_delivery_qa_agent_skipped` — so the fingerprint is distinguishable from an ordinary pending-QA block (`verify_delivery_qa_agent_blocked`, already present at `:725`).
2. Emits a task comment that states plainly: the task is in `acceptance`, its `qa_agent` approval is `<pending|revoked|absent>`, and the required repair is a QA rerun by Ash or a manual status repair by an authorised operator — **not** an automatic re-promotion.
3. **Does not** synthesise, grant, or imply any approval, and **does not** move the task's status. The task is already at `acceptance`; the repair decision is an authorised human/agent action, and AC5 says so explicitly.

This reuses the existing `qa_agent_verified` predicate (`task_approvals.rs:100`) rather than re-deriving the rule, so the Lobster and the API share one definition of "QA is verified" — modulo the deferred/blocked markers, which the API-side check does not model and which are Lobster-internal states. **This divergence must be called out:** the API checks `state === 'approved' && revokedAt === null`; the Lobster additionally requires "not deferred" and "not blocked". The API cannot see those markers (they are comment-derived), so it will accept a grant the Lobster considers deferred. That is safe in the direction that matters — the API is the floor, the Lobster is stricter — but it must be documented so the two are not expected to agree exactly.

**Rust quality gates:** this touches `agents/workflows/feature-task/**`, so the crate's local + CI quality gates apply (see `agents/workflows/feature-task/WORKFLOW.md`): `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`. The existing `verify_delivery.rs` test module (`#[cfg(test)] mod tests`, `:760`+) is where the new unit tests belong.

**Files:**
- `agents/workflows/feature-task/src/verify_delivery.rs` (split the early return; add the blocked envelope for the damaged case)
- `agents/workflows/feature-task/src/task_approvals.rs` (only if a shared "qa gate satisfied for an already-promoted task" helper is warranted — prefer adding it here over duplicating the predicate in `verify_delivery.rs`)

### WS3 — Affected-task identification and repair routing (AC5)

**Read-only identification** (no writes to approval state):

The three tasks named in the task description are known instances. The implementation must also produce a **complete** list, not just those three, by querying for tasks where `status = 'acceptance'` and the task type requires `qa_agent` and no `qa_agent` approval row is `approved`. That query belongs in the Tasks API as a small read-only endpoint or a maintenance script, and its output is recorded as an audit artefact in the PR body.

**Repair is out of this implementation's hands.** The three options are: (a) Ash reruns QA and grants `qa_agent` properly; (b) an authorised operator moves the task back to `doing` for redelivery; (c) an authorised operator moves it to `done` if QA was in fact performed but never recorded. **This implementation must not perform (c) or synthesise any approval** — AC5 forbids it and the audit trail depends on it. The identified list is published as a task comment with the per-task recommended repair, and routed to the person who can decide.

The affected tasks are already visible in the live queue: `a890e036`, `05cc9c02`, `88cd00e0` all sit in `acceptance` with `WAITING_EXTERNAL` classification and no `qa_agent` grant.

### WS4 — Docs

- `docs/systems/tasks.md` — the durable system doc for the task system. Add the enforced transition rules and the conflict error codes. This is the consolidated home for task-status behaviour (per `docs/CONVENTIONS.md`, a transition-rule detail belongs in the existing system doc, not a new file).
- `apps/tasks/SPEC.md` — update **only if** the Tasks UI surfaces the new 409 conflict to the user. If the UI shows a generic error toast for a failed status change, this is a no-op and the PR body states why.

## API contract changes

| Method | Path | Change |
|---|---|---|
| `PATCH` | `/tasks/:id` | `status` transitions are now validated against approval prerequisites. New failures: **409** `QA_APPROVAL_REQUIRED`, **409** `QA_APPROVAL_REVOKED`, **409** `ACCEPTANCE_APPROVAL_REQUIRED`. On rejection the task is left entirely unchanged. |
| `GET` | `/tasks/:id/approvals` | unchanged (already exposes the rows the new check reads) |
| `GET` | `/task-types/:taskType/required-approvals` | unchanged (already exposes the config the new check reads) |

No new endpoints are required for the enforcement itself. WS3's identification query is read-only and may be a script rather than a new public endpoint — **open question 3** below.

**Backward compatibility.** The change is deliberately breaking for callers that were relying on the unenforced transition — which is the point. The affected callers are: the Lobster (already gated, so unaffected on the happy path), the Tasks UI (status changes go through the UI's gate flow), and ad-hoc agents. Any caller that legitimately needs to promote a task whose QA is genuinely done should **grant the approval properly**, not bypass the transition.

## Test plan

### AC-by-AC verification matrix

| AC | Verification | Layer | Test |
|---|---|---|---|
| **AC1** — a task cannot transition `doing → acceptance` unless its required `qa_agent` approval is approved and not revoked | Unit tests over `statusTransitionError` for: `qa_agent` `approved` + `revokedAt === null` → allowed; `qa_agent` `pending` → rejected; `qa_agent` `revoked` → rejected; `qa_agent` absent → rejected; `qa_agent` `approved` but `revokedAt` set → rejected. Plus: a `content` task type (no `qa_agent` required) transitioning `doing → acceptance` → allowed. | Unit | `services/tasks-api/test/statusTransitions.test.ts` (new) |
| **AC2** — the API returns a clear, tested error for a premature transition and leaves the task status unchanged | Integration test against the real DB: PATCH a `doing` task with a `pending` `qa_agent` to `acceptance` → expect **409**, error code `QA_APPROVAL_REQUIRED`; then read the task back and assert `status` is still `doing`, `statusChangedAt` unchanged, and no approval row was created or mutated. Repeat for the revoked case → `QA_APPROVAL_REVOKED`. | Integration (real Postgres) | `services/tasks-api/test/statusTransition.integration.test.ts` (new), following the existing `db-integration.test.ts` pattern |
| **AC3** — the Lobster promotion path moves a delivered task to `acceptance` only after Ash's `qa_agent` approval; merged implementation evidence alone is insufficient | (a) Rust unit test: `verify_delivery` on a task in `doing` with delivery evidence but `qa_agent` `pending` → blocked, fingerprint `verify_delivery_qa_agent_blocked`, status unchanged. (b) Rust unit test: `verify_delivery` on a task already in `acceptance` with `qa_agent` `pending` → **not** `already_past_doing`; fingerprint `verify_delivery_qa_agent_skipped`; no approval synthesised. (c) Rust unit test: task already in `acceptance` with `qa_agent` `approved` → `already_past_doing`, `criteria_met = true` (no regression). | Unit (Rust) | `agents/workflows/feature-task/src/verify_delivery.rs` test module |
| **AC4** — tests cover the rejected premature transition, the approved transition, revoked/stale QA approval, and the existing acceptance-to-done path | The unit matrix in AC1 covers rejected / approved / revoked / stale (`revokedAt` set on an approved row). For `acceptance → done`: unit test with `accepted` `approved` → allowed; `accepted` `pending` → **409** `ACCEPTANCE_APPROVAL_REQUIRED`; plus an integration test that the existing `acceptance → done` happy path still succeeds. | Unit + Integration | as above |
| **AC5** — existing affected tasks are identified for manual state repair or QA rerun; the implementation must not silently mark QA or acceptance approvals as approved | A read-only identification run listing every task in `acceptance` whose type requires `qa_agent` without an approved grant. Assert in the test suite that the repair path writes **no** approval rows: a test that runs the reconciliation and then asserts the approval set is byte-identical to the pre-reconciliation set. The identified list is published as a task comment and in the PR body. | Integration (read-only) + manual review | `services/tasks-api/test/statusTransition.integration.test.ts` (new) + PR body artefact |

### Notes on E2E coverage

There is **no E2E test for this change, and none is planned** — deliberately. The behaviour under test is an API-boundary invariant (a status write is rejected unless an approval exists), not a user-visible app flow. The Tasks UI has no screen that a person uses to promote a task past QA; the transition is driven by workflow automation and API clients. A Playwright test would be a slower, flakier restatement of the integration test, with no additional coverage of the rule. The fallback layer is the integration test against the real Postgres database (`services/tasks-api/test/db-integration.test.ts` is the existing precedent for real-DB assertions in this service), plus the Rust unit tests for the Lobster side.

For AC5 the verification is partly human: the repair decisions belong to Ash and an authorised operator, and this implementation's obligation is to identify and publish, not to decide.

## `.openclaw` boundary notes

- **`.openclaw/tasks-api/required-approvals.yaml`** is the policy file the API reads at startup. WS1 reads it through the existing `loadRequiredApprovalsConfig()` loader — **no change to the file, and no change to the file's location**. The loader already falls back to built-in defaults if the file is missing or malformed, so the enforcement cannot be broken by an absent file; it degrades to the default mapping (`code` and `feature` require `qa_agent`).
- **No writes to `~/.openclaw/` are required.** The change needs no new config, no new credential, no scheduler change, and no OpenClaw-level routing change. If WS3's identification output is delivered as an operator-facing artefact, it is written to the repo (docs) or posted as a task comment — both inside existing boundaries.
- The `qa_agent` approval remains owned by Ash and is granted through the existing attested `POST /tasks/:id/approvals` path. This task adds no path for anyone to grant QA approval, and deliberately leaves that surface unchanged.

## Open questions and risks

**Open questions**

1. **Should `acceptance → done` be enforced in the same change?** AC4 asks for coverage of "the existing acceptance-to-done path", which could mean "cover it with tests" or "enforce it too". The Lobster already gates it (`accepted_structured`, `task_approvals.rs:73`). The design assumes **enforce it too**, because leaving a sibling transition unenforced recreates the same class of defect one status later. *Fallback if Quinn prefers a narrower change:* drop that rule, keep the test as a regression guard, and file it as a follow-up.
2. **Which HTTP status code?** The design chooses 409 Conflict for a legal-but-blocked transition. If the house convention is 400 for all task-mutation rejections, this becomes 400 — but 409 is the more accurate code and matches `TASK_IMMUTABLE`.
3. **Where does the WS3 identification query live?** A read-only endpoint on the Tasks API, or a maintenance script in `agents/` that queries it. A script is the smaller surface; an endpoint is more reusable. *Recommendation:* script, because the query is a one-time audit, not a product surface. **Rowan will confirm with Quinn before implementing.**

**Risks**

1. **Workflow deadlock.** Enforcing `doing → acceptance` on `qa_agent` means a task cannot advance until Ash acts. If Ash's heartbeat is unhealthy, tasks stall in `doing` rather than silently skipping QA. **This is the intended trade** — a visible stall beats a silent gate skip — but it makes Ash's heartbeat health a dependency of task throughput. *Mitigation:* the existing `qa_agent` block already reports a clear, actionable failure; no new mechanism is needed, but the stall should be visible in the operator queue rather than buried.
2. **Content and research tasks.** They have no `qa_agent` requirement, so they are unaffected — **provided** the rule is derived from the config rather than hardcoded. A hardcoded rule would wrongly block them. This is the specific reason for design decision "derive from config".
3. **Divergence between the API's and the Lobster's predicate.** The API checks `state === 'approved' && revokedAt === null`; the Lobster additionally excludes deferred and blocked markers. The API is the floor, the Lobster is stricter. Documented above; it is safe in the direction that matters but should not be described as "the same rule" in future docs.
4. **Tasks already in `acceptance` with pending QA.** WS2 makes these detectable, but it does not repair them, and repair needs a human decision. Until those three tasks are resolved, the queue keeps classifying them as `WAITING_EXTERNAL` and they remain visible — which is the correct end state, not a silent pass.
5. **Rust crate quality gates.** WS2 touches `agents/workflows/feature-task/**` and therefore must satisfy `cargo fmt`, `cargo clippy -- -D warnings`, and `cargo test` locally *and* in CI before the PR is ready for review. Any new `failureFingerprint` string is a behavioural surface other code may match on — a grep for the new fingerprint value across the repo is required before merging.

## Out of scope

Restated for the PR body, which must **not** carry the AC checklist:

- Rewriting the Lobster's happy-path gate ordering.
- Changing the `qa_agent` grant endpoint's attestation rules.
- Granting, revoking, or synthesising any `qa_agent` or `accepted` approval, including for the three known-affected tasks.
- The actual state repair of the affected tasks — that is an authorised human/agent action, separate from this implementation.
- Changing `content` / `research` task-type behaviour.
