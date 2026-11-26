---
status: draft
task_id: 6e0bd691-fb0d-43cb-bd02-a81586afb5f8
product_spec: brain/tasks/specs/open/qa-gate-human-override-2026-11-24.md
shipped_pr: null
shipped_date: null
---

# Tech Design — QA-agent gate human override in the Tasks UI

## Product intent

The linked spec requires an “explicit, distinct override action for the
`qa_agent` gate” that records Tom, the time, and a required reason and is
distinguishable from an Ash-verified grant. It also requires that “an override
grant is revalidated/revoked the same way an attested grant is” after a PR head
or AC-evidence change. Only Tom may see/use it; this is not a general skip-gate
mechanism.

### Already shipped versus remaining work

PR #585 / commit `a52ea919` (task `2c3bf69b`) already added `qa_agent`
and `tech_design` to `ACTOR_PERMISSIONS.Tom` in
`services/tasks-api/src/middleware/approvalAuth.ts`. `GET /auth/session`
therefore enables those rows in
`apps/tasks/src/components/ApprovalsSection.jsx`; its component test already
proves Tom can interact with all four rows.

That shipped permission is not an override path. Every `qa_agent` POST still
runs `evaluateQaAttestation()` in
`services/tasks-api/src/routes/taskApprovals.ts`, while the app sends only
`{type:'qa_agent'}`. This task adds distinct request/audit semantics, live PR
pinning, UI, and tests without duplicating or reverting PR #585.

Task `9e8f2b37-6fcb-49a1-a358-4cc5cea16aa1` was later created from the same
spec with the same ACs. It is duplicate tracking, not a second implementation.

## Delivery metadata

- **Task:** `6e0bd691-fb0d-43cb-bd02-a81586afb5f8`
- **Title:** Tom has no way to override the qa_agent gate in the Tasks UI
- **Branch:** `task-6e0bd691-qa-agent-gate-override`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-6e0bd691-qa-agent-gate-override`
- **Repo:** `Stoffer-Industries/sindustries`
- **Product spec:** `brain/tasks/specs/open/qa-gate-human-override-2026-11-24.md`
- **Related designs:** `docs/specs/tom-approve-tech-design-qa-gates-tech-design.md`,
  `docs/specs/qa-agent-evidence-gate-tech-design.md`

## Service boundary and data ownership

`services/tasks-api` owns approvals and their audit history, so it owns the
override request, grant source, reason, actor/timestamps, and existing PR pins.
`apps/tasks` creates/displays requests. `agents/workflows/feature-task`
consumes them, fetches GitHub state, computes the canonical digest, seals the
request, and later invalidates stale grants. List/detail callers and the status
guard consume the resulting approval.

The API must not fetch GitHub data. The shipped design deliberately keeps
GitHub access and `qa_evidence_attest::ac_section_digest` in Rust. Moving
either into the API would add credentials and a second digest implementation.
No new service or shared package is appropriate; one existing app and workflow
already own local API types. Placement in Tasks API is durable. If PR evidence
later becomes a service, its producer can move behind the same fulfillment
contract without migrating approval data.

## Ownership boundary check

The natural sources of truth are:

1. **Database-backed API resource:** request/grant/audit state and pins in
   Tasks API.
2. **Workflow boundary:** live GitHub identity and canonical digest in the
   feature-task Rust workflow.
3. **UI-local state:** only the unsaved reason modal.

This workflow-mediated seal avoids a UI/API shim with null pins (which the
existing invalidator correctly treats as stale) and preserves one evidence
implementation.

## Proposed flow

1. Tom sees **Request human override** on an unapproved QA row, not an enabled
   ordinary QA checkbox. A modal requires a reason.
2. The API derives Tom from the Clerk principal, creates a request id, stores
   requester/time/reason on the pending `TaskApproval`, and writes an audit
   comment transactionally.
3. The next `verify_delivery` pass uses its existing current delivery PR data
   to call a private fulfillment route with request id, PR number, head SHA,
   and AC-section digest. This snapshots evidence; it does not claim Ash did
   semantic QA.
4. The API compare-and-sets the pending request, writing
   `qaGrantSource=human_override`, `owner=Tom`, reason, grant time, all
   pins, and a distinct grant comment.
5. Existing `RecordedPins` / `detect_drift` logic treats attested and
   override grants identically. PR swap, head move, or digest change revokes
   either.

An Ash attestation racing the request sets `qaGrantSource=attested`, clears
request fields, and wins. Fulfillment then returns
`409 QA_OVERRIDE_REQUEST_STALE`.

## `.openclaw` boundary notes

No `.openclaw` file, secret, dashboard, cron, or new credential is required.
The existing feature-task runtime has GitHub reads and its service identity.
The new route authorises `feature_task_lobster` narrowly; generic
`qa_agent` grant permission is not added to its credential or
`ACTOR_PERMISSIONS`.

Deploy in order: Prisma/Tasks API, feature-task processor, Tasks UI. UI-last
prevents requests before a processor exists. Fields are additive and pending
requests survive rollback.

## Data model and API contract changes

Extend `services/tasks-api/prisma/schema.prisma`:

```prisma
enum QaApprovalGrantSource {
  attested
  human_override
}
model TaskApproval {
  qaGrantSource       QaApprovalGrantSource?
  overrideRequestId   String? @db.Uuid
  overrideRequestedBy String?
  overrideRequestedAt DateTime?
  overrideReason      String?
}
```

The migration backfills `attested` only for existing `qa_agent` rows with
all three pins. Unpinned legacy rows remain null/fail-closed. No table is
needed: `(taskId,type)` is unique, one request is current, and comments keep
append-only history.

Public request:
`POST /api/v1/tasks/:id/approvals/qa_agent/override-requests`
with `{"reason":"..."}`. Clerk actor must be exactly Tom; service credentials
and other humans get `403 QA_OVERRIDE_FORBIDDEN`. Reason is trimmed,
required, and at most 1,000 characters. Archived/done tasks remain immutable;
approved rows return `409 QA_OVERRIDE_NOT_REQUESTABLE`. Success returns the
mapped pending row.

Private fulfillment:
`POST /api/v1/tasks/:id/approvals/qa_agent/override-requests/:requestId/fulfill`
with:

```json
{"prNumber":1234,"headSha":"<sha>","acSectionDigest":"<sha256>"}
```

Only `feature_task_lobster` is allowed. All pins are required and
structurally validated. The transaction compares request id/pending state and
derives owner/reason from stored data. Success returns
`qaGrantSource=human_override`; stale requests return 409.

The ordinary approval POST remains attestation-only for Tom and Ash. Success
sets `qaGrantSource=attested` and clears request fields. No actor exception is
added to `evaluateQaAttestation`.

Mapped app/Rust responses gain nullable `qaGrantSource`,
`overrideRequestId`, `overrideRequestedBy`, `overrideRequestedAt`, and
`overrideReason`. Existing `owner`, `approvedAt`, `note`, and three
`verified*` fields remain canonical; fulfilled overrides populate them all.

## Implementation plan with concrete file scope

### Tasks API

- `services/tasks-api/prisma/schema.prisma` and
  `services/tasks-api/prisma/migrations/<timestamp>_qa_agent_human_override/`
  — additive schema/backfill.
- `services/tasks-api/src/routes/taskApprovals.ts` — retain attestation;
  set/clear grant source and request fields.
- `services/tasks-api/src/routes/qaAgentOverrides.ts` — request/fulfill
  handlers, validation, comments, compare-and-set.
- `services/tasks-api/src/app.ts` — mount router.
- `services/tasks-api/src/routes/tasks/_mapper.ts` — map fields.
- `services/tasks-api/src/middleware/approvalAuth.ts` — dedicated
  Tom-browser/lobster-service checks, without generic expansion.
- `services/tasks-api/src/lib/qaEvidenceAttestation.ts` — reuse pin-shape
  validation only; keep freshness/failure enforcement unchanged.

### Workflow

- `agents/workflows/feature-task/src/main.rs` — deserialize fields.
- `agents/workflows/feature-task/src/api_client.rs` — fulfillment call.
- `agents/workflows/feature-task/src/verify_delivery.rs` — fulfill after live
  pins exist and before QA consultation; refresh the in-memory row. If no one
  current PR can be pinned, leave pending with one actionable deduped failure.
- `agents/workflows/feature-task/src/qa_evidence_drift.rs` — keep
  source-agnostic comparison.

Earlier delivery-evidence checks are not bypassed. Human override replaces
Ash's semantic approval, not malformed or ambiguous delivery metadata.

### App and durable docs

- `apps/tasks/src/tasksApi.ts` — types and request client.
- `apps/tasks/src/components/ApprovalsSection.jsx` — Tom-only modal and
  pending/source labels.
- `apps/tasks/src/components/ApprovalsSection.test.jsx` and
  `apps/tasks/test/e2e/approval-checkboxes.spec.js` — component/E2E coverage.
- `apps/tasks/SPEC.md`, `docs/systems/approvals.md`, and
  `docs/systems/tasks.md` — shipped behavior/contracts/runbook.

## Workflow, cron, and skill changes

`verify_delivery` gains idempotent sealing. No cron schedule, OpenClaw skill,
Python Tasks client, or Ash command changes. Fulfilled/stale requests are not
blindly retried.

## Test plan

### AC verification matrix

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 — distinct action and actor/time/reason | `taskApprovals.test.ts` covers validation, derived identity, fields/comments, and ordinary `attested` grants. New `qaAgentOverride.integration.test.ts` requests/fulfills against Postgres and reads source, Tom, times, reason, and pins. Playwright proves the distinct modal. | API unit + DB integration + E2E |
| AC2 — later PR/evidence change revokes | Run head/digest/PR-swap cases for both sources in `qa_evidence_drift.rs`. Add a fulfilled-override fixture to `tests_integration.rs`, mutate head then body, run `verify_delivery`, and assert existing revoke/reroute. | Rust unit + workflow integration |
| AC3 — clear Tom-only UI | Component tests render Tom, Quinn, Ash, and unknown actors; only Tom sees the action, reason is required, and pending/errors are clear. Playwright verifies payload/refresh. API tests independently deny non-Tom humans/services. | Component + E2E + API auth |
| AC4 — automated distinct/invalidation/denial coverage | AC1 API/DB tests prove distinct records; AC2 workflow test proves invalidation; AC3 API test proves denial. | Cross-layer CI |

E2E covers user-visible flow. Browser tests stub GitHub, so drift belongs in
Rust integration, which executes the real decision/revoke path without a
mutable live PR. Regression gates: Tasks API unit/Postgres suites, existing
attestation tests, app unit/Playwright, feature-task `cargo test`, and the
`ad8346ee` evidence-blanking incident fixture for both sources.

## Open questions and risks

- **Needs Tom decision — duplicate task:** choose one canonical delivery record
  between `6e0bd691` and `9e8f2b37`. This design assumes `6e0bd691`.
- **Noted — asynchronous:** approval lands on the next workflow pass. UI must
  state this and refresh; it preserves one digest implementation.
- **Noted — missing/ambiguous PR:** leave pending and report metadata repair;
  never write null pins or choose historical PR arbitrarily.
- **Noted — deployment skew:** use backend/workflow/UI order.
- **Noted — privacy:** reason is permanent structured data plus comment; UI
  warns against secrets. Actor/time are server-derived.
- **Noted — generic-route regression:** a bare Tom ordinary POST must still
  return `QA_EVIDENCE_GATE_BLOCKED`; only request plus trusted fulfillment
  creates a human override.
