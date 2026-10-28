---
status: draft
task_id: 1e8a430a-01a9-460f-8fe9-9e8470f962a6
product_spec: "n/a"
shipped_pr: null
shipped_date: null
---

# Ignore stale QA blocked markers after a fresh `qa_agent` approval

## Product intent

The attention-owner sweep keeps routing a completed delivery back to the
delivery assignee (Rowan) after Ash has re-approved the same PR with a fresh
attestation. Two live tasks were stuck in a Rowan ↔ Ash attention oscillation
for roughly an hour on 2026-10-28:

- `de9d8594` — "Contain rejected promises across Budget API handlers" (PR #800)
- `0a803329` — "Preserve arbitrary Budget category keys in timeseries aggregation" (PR #818)

On both tasks the lobster revoked the `qa_agent` approval at ~03:54Z because
the approval attestation no longer matched the live PR head, posted a
`[qa-agent-blocked]` marker, and re-routed Rowan. Ash then re-verified the
*unchanged* PR heads and re-granted `qa_agent` with fresh attestations
(`de9d8594` at 05:03:03Z, `0a803329` at 05:05:44Z). The sweep kept selecting
Rowan anyway, because the blocked marker (03:54Z) was still newer than the
original delivery marker (2026-10-12).

The defect is not in the approval itself — it is that the routing predicate
that decides "is there a current QA blocker?" uses a **different** staleness
rule from the predicate that decides "is QA verified?".

## Task, branch, worktree, repositories

| Item | Value |
| --- | --- |
| Task | `1e8a430a-01a9-460f-8fe9-9e8470f962a6` — "Ignore stale QA blocked markers after a fresh qa_agent approval" |
| Task type | `code` (no product spec required; the task description is the product intent) |
| Branch | `task-1e8a430a-ignore-stale-qa-blocked-markers` (from `origin/main`) |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-1e8a430a-ignore-stale-qa-blocked-markers` |
| Repository | `Stoffer-Industries/sindustries` (canonical checkout stays on clean `main`) |
| Component | `agents/workflows/feature-task/**` — the Rust feature-task lobster crate |
| Live consumers | `agents/workflows/feature-task/code-task.lobster.yaml`, `feature-task.lobster.yaml` (lobster cron) |

## Source of truth and ownership boundary

**Natural source of truth: the workflow/lobster boundary — specifically the
Rust feature-task crate.** The question "whose attention does this task need
next?" is workflow state, owned by exactly one module:
`agents/workflows/feature-task/src/spec_check_ready.rs` (`workflow_attention_owner`
→ `reconciled_attention_owners`). The ordering of QA markers is a second
workflow rule owned by `agents/workflows/feature-task/src/task_approvals.rs`.

What is *not* the source of truth here:

- **The Tasks API** (`services/tasks-api`) owns the task domain and the
  structured `TaskApproval` rows (the `qa_agent` attestation of record). It
  does **not** decide the attention order. Its
  `services/tasks-api/src/routes/tasks/_deliveryEvidence.ts` rule is a
  different plane — it decides whether the `qa_agent` *gate* is dormant, not
  who owns attention.
- **The UI** (`apps/tasks`) renders `attentionOwners` / `workflowGates`; it
  never derives routing.

Mirroring this rule into the API would create exactly the second source of
truth that AC5 forbids. This change therefore stays inside the crate that owns
the rule, and the API contract is untouched.

**Data ownership:** no new columns, no new tables, no new comment tags, no new
approval types. The only persisted artefacts are the existing
`TaskApproval` rows and the existing attention-owner rows, written through the
existing reason-bearing endpoint (`POST /tasks/:id/attention-owners/reconcile`).

## Current behaviour — code map

### `agents/workflows/feature-task/src/task_approvals.rs`

`latest_qa_verdict` (≈ line 94) is **approval-aware**. It computes
`latest_approval_at` = max `approved_at` over approved `qa_agent` rows and
then ignores any verdict comment whose `created_at` is `<= approval_at` (and
ignores undated comments entirely once an attestation timestamp exists):

```rust
if comment.created_at.as_deref()
    .is_none_or(|created_at| created_at <= approval_at)
{
    return None;
}
```

`qa_agent_blocked_after_latest_delivery` (≈ line 207) is **not**
approval-aware. It compares the index of the newest `[qa-agent-blocked]`
comment with the index of the newest `[implementer-prs]` / `[rowan-prs]`
comment and stops there:

```rust
matches!(latest_blocked_comment, Some(blocked)
    if latest_delivery_comment.is_none_or(|delivery| blocked > delivery))
```

The approval attestation never enters that comparison.

### `agents/workflows/feature-task/src/spec_check_ready.rs`

`workflow_attention_owner` (line 434) resolves the attention head. Two of its
`doing` arms can select the delivery assignee:

| Arm | Line | Condition today | Value |
| --- | --- | --- | --- |
| blocked | 467 | `qa_agent_blocked_after_latest_delivery` | `task.assignee.clone()` |
| verified | 484 | `qa_agent_verified` | `task.assignee.clone()` |

Because the blocked arm is evaluated first and its predicate ignores the
attestation, a stale blocked marker keeps the "evidence is outstanding" story
alive. The persisted note makes that visible: `workflow_attention_reason`
(line 690) writes, for the assignee, *"The delivery owner must address the
outstanding workflow evidence before QA can act."* — which is false once QA
has approved.

`reconciled_attention_owners` (line 624) then writes the resulting stack. When
the desired head is the assignee and the current head is someone else (e.g.
`Tom`), it **inserts** the assignee at position 0 — this is the "re-add
Rowan on every sweep" symptom.

### Why the fix has to touch the verified arm too

With only AC1 applied, the blocked arm stops matching and the chain falls
through to the *verified* arm — which today also returns the assignee. The
selected owner would therefore be unchanged and the re-add symptom would
persist (AC6 would remain unsatisfiable). The verified path must resolve to
"no explicit attention row" for the sweep to stop re-adding Rowan. See
**Decision D2** below.

## Design

### D1 — One approval-aware ordering rule (AC5)

Introduce the ordering primitives once, in `task_approvals.rs`, and use them
from both predicates:

```rust
/// Max `approved_at` over approved `qa_agent` rows.
fn latest_approved_qa_agent_at(task: &Task) -> Option<&str>;

/// A comment that carries a QA marker, with its position and timestamp.
struct QaMarker { index: usize, created_at: Option<String> }

/// Newest comment whose text carries `tag` at the start of a line.
fn latest_qa_marker(task: &Task, tag: &str) -> Option<QaMarker>;

/// Is `candidate` newer than `reference`?
fn marker_is_newer(candidate: &QaMarker, reference: &QaMarker) -> bool;

/// Is `candidate` newer than the current attestation?
fn marker_is_newer_than_attestation(candidate: &QaMarker, attestation_at: &str) -> bool;
```

The rules, in order of precedence:

- **R1 — timestamp first.** When both markers carry `created_at`, order them
  by parsed instant (falling back to the raw string when one side does not
  parse). The Tasks API normalises `createdAt` to UTC RFC-3339, so the
  normalised representation sorts chronologically; parsing is a robustness
  measure against a non-UTC offset, not the primary mechanism.
- **R2 — index fallback.** When either side lacks a timestamp, fall back to
  list index. This preserves today's behaviour for legacy undated comments.
- **R3 — attestation dominance.** A blocked marker is *current* only if it is
  newer than the latest approved `qa_agent` attestation. A marker without a
  timestamp cannot be shown to be newer than a timestamped attestation, so it
  is treated as stale. This is exactly the parity `latest_qa_verdict`
  already implements (it drops undated comments once an attestation exists),
  and it is why AC5 asks for one rule rather than two.
- **R4 — no attestation, no change.** If there is no approved attestation
  timestamp, the blocked marker is evaluated exactly as today (delivery
  comparison only). The fix never weakens the blocked route for a task that
  has not been approved.

`latest_qa_verdict` is refactored to call `latest_approved_qa_agent_at` and
the shared marker helpers; its observable behaviour does not change.

### D2 — The rewritten predicate (AC1, AC2, AC3)

```rust
pub(crate) fn qa_agent_blocked_after_latest_delivery(task: &Task) -> bool {
    let Some(blocked) = latest_qa_marker(task, "[qa-agent-blocked]") else {
        return false;
    };
    // AC3: a replacement delivery marker newer than the block makes it stale.
    if let Some(delivery) = latest_delivery_marker(task) {
        if !marker_is_newer(&blocked, &delivery) {
            return false;
        }
    }
    // AC1: a block that predates the current attestation is stale.
    if let Some(attestation_at) = latest_approved_qa_agent_at(task) {
        if !marker_is_newer_than_attestation(&blocked, attestation_at) {
            return false;
        }
    }
    true
}
```

- **AC1** — blocked (03:54:44.518Z) predates the attestation (05:03:03.520Z)
  → `false`.
- **AC2** — blocked newer than both the delivery marker and the attestation →
  `true`, so the task still routes to the delivery assignee.
- **AC3** — a replacement `[implementer-prs]` / `[rowan-prs]` marker newer than
  the blocked comment → `false`, preserving today's behaviour.

### D3 — The verified path stops paging the assignee (AC4, AC6)

**Decision D2 (the one behavioural change beyond the literal AC wording):**
the `qa_agent_verified` arm in `workflow_attention_owner` returns `None`
instead of `task.assignee.clone()`.

Rationale:

1. `docs/systems/tasks.md` ("Task ownership planes") is explicit: *"Explicit
   rows are reserved for genuine blockers and cross-role handoffs"* and *"A
   delivery checklist is ordinary assignee work, not an escalation: it must not
   create an explicit assignee attention row merely to expose the work in the
   queue."* A QA-verified task has no outstanding blocker to escalate.
2. The same match already applies this rule to the delivery-checklist arm
   (line 450), whose comment reads: *"Keep Ash dormant without turning the
   checklist into an explicit attention-owner escalation; the assignee queue
   already makes this task actionable."* The verified arm is the same shape.
3. Work is not lost: `agent_task_queue.py` surfaces every active task whose
   `assignee` is the agent, independently of the attention stack. The
   remaining job on a QA-verified `doing` task is ordinary delivery work —
   drive the `doing → acceptance` transition — not an escalation.

Consequence for the live incidents: once the stale blocked marker is ignored,
the sweep resolves to *no explicit attention row* instead of re-inserting
`Rowan` on top of `Tom` with a note that claims the evidence is outstanding.
A stale Rowan row previously written by the blocked arm is removed by the
existing `automated_delivery_checklist_slot` guard (line 685), which only
removes a head row whose note is exactly the workflow-generated reason — so
genuine human escalations are preserved.

Rollback is a one-function revert (restore `task.assignee.clone()`); there is
no data migration.

### D4 — The full precedence chain after the change

For a `doing` task with implementation PRs, `workflow_attention_owner` now
resolves as follows:

| # | Condition | Result | Source |
| --- | --- | --- | --- |
| 1 | `qa_agent_deferred` and not waiting on a capability extension | `Quinn` | line 442 |
| 2 | latest Lobster delivery state carries a failure fingerprint | `None` (ordinary assignee work) | line 450 |
| 3 | deferred capability extension complete | `Ash` | line 461 |
| 4 | **current** blocked marker (newer than delivery **and** attestation) | **assignee** | line 467 |
| 5 | QA not verified and Ash was not the last commenter | `Ash` | line 476 |
| 6 | **QA verified** (fresh attestation, no current block) | **`None`** (verified path) | line 484 |

The only arms whose behaviour changes are 4 and 6: arm 4 no longer fires for a
block that predates the attestation, and arm 6 no longer pages the assignee.

## Data model and API contract changes

None.

- No Prisma schema change, no migration.
- No new comment tags. The markers read (`[qa-agent-blocked]`,
  `[implementer-prs]`, `[rowan-prs]`) are unchanged.
- No new `TaskApproval` type. The structured `qa_agent` row remains the sole
  attestation of record.
- No Tasks API route change. The reconciled stack is written through the
  existing reason-bearing `POST /tasks/:id/attention-owners/reconcile`, with
  the actor credential and note semantics unchanged.

## Workflow, cron, and skill changes

- **Crate:** `agents/workflows/feature-task/**` only. The change ships through
  the existing lobster cron (`code-task.lobster.yaml` /
  `feature-task.lobster.yaml`); no new or changed schedule.
- **System doc:** `docs/systems/tasks.md` — the "QA capability-deferral
  lifecycle" section gains one paragraph stating that a blocked marker which
  predates the current approved `qa_agent` attestation is stale for routing,
  and that a QA-verified `doing` task holds no explicit attention row. Updated
  in the same PR as the code.
- **`.openclaw` boundary:** no changes required outside this repo. The
  attention-owner routing skill (`agents/skills/ops/attention-owner-routing/`)
  documents the *agent-facing* reconcile procedure and is unaffected — the
  rule changed here is lobster-internal and observable only through the stack
  it writes. Explicitly out of scope, with reason.
- **Skill/cron changes:** none.

## Implementation plan — file and module scope

1. `agents/workflows/feature-task/src/task_approvals.rs`
   - Add `QaMarker`, `latest_approved_qa_agent_at`, `latest_qa_marker`,
     `latest_delivery_marker`, `marker_is_newer`,
     `marker_is_newer_than_attestation`.
   - Refactor `latest_qa_verdict` onto the shared helpers (behaviour
     preserved).
   - Rewrite `qa_agent_blocked_after_latest_delivery` per D2.
   - Add unit tests for D1/D2 and a differential test that both predicates
     agree on the shared fixture corpus (AC5).
2. `agents/workflows/feature-task/src/spec_check_ready.rs`
   - Change the verified arm (line 484) to `None`, with a comment citing
     `docs/systems/tasks.md`.
   - Add routing regression tests in the existing `mod tests` (AC4).
3. `agents/workflows/feature-task/fixtures/qa_routing/`
   - Two JSON fixtures derived from the live task payloads of `de9d8594` and
     `0a803329`, reduced to the fields the predicates read (`status`,
     `assignee`, `comments[]` with `author`/`text`/`createdAt`,
     `approvals[]` with `approvalType`/`state`/`approvedAt`). No task titles,
     no PR URLs, no personal data.
4. `docs/systems/tasks.md` — update the QA marker lifecycle section.
5. `docs/specs/ignore-stale-qa-blocked-markers-tech-design.md` — frontmatter
   to `status: shipped` with `shipped_pr` / `shipped_date` in the same PR.

### Clarification gate

"No clarification needed because" — the task description is the product
intent, the affected code is identified (two predicates in one crate, one
call site each), and the two live incident tasks were inspected directly to
confirm the data shape. Two open questions are still raised below for Quinn's
review at the tech-design gate; both have a stated default so implementation
can proceed once the design is approved.

## Test plan — acceptance-criterion verification matrix

No user-visible app behaviour changes: this alters workflow routing inside the
lobster crate. There is no app surface and no E2E layer to extend, so the
fallback layers are the crate's Rust unit tests, fixture-driven routing tests,
and a live API sweep. That fallback is proportionate — the observable
behaviour is an attention-stack write, which the live sweep exercises
directly.

| AC | Verification | Layer | Test / evidence |
| --- | --- | --- | --- |
| AC1 | Blocked marker predating the current attestation is stale | unit | `blocked_marker_predating_current_attestation_is_stale` — blocked `2026-10-28T03:54:44.518Z`, attestation `2026-10-28T05:03:03.520Z` → `qa_agent_blocked_after_latest_delivery` is `false` |
| AC2 | Block newer than delivery **and** attestation still routes to the assignee | unit | `blocked_marker_newer_than_delivery_and_attestation_is_current` → predicate `true`; routing test asserts `workflow_attention_owner` selects the assignee |
| AC3 | Replacement delivery marker newer than the block makes it stale | unit | `replacement_delivery_marker_makes_block_stale` — delivery `04:00Z` > blocked `03:54Z` → predicate `false` |
| AC4 | Full routing precedence chain | unit (routing) | `stale_blocked_marker_with_fresh_approval_selects_verified_path` (asserts `None`, and `reconciled_attention_owners` contains no `Rowan`) and `current_blocked_marker_selects_delivery_assignee` (asserts `Some("Rowan")`); both driven by the live-shaped fixtures |
| AC5 | One ordering rule, not two divergent rules | unit (differential) | `both_qa_predicates_share_one_ordering_rule` — over the shared fixture corpus, `latest_qa_verdict` and `qa_agent_blocked_after_latest_delivery` are derived from the same primitives and agree on every case; the test fails if either predicate is reimplemented with its own comparison |
| AC6 | Real sweep does not re-add Rowan while fresh approvals stand | live integration + unit | Unit: fixture replay of both live tasks asserts the reconciled stack contains no `Rowan`. Live: after merge, run the lobster `verify-delivery` stage (dry-run first, then live) against `de9d8594` and `0a803329` on `http://localhost:4001/api/v1` and capture the resulting `attention_owners` + task status as task-comment evidence |

### Commands

```bash
# Crate gates (must be green locally before review; CI runs the same two).
cargo test --manifest-path agents/workflows/feature-task/Cargo.toml
cargo clippy \
  --manifest-path agents/workflows/feature-task/Cargo.toml \
  --all-targets \
  -- -D warnings
```

Live verification (AC6), from the implementation worktree:

```bash
# Dry run first: inspect the resolved attention stack without writing.
cargo run --manifest-path agents/workflows/feature-task/Cargo.toml -- \
  verify-delivery --base-url http://localhost:4001/api/v1 --dry-run

# Then the live run, and read the stack back.
python3 agents/skills/ops/tasks-api/tasks_api_client.py get \
  --id de9d8594-4825-40f5-bfb3-30ac31cc50e7
python3 agents/skills/ops/tasks-api/tasks_api_client.py get \
  --id 0a803329-5666-4dc9-90bc-fd046a730824
```

### E2E coverage note

The changed behaviour has no app surface: the observable output is the
`attentionOwners` stack written by the lobster and read by `apps/tasks`. The
app-level equivalent is a board card showing a Rowan avatar layer; it is a
direct rendering of the stack, so the stack-level fixture and live sweep
tests cover it without an app E2E case. Recorded here as the reason no app
E2E test is planned.

## Open questions and risks

### Open questions for Quinn (tech-design gate)

- **Q1 — D3 (verified path resolves to no explicit row).** AC6 requires that a
  real sweep does not re-add Rowan while a fresh `qa_agent` approval stands.
  With AC1 alone, the verified arm still selects the assignee, so the sweep
  still writes a Rowan row (with a note that falsely claims the evidence is
  outstanding). D3 changes that arm to `None`, matching the documented
  "explicit rows are reserved for genuine blockers" rule and the existing
  delivery-checklist precedent in the same match. **Default: implement D3 as
  written.** If Quinn prefers the assignee to stay explicitly paged while QA
  is verified, AC6 needs restating — the sweep will keep selecting Rowan by
  design, and the fix would be limited to the stale-blocker predicate alone.
- **Q2 — undated blocked comments (R3).** Today an undated comment cannot
  invalidate a timestamped attestation (`latest_qa_verdict` already drops
  undated comments). The unified rule keeps that parity. The alternative —
  treating an undated marker as newest — would re-open the stale-routing bug
  for any comment that lost its timestamp. **Default: keep R3.**

### Risks

- **R-1 — blast radius of D3.** Every QA-verified `doing` task changes from
  "assignee explicitly paged" to "no explicit row". This affects the attention
  stack of all such tasks, not just the two incidents. Mitigation:
  `reconciled_attention_owners` removes only head rows whose note is exactly
  the workflow-generated reason (`automated_delivery_checklist_slot`), so
  genuine human escalations and their notes are preserved. The crate's
  existing routing tests are the regression net for the rest.
- **R-2 — timestamp trust.** Ordering depends on `created_at` being a
  normalised UTC RFC-3339 string. If a comment ever carried a non-UTC offset,
  lexical comparison could mis-order. Mitigation: parse to an instant when
  both sides parse, and fall back to list index (R2) otherwise. A follow-up
  could normalise at the API boundary; not required here.
- **R-3 — two live tasks stay in `doing`.** `de9d8594` and `0a803329` have
  merged PRs and fresh attestations but are still `doing` with `Tom@0`. This
  change makes the sweep stop re-routing Rowan; whether each task then
  promotes to `acceptance` depends on the Lobster's delivery-evidence check,
  which is a separate concern and is not changed here. If AC6's live run shows
  the tasks still blocked, that is a separate finding to record on the task,
  not a regression of this fix.
- **R-4 — the fix does not resurrect a revoked approval.** `qa_agent` rows that
  are `revoked` or `pending` are not an attestation (R4), so a blocked marker
  stays current and the task still routes to the assignee. No safety property
  of the QA gate is weakened.

### Out of scope

- `services/tasks-api/src/routes/tasks/_deliveryEvidence.ts` — the gate
  *dormancy* rule in the API. Different plane, different consumers; changing
  it here would create the second source of truth AC5 forbids.
- The `accepted` approval on `de9d8594` / `0a803329` — Tom's acceptance gate
  and Quinn's escalation, not this PR.
- The `agents/skills/ops/attention-owner-routing/` skill and the workspace
  repo — the changed rule is lobster-internal and the agent-facing reconcile
  contract is unchanged.
- Any change to how Ash issues attestations, or to `qaEvidenceAttestation.ts`
  in the API.
