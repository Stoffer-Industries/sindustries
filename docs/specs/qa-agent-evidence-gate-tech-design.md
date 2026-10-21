---
status: draft
task_id: ad8346ee-46fc-4bc7-a9b0-a8c31acfb04f
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Gate Ash's `qa_agent` approval on live AC-evidence + SHA-pinned invalidation

## Product intent

The incident this task closes (task `39667e62`, 2026-10-22) was not a single bad merge. It
was a *missing coupling*. Two gates that both claim to answer "is this task's acceptance
evidence real?" — Ash's structured `qa_agent` approval, and the lobster's mechanical
AC-evidence check — can each pass or fail completely independently of the other, and
nothing re-checks a granted approval against the PR's *current* state. So PR #803 could be
merged with its AC-evidence section blanked to `"test body update"`, with QA still green,
and the task then sat silently in `doing` for ~10 days before a human noticed.

The goal of this task is narrow and deliberate: bind those two gates together at the moment
of approval write, and make the binding *durable* — pinned to what was actually verified, so
a later edit is detected and surfaces a visible owner instead of failing silently.

This is explicitly **not** a blanket pre-merge CI or branch-protection gate. Tom ruled that
out because it would block unrelated, non-task PRs. Everything here lives in the agent
write-path and the lobster, so PRs with no linked task have zero blast radius.

## Task, branch, worktree, repos

- **Task:** `ad8346ee-46fc-4bc7-a9b0-a8c31acfb04f` — "Gate Ash's qa_agent approval on live AC-evidence + SHA-pinned invalidation"
- **Branch:** `task-ad8346ee-qa-agent-evidence-gate`
- **Worktree:** `/Volumes/WD1/worktrees/quinn/task-ad8346ee-qa-agent-evidence-gate`
  - Note: `infra/guards/sindustries-worktree.sh` placed this under `quinn/`, not the
    `rowan/` prefix `agents/definitions/rowan/WORKFLOW.md` documents. Flagging as a doc/code
    drift, not blocking this task.
- **Repo:** `Stoffer-Industries/sindustries` (single repo, no cross-repo work)
- **Components touched:**
  - `agents/workflows/feature-task/` — the Rust `feature-task` lobster crate
  - `services/tasks-api/` — the TypeScript Tasks API service
  - `agents/ash/` — Ash's verifier (consumes the shared check, no logic duplication)

## Ownership boundary

**Natural source of truth: workflow/OpenClaw boundary** — specifically the structured
approval row in the Tasks API plus the lobster's existing AC-parsing logic.

The design principle applied throughout: **the mechanical AC-evidence check must have exactly
one implementation.** Today it already has two, and the Rust one is explicitly documented as
the stricter authority:

> `agents/workflows/feature-task/src/ac_parsing.rs:654` — *"The mechanical checks are
> deliberately a strict superset of Ash's `verify.ts` behaviour so the lobster's gate is at
> least as strict as the agent's was."*

The authoritative implementation is `ac_parsing::mechanical_evidence_failures` (Rust). Ash's
`agents/ash/src/verify.ts` (175 lines) is a lighter TS re-implementation used for Ash's own
pre-flight. **AC1 explicitly names the `ac_parsing` / `mechanical_evidence_failures` logic,
so that Rust function is the thing to invoke.** Porting it to TypeScript inside `tasks-api`
would create a third copy and a drift bug waiting to happen — that is precisely the
duplicated-metadata / second-source-of-truth shape the working posture rejects.

**Direct consumers:** the Tasks API approval route, and the lobster's
`verify_delivery` / `code_task_verify_delivery` stages.

**No extraction or migration is required.** Both components are already in this repo and
already share the Tasks API as their contract. There is no temporary placement to migrate off.

## Root cause recap (design-relevant facts only)

1. `POST /tasks/:id/approvals` (`services/tasks-api/src/routes/taskApprovals.ts`) is the single
   choke point for *every* `qa_agent` approval write, regardless of who writes it. It performs
   auth, note normalization, handoff bookkeeping — and **no evidence check at all**.
2. `TaskApproval` (Prisma, `services/tasks-api/prisma/schema.prisma`) has **no structured
   field** recording what was verified. `note` is free-form prose, so "what did QA actually
   check?" is unrecoverable after the fact.
3. The lobster already gates QA eligibility (`verify_delivery.rs::qa_agent_gate_eligible`) and
   the Tasks API already hides the QA gate from derived views when delivery evidence failed
   (`routes/tasks/_mapper.ts::deliveryEvidenceBlocksQa`). But both are **point-in-time reads**
   of whatever the current state happens to be. Neither *invalidates* a stale grant, and
   `deliveryEvidenceBlocksQa` keys off the lobster's `failureFingerprint` in a comment rather
   than off anything intrinsic to the approval.

So the fix is to make the approval record *what was verified*, and to re-check that record.

## Design decisions

### D1 — Enforce at the API choke point, but compute in Rust (attestation model)

The check must run "immediately before writing a `qa_agent: approved`". There are two
possible homes:

- **(a) In `tasks-api` (TypeScript)** — guaranteed to run on every write, but requires
  porting `mechanical_evidence_failures` to TS. Rejected: third implementation, guaranteed drift.
- **(b) In Ash's workflow, pre-write** — requires every future writer to remember to call it.
  Nothing structurally enforces it. This is the failure mode being fixed.

**Chosen: split compute from enforce.**

1. **Compute** — add a `feature-task mechanical-evidence-check` subcommand to the Rust crate.
   It invokes the *same* `ac_parsing::mechanical_evidence_failures` against the **current**
   PR head, reusing the existing fetchers (`cli_utils.rs::pr_body`,
   `pr_gates.rs::pr_changed_files`), and emits a JSON attestation: PR number, head SHA,
   AC-section digest, and the failure list.
2. **Enforce** — `POST /tasks/:id/approvals` refuses a `qa_agent` approval that has no
   attestation matching the current PR head. It cannot recompute the check (that is Rust), but
   it *can* verify the attestation is present, unexpired, and SHA-pinned — which is what makes
   the write trustworthy regardless of caller.

This gives one implementation, structural enforcement, and no TS duplication.

### D2 — Pin the head SHA *and* an AC-section digest (deviation from a literal reading of AC2)

**This is the most important design finding and needs Quinn's explicit sign-off.**

AC2 asks for "the exact PR head SHA it was verified against". A head SHA pins the *code*.
But the `39667e62` incident was a **PR body edit** — the body was replaced with
`"test body update"`. A body edit does not necessarily change the head SHA at all. If we pin
only the head SHA, AC3 ("if the linked PR's AC-evidence section changes… auto-invalidate")
would **not fire** for the exact failure mode that created this task.

So the design records two structured fields:

- `verifiedPrHeadSha` — required by AC2; pins the code.
- `verifiedAcSectionDigest` — required by AC3 to be *implementable*; a SHA-256 over the
  normalized AC-evidence section of the PR body (`sha2` is already a crate dependency).

Both are structured columns, not prose. AC3 detects a regression when **either** differs from
the current live PR. The SHA alone catches "code moved under the approval"; the digest alone
catches "evidence was rewritten under the approval"; together they close the incident class.

**If Quinn prefers a literal AC2 (SHA only), AC3 cannot be satisfied for body-only edits and
the task would ship with a silent gap in exactly the path it exists to close.**

### D3 — Revocation reuses the existing reason-bearing routing

AC3 requires adding the current assignee to `attentionOwners[0]` with an explicit reason, and
explicitly *not* the passive assignee-queue fallback. The lobster already has the correct
primitive: `api_client.rs::api_reconcile_attention` → `POST /tasks/:id/attention-owners/reconcile`,
which is reason-bearing and authenticated. Use it; do not invent a second routing path, and do
not use the legacy full-stack PATCH.

### D4 — Scope the new gate to `qa_agent` only

AC1/AC2/AC3 are all about `qa_agent`. `tech_design` and `spec` approvals are unaffected. The
enforcement and the attestation requirement branch on `type === 'qa_agent'` and nothing else.

## Implementation plan

### Slice 1 — AC2 + AC3 foundation: structured approval record (Rust + schema)

- `services/tasks-api/prisma/schema.prisma` — add to `model TaskApproval`:
  - `verifiedPrHeadSha String?`
  - `verifiedAcSectionDigest String?`
  Both nullable: non-`qa_agent` approvals never populate them, and pre-migration rows stay valid.
- Generate the Prisma client (`services/tasks-api/src/generated/prisma/`), and update
  `mapTaskApproval` in `services/tasks-api/src/routes/tasks/_mapper.ts` to surface both.
- Migration is additive and backward-compatible — existing approved rows read as "verified
  nothing", which the invalidation pass must treat as *stale* (see Slice 3) rather than crash on.

### Slice 2 — AC1: compute + enforce

- **Compute (Rust)** — new subcommand in the `feature-task` crate
  (`agents/workflows/feature-task/src/`), reusing `ac_parsing::mechanical_evidence_failures`,
  `cli_utils::pr_body`, `pr_gates::pr_changed_files`:
  - input: task id + PR url
  - output: JSON `{ prNumber, headSha, acSectionDigest, failures[], verifiedAt }`
  - must not duplicate any check that `mechanical_evidence_failures` already performs.
- **Enforce (TS)** — in `taskApprovals.ts` `POST /tasks/:id/approvals`, for `type === 'qa_agent'`:
  - require a supplied attestation (head SHA + digest + `verifiedAt`),
  - reject a body-supplied `owner` (already done) **and** a stale attestation
    (`verifiedAt` older than a short TTL — propose 15 minutes),
  - on rejection: do **not** write the approval; return `409 QA_EVIDENCE_GATE_BLOCKED`
    carrying the mechanical failures so the caller can post `[qa-agent-blocked]`.
- **Wire Ash** — `agents/ash/` runs the subcommand immediately before its approval write. On a
  non-empty `failures` list it posts `[qa-agent-blocked]` with those failures and does not
  approve. `verify.ts` keeps its existing light pre-flight; it is not the authority.

### Slice 3 — AC3: invalidation in `verify_delivery`

- In both `verify_delivery()` and `code_task_verify_delivery()` (`agents/workflows/feature-task/src/verify_delivery.rs`),
  before the QA-gate predicate runs:
  - fetch the linked PR's current head SHA + AC-section digest,
  - compare against the granted `qa_agent` approval's pinned values,
  - on mismatch → revoke (`state: 'revoked'` via the existing authenticated DELETE path) and
    `api_reconcile_attention([current_assignee], reason)` where the reason names the regression
    (which field diverged, from SHA → digest) — per D3.
- Must be idempotent: a task re-entering `verify_delivery` with an already-revoked approval and
  no new grant must not re-revoke, re-comment, or re-route.

## Test plan — AC-by-AC verification matrix

| AC | What is proven | Layer | Concrete test |
|---|---|---|---|
| **AC1** | A `qa_agent` approval whose live mechanical check fails is **refused**, and `[qa-agent-blocked]` is posted with the failure | Rust unit + tasks-api integration + tasks-api route integration | Rust: subcommand returns non-empty `failures` for a PR citing a file not in the diff (mirrors existing `mechanical_evidence_failures` unit tests at `ac_parsing.rs:1757+`). API: route integration test posts `qa_agent` with a failing/stale attestation → expects `409 QA_EVIDENCE_GATE_BLOCKED` and asserts **no** `TaskApproval` row was created |
| **AC2** | The granted approval stores the verified PR head SHA as a **structured field** | tasks-api db integration (real Postgres) | Create task → approve `qa_agent` with attestation → read row directly and assert `verifiedPrHeadSha`/`verifiedAcSectionDigest` equal the attested values, and that a follow-up `GET /approvals` surfaces them |
| **AC3** | Changing the AC-evidence section after approval auto-invalidates and routes a visible owner | Rust integration (`tests_integration.rs`) | Fixture task with `qa_agent` approved + pinned digest; edit PR body so the digest diverges; run `verify_delivery` → assert approval is `revoked`, `attentionOwners[0] == assignee`, and the reconcile reason cites the regression. **Second case: body edit only, head SHA unchanged** — the incident's exact shape |
| **AC4** | End-to-end reproduction of `39667e62` | Rust integration, mirroring existing harness at `tests_integration.rs:1125` | Approve against a head with valid AC evidence → blank the body to `"test body update"` → next `verify_delivery` asserts **both** the AC3 invalidation **and** that the task does not remain parked in `doing` with no visible attention-owner signal (i.e. `attentionOwners` is non-empty) |

**E2E coverage justification (required by the tech-design skill):** none of AC1–AC4 are
user-visible app flows — they govern agent/lobster/task-system behaviour with no UI surface
and no end-user path. Browser E2E would be disproportionate and would test nothing real. The
fallback layers above (Rust crate unit + integration, tasks-api vitest route + real-Postgres db
integration) are the correct layers. This is recorded deliberately, not as an omission.

**Quality gates:** per `agents/workflows/feature-task/WORKFLOW.md`, this PR touches the
feature-task crate's Rust and therefore must pass the crate's local + CI gates (`cargo clippy
-- -D warnings`, `cargo test`, plus `feature-task workflow tests` in CI) before
ready-for-review.

## `.openclaw` boundary

None required. The subcommand reuses the lobster's existing authenticated GitHub access
(the same mechanism `pr_changed_files` / `pr_body` already use via the `gh`-with-agent-token
shim). No new credential, no `.openclaw` write, no secrets change. If implementation uncovers
a need for a new credential, stop and route Quinn at `attentionOwners[0]` rather than writing
to `~/.openclaw/`.

## Risks

- **Two implementations already exist** (Rust + `verify.ts`). This design removes the risk
  rather than adding to it, but only if the enforcement genuinely lives in the API. If the API
  check is ever weakened to a warning, the whole task silently reverts to today's behaviour.
  → Mitigation: the db-integration test for AC1 asserts on the *absence* of a row, not just a
  non-200 status.
- **Backfill semantics.** Pre-migration approvals have NULL pinned values. Treat NULL as
  stale (re-route, do not crash) — but confirm with Quinn whether a legacy in-flight task
  should instead be grandfathered once.
- **Attestation TTL vs. slow reviewers.** A fixed 15-minute TTL could annoy a careful reviewer
  who takes longer between verification and approval. Mitigated by ordering: verify-then-approve
  are adjacent steps in one workflow run, so the window is normally seconds. Flagged rather
  than optimised.
- **AC2's literal reading is insufficient for AC3** (D2). This is a spec gap, not an
  implementation risk — surfaced above for an explicit decision.

## Open questions for Quinn

1. **D2 — approve the two-field model** (`verifiedPrHeadSha` + `verifiedAcSectionDigest`) over
   AC2's literal SHA-only wording? Without the digest, AC3 cannot catch the body-edit failure
   mode that caused this task.
2. **Grandfathering:** should approvals granted before this ships (NULL pinned values) be
   treated as stale-and-re-route, or grandfathered once?
3. **Attestation TTL:** is 15 minutes acceptable, or should the attestation be single-use
   (consumed on first approval write)?
4. Confirm `infra/guards/sindustries-worktree.sh` writing under `quinn/` for a Rowan-owned task
   is expected — `WORKFLOW.md` documents a `rowan/` prefix.