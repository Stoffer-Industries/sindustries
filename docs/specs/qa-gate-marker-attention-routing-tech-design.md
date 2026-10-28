---
status: draft
task_id: dbce028f-0287-4556-82a1-c405339f1d42
product_spec: n/a (internal workflow routing)
shipped_pr: null
shipped_date: null
---

# Distinguish the lobster's generic QA-gate marker from an evidence verdict in attention routing

## Product intent

The feature-task workflow routes a task to whoever must act next. It has two
different kinds of `[qa-agent-blocked]` marker and it cannot tell them apart:

- **A QA-gate prompt.** The lobster's own service account posts this when the
  `qa_agent` approval has not been granted yet. Its text is the f6a4d56a AC1
  fingerprint: *"Structured `qa_agent` approval is missing or not approved;
  Ash must run mechanical verification (cited tests pass, cited files exist,
  evidence matches the diff) before this task reaches Tom's acceptance."*
  The actor it names is **Ash**, and it says nothing about the delivery.
- **An evidence verdict.** Ash posts this after mechanically verifying the
  delivery and finding a specific AC unsupported. It names the ACs and what is
  wrong with them. The actor it names is the **delivery owner** (Rowan).

`qa_agent_blocked_after_latest_delivery` (`agents/workflows/feature-task/src/task_approvals.rs`)
matches on the tag alone, so it counts a QA-gate prompt as a current
delivery-evidence block and selects the delivery assignee. The observable
consequence is a false attention row and a routing loop:

Live on task `2c782afb` (2026-10-28): PR #797 merged 2026-10-11 (AC1–AC3),
PR #801 merged 2026-10-22 (AC4–AC5), AC1–AC5 all checked, the lobster's own
AC gate re-running with 0 failures, and the only open gate the `qa_agent`
approval for Ash. Quinn added `Rowan` at position 0 at 08:53Z and again at
10:53Z with the note *"The delivery owner must address the outstanding workflow
evidence before QA can act."* — while the lobster's own fingerprint in the same
task said the outstanding item was Ash's QA. A live dry-run sweep of the
merged code (`a78ecc6`, PR #897) still resolves `attentionOwners=["Rowan"]`,
so the row re-appears on the next sweep regardless of what the delivery owner
does.

This is the sibling of the defect fixed by PR #897 (`1e8a430a`), but a
different shape. PR #897 fixed the **stale** case — a block that predates a
fresh `qa_agent` attestation. Here the block is genuinely *current* (no
attestation has ever been issued) and the predicate still selects the wrong
owner.

## Task, branch, worktree, repositories

| Item | Value |
| --- | --- |
| Task | `dbce028f-0287-4556-82a1-c405339f1d42` — "Distinguish the lobster's generic QA-gate blocked marker from an evidence verdict in attention routing" |
| Task type | `code` (no product spec required; the task description is the product intent) |
| Branch | `task-dbce028f-qa-gate-marker-routing` (from `origin/main`) |
| Worktree | `/Volumes/WD1/worktrees/quinn/task-dbce028f-qa-gate-marker-routing` |
| Repository | `Stoffer-Industries/sindustries` (canonical checkout stays on clean `main`) |
| Component | `agents/workflows/feature-task/**` — the Rust feature-task lobster crate |
| Live consumers | `agents/workflows/feature-task/code-task.lobster.yaml`, `feature-task.lobster.yaml` (lobster cron) |
| Live task under repair | `2c782afb` — "Hosted observability follow-ups" |

## Source of truth and ownership boundary

**Natural source of truth: the workflow/lobster boundary — specifically the
Rust feature-task crate.** "Whose attention does this task need next?" and
"what kind of QA marker is this?" are workflow state, owned by exactly one
module: `agents/workflows/feature-task/src/task_approvals.rs` (marker
semantics) feeding `agents/workflows/feature-task/src/spec_check_ready.rs`
(`workflow_attention_owner` → `reconciled_attention_owners`).

What is *not* the source of truth:

- **The Tasks API** (`services/tasks-api`) owns the task domain and the
  structured `TaskApproval` rows (the `qa_agent` attestation of record). Its
  `services/tasks-api/src/routes/tasks/_deliveryEvidence.ts` rule decides
  whether the `qa_agent` *gate* is dormant — not who owns attention, and not
  what a comment means.
- **The UI** (`apps/tasks`) renders `attentionOwners` / `workflowGates`; it
  never derives routing.
- **The agent skills** (`agents/skills/ops/attention-owner-routing/`,
  `agents/skills/ops/tasks-api/`) document the agent-facing procedure. They
  describe how a *human/agent* reads a task and routes it; they are not the
  rule the lobster applies.

Mirroring this rule into the API would create exactly the second source of
truth that AC3 forbids. This change therefore stays inside the crate that owns
the rule; the API contract is untouched.

**Data ownership:** no new columns, no new tables, no new comment tags, no new
approval types. The only persisted artefacts are the existing `TaskApproval`
rows and the existing attention-owner rows, written through the existing
reason-bearing endpoint (`POST /tasks/:id/attention-owners/reconcile`).

## Current behaviour — code map

All line references are `agents/workflows/feature-task/**` at `a78ecc6`.

### `src/task_approvals.rs`

- `QaMarker` (line 113) carries `index`, `created_at` and the comment text.
- `latest_qa_marker(task, tag)` (line 291) finds the newest comment whose
  text carries `tag` at the start of a line. It matches on the **tag only** —
  the comment's author and body are not consulted.
- `qa_agent_blocked_after_latest_delivery` (line 487) is the predicate used by
  the routing arm. It returns true when the newest `[qa-agent-blocked]` marker
  is newer than the newest delivery marker and newer than the current
  attestation (PR #897's ordering rule). It has no notion of *who* wrote the
  marker.
- `qa_agent_verified` (line 100) and `latest_qa_verdict` (line 320) already
  model the approval-aware side of the same question.

### `src/spec_check_ready.rs`

`workflow_attention_owner` (line 434) resolves the attention head. The `doing`
arms that matter here:

| # | Condition (line) | Result today |
| --- | --- | --- |
| 1 | `qa_agent_deferred` and not waiting on a capability extension (442) | `Quinn` |
| 2 | latest Lobster delivery state carries a delivery-failure fingerprint (449) | `None` (ordinary assignee work) |
| 3 | deferred capability extension complete (461) | `Ash` |
| 4 | **`qa_agent_blocked_after_latest_delivery` (467)** | **assignee** |
| 5 | QA not verified and Ash was not the last commenter (476) | `Ash` |
| 6 | QA verified (484, PR #897) | `None` |

`latest_lobster_delivery_failure` (line 518) already knows the difference
between the two marker kinds — but only to decide whether the *delivery* gate
failed. It scans the comments at or before the latest `[lobster-state]` and
returns `false` when the newest marker is `[qa-agent-blocked]` or
`[qa-agent-deferred]` (a QA-gate signal) and `true` when it is a
`[feature-task-progress-checklist]` / `[code-task-progress-checklist]` /
`[feature-task-blocked]` / `[code-task-blocked]` marker (a delivery signal).

**That distinction is the fix.** The delivery-evidence signal is carried by the
progress checklist, not by the QA-gate marker. Arm 2 already returns `None`
for a delivery checklist (ordinary assignee work, surfaced through the
assignee queue), so ignoring a QA-gate prompt in arm 4 loses no delivery
signal — it only stops the QA-gate prompt from impersonating one.

On `2c782afb` today: arm 2 does not fire (the newest marker before the state
is the lobster's `[qa-agent-blocked]`), arm 4 fires (the generic prompt is
newer than the delivery marker and no attestation exists), so the head is
`Rowan`. With the fix, arm 4 no longer fires and arm 5 selects `Ash` — the
actor the marker itself names.

### Why not fix this in the agent-facing routing instead

An agent can repair its own stack (this pass did exactly that: reason-bearing
reconcile `Rowan` → `Ash` on `2c782afb`). But the sweep re-adds the row on its
next run, so a manual repair is a loop, not a fix. The rule has to change
where the rule lives.

## Design

### D1 — Classify the marker before ordering it (AC1, AC2, AC3)

Add a *kind* to the existing marker primitive. This is not a second ordering
rule — PR #897's ordering rule (timestamp, then index, then attestation
dominance) is reused unchanged.

```rust
/// What a `[qa-agent-blocked]` comment asserts.
enum QaBlockKind {
    /// The lobster's generic QA-gate prompt: the `qa_agent` approval has not
    /// been granted. It names Ash as the actor and says nothing about the
    /// delivery.
    QaGatePrompt,
    /// A verifier's per-AC blocked verdict: the delivery evidence itself is
    /// unsupported. The delivery owner must act.
    EvidenceVerdict,
}
```

Classification inputs, all already present in the task payload:

- **Author (primary).** A marker authored by the QA verifier (`Ash`,
  case-insensitive — the same comparison `ash_was_last_commenter` already
  performs at `spec_check_ready.rs:506`) is an `EvidenceVerdict`. A marker
  authored by the lobster service account (`feature_task_lobster`) is a
  `QaGatePrompt`.
- **Structured state (secondary, for robustness).** If the task has **no**
  approved `qa_agent` row at all, the QA gate is open and any blocked marker
  is a gate prompt rather than a verdict about a delivered AC set. This
  secondary rule is what makes the classification independent of the service
  account's author string: if that string ever changes, the primary rule
  stops matching, but the secondary rule still classifies the marker as a
  gate prompt because no attestation exists.

**Fail-closed rule:** a marker whose kind cannot be determined (unknown
author, an approval row in a state other than `pending`/`approved`) is
treated as an `EvidenceVerdict`, preserving today's routing for every shape
we have not explicitly classified. The change therefore can only *remove* a
false routing, never create a new one.

### D2 — Arm 4 counts evidence verdicts only (AC1, AC2)

```rust
"doing"
    if !product_spec_parsing::implementer_pr_urls(task).is_empty()
        && task_approvals::qa_agent_blocked_after_latest_delivery(task) =>
{
    task.assignee.clone()
}
```

`qa_agent_blocked_after_latest_delivery` changes to require the newest
`[qa-agent-blocked]` marker to be an `EvidenceVerdict`. A `QaGatePrompt` is
not a delivery block, so arm 4 does not fire for it.

Consequence on `2c782afb`: arm 4 is skipped, arm 5 fires (QA not verified,
not deferred, Ash was not the last commenter) and the head becomes `Ash` —
the actor the generic marker itself names. On a task where Ash posted a real
per-AC blocked verdict, arm 4 still fires and the head remains the delivery
owner.

### D3 — The reason must name the actor, not the template (AC5)

`workflow_attention_reason` (`spec_check_ready.rs:698`) currently emits the
boilerplate "The delivery owner must address the outstanding workflow evidence
before QA can act." for the assignee. With D1/D2 the assignee is only selected
for a genuine evidence verdict, so the boilerplate becomes true whenever it is
written. `docs/systems/tasks.md` gains a paragraph stating:

- a QA-gate marker is a gate prompt, not a delivery-evidence block;
- a delivery-complete task with a pending `qa_agent` approval is owned by the
  QA gate owner (Ash), not by the delivery assignee;
- a verifier's evidence verdict is owned by the delivery assignee.

## Data model and API contract changes

None.

- No Prisma schema change, no migration.
- No new comment tags. The markers read (`[qa-agent-blocked]`,
  `[implementer-prs]`, `[rowan-prs]`) are unchanged.
- No new `TaskApproval` type. The structured `qa_agent` row remains the sole
  attestation of record.
- No Tasks API route change. The reconciled stack is written through the
  existing reason-bearing `POST /tasks/:id/attention-owners/reconcile`.

## Workflow, cron, and skill changes

- **Crate:** `agents/workflows/feature-task/**` only. The change ships through
  the existing lobster cron (`code-task.lobster.yaml` /
  `feature-task.lobster.yaml`); no new or changed schedule.
- **System doc:** `docs/systems/tasks.md` — the QA marker lifecycle section
  gains the rule from D3. Updated in the same PR as the code.
- **Fixtures:** `agents/workflows/feature-task/fixtures/qa_routing/` gains one
  reduced, live-shaped fixture for `2c782afb` (no titles, no PR URLs, no
  personal data) plus a synthetic paired fixture that holds the same task with
  an Ash evidence verdict instead of the lobster prompt, so both arms are
  driven by comparable payloads.
- **`.openclaw` boundary:** no changes required outside this repo. The
  attention-owner routing skill documents the agent-facing reconcile procedure
  and is unaffected — the rule changed here is lobster-internal and observable
  only through the stack it writes. Explicitly out of scope, with reason.
- **Skill/cron changes:** none.

## Implementation plan — file/module scope

1. `agents/workflows/feature-task/src/task_approvals.rs`
   - Add `QaBlockKind` and `classify_qa_block(task, marker) -> QaBlockKind`.
   - Extend `QaMarker` (or wrap it) so the classification is carried with the
     marker rather than re-derived by each caller.
   - Change `qa_agent_blocked_after_latest_delivery` to require an
     `EvidenceVerdict`.
   - Add unit tests for each classification input and for the fail-closed
     default.
2. `agents/workflows/feature-task/src/spec_check_ready.rs`
   - No change to the arm order or to `workflow_attention_owner` (D2 is
     expressed entirely in the predicate). Add a routing regression test
     asserting the `doing` arm for a `QaGatePrompt` resolves to `Ash` and for
     an `EvidenceVerdict` resolves to the assignee.
   - Update the `workflow_attention_reason` comment block to cite the new rule.
3. `agents/workflows/feature-task/fixtures/qa_routing/`
   - Add `2c782afb-qa-gate-prompt.json` and
     `2c782afb-evidence-verdict.json`.
4. `docs/systems/tasks.md` — add the D3 rule.
5. `docs/specs/qa-gate-marker-attention-routing-tech-design.md` — frontmatter
   to `status: shipped` with `shipped_pr` / `shipped_date` in the same PR.

### Clarification gate

"No clarification needed because" — the task description is the product
intent, the affected code is identified (one predicate in one crate, one
call site), the live incident task `2c782afb` was inspected directly to
confirm the marker shapes, and the classification inputs (comment author,
structured approval state) are already present in the task payload. Two
questions are still raised below for Quinn at the tech-design gate; both have
a stated default so implementation can proceed once the design is approved.

## Test plan — acceptance-criterion verification matrix

No user-visible app behaviour changes: this alters workflow routing inside the
lobster crate. There is no app surface and no E2E layer to extend, so the
fallback layers are the crate's Rust unit tests, fixture-driven routing tests,
and a live API sweep. That fallback is proportionate — the observable
behaviour is an attention-stack write, which the live sweep exercises
directly.

| AC | Verification | Layer | Test / evidence |
| --- | --- | --- | --- |
| AC1 | A generic QA-gate marker does not route to the delivery assignee | unit + routing | `qa_gate_prompt_is_not_an_evidence_verdict` (classification) and `qa_gate_prompt_routes_to_the_qa_gate_owner` (routing assertion: `workflow_attention_owner` → `Ash` on the `2c782afb` fixture) |
| AC2 | A verifier's per-AC verdict still routes to the delivery assignee | unit + routing | `evidence_verdict_is_an_evidence_verdict` and `evidence_verdict_selects_the_delivery_assignee` (paired fixture) |
| AC3 | Classification uses only existing payload data | unit + review | No new tag, approval type, API route, or Prisma model; asserted by the diff scope (crate + `docs/systems/tasks.md` only) and by the design's "Data model and API contract changes: None" |
| AC4 | Regression coverage for both shapes | unit | `both_marker_kinds_share_the_fixture_corpus` — the two `2c782afb` fixtures differ only in the marker author, and the routing outcome differs accordingly |
| AC5 | The documented rule matches the code | doc + unit | `docs/systems/tasks.md` states the rule; the routing test's expected owner is the same owner the doc names |
| AC6 | A real sweep does not re-add the delivery assignee | live integration | After merge, run the lobster stage live against `2c782afb` on `http://localhost:4001/api/v1` and capture the resulting `attentionOwners` + task status as task-comment evidence |

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
  code-task-ready-checks --base-url http://localhost:4001/api/v1 --dry-run true \
  --repo . --workspace-root . < <(cargo run --quiet --manifest-path agents/workflows/feature-task/Cargo.toml -- \
    load-task --base-url http://localhost:4001/api/v1 --task-id 2c782afb-2499-4225-8936-c4d3c5279a03)

# Then the live run, and read the stack back.
python3 agents/skills/ops/tasks-api/tasks_api_client.py get \
  --id 2c782afb-2499-4225-8936-c4d3c5279a03
```

### E2E coverage note

The changed behaviour has no app surface: the observable output is the
`attentionOwners` stack written by the lobster and read by `apps/tasks`. The
app-level equivalent is a board card showing a Rowan avatar layer; it is a
direct rendering of the stack, so the stack-level fixture and live sweep
tests cover it without an app E2E case. Recorded here as the reason no app
E2E test is planned.

## Open questions for Quinn (tech-design gate)

- **Q1 — classification inputs (D1).** The default is a two-input
  classification: marker author (verifier → verdict, lobster service → gate
  prompt) plus the structured `qa_agent` row state (no approved attestation →
  gate prompt), with an unknown shape treated as a verdict so today's routing
  is preserved for unclassified cases. The alternative is to introduce an
  explicit marker kind (a new tag or a new approval type), which is more
  legible but adds a contract to the API and requires Ash and the lobster to
  adopt it — and AC3 rules that out. **Default: implement the two-input
  classification as written.**
- **Q2 — arm 5 vs no explicit row for a pending QA gate.** With D2, a
  delivery-complete task whose `qa_agent` approval is pending resolves through
  arm 5 to `Ash` — an explicit attention row naming the actor the marker names.
  The alternative is `None` (ordinary gate work, surfaced through Ash's
  gate-owner queue), which matches the delivery-checklist precedent in the
  same match. **Default: arm 5 (`Ash`)**, because the generic marker is an
  explicit prompt to Ash and an explicit row makes the next actor visible to
  every agent's queue rather than only to the gate-owner fallback. If Quinn
  prefers `None`, AC1's expected owner changes and the routing test changes
  with it.

## Risks

- **R-1 — the service-account author string is a contract.** The primary
  classification input is the lobster's comment author. If it changes, the
  primary rule stops matching. Mitigated by the secondary input (no approved
  attestation ⇒ gate prompt) and by a fixture that pins the expected author
  string, so a rename fails a test rather than silently changing routing.
- **R-2 — a verdict written by someone other than Ash.** If a verifier is ever
  added under another account, its verdicts fall into the unknown-shape
  bucket and are treated as verdicts (fail-closed), so they keep routing to
  the delivery owner. The behaviour is correct, but the classifier should be
  extended with the new account when that happens.
- **R-3 — arm 2 and arm 4 must stay complementary.** Arm 2 (delivery failure
  ⇒ `None`) and arm 4 (evidence verdict ⇒ assignee) read different marker
  kinds. The implementation must not collapse them into one marker check; the
  fixture pair in AC4 is what pins the split.
- **R-4 — the live sweep on `2c782afb` may move the head to `Ash` while Ash
  is mid-verification.** That is the intended state (the marker names Ash),
  but the reconciliation write must preserve `assignee=Rowan` and the
  `qa_agent_gate` row.
