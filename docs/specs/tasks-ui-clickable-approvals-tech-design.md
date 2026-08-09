---
status: draft
task_id: b03aa6a2-f303-4f03-a479-bd85b962982f
product_spec: brain/tasks/specs/open/tasks-ui-clickable-approvals-2026-08-09.md
shipped_pr: null
shipped_date: null
---

# Tasks UI Clickable Approval Checkboxes — Tech Design

**Task:** `b03aa6a2-f303-4f03-a479-bd85b962982f` — Tasks UI Clickable Approval Checkboxes  
**Branch:** `task-b03aa6a2-tasks-ui-clickable-approvals`  
**Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-b03aa6a2-tasks-ui-clickable-approvals`  
**Repository:** `Stoffer-Industries/sindustries`  
**Owner:** Rowan

## Product intent

Turn the existing read-only approval rows in the Tasks detail view into the canonical human control for approving and revoking `spec`, `tech_design`, and `qa` gates. Agent workflows move to the same structured approval API, legacy comment/description markers lose all approval-setting authority, and the API records a readable audit comment for every real state change.

This completes the migration started by PR #370 (structured approval writes) and PR #372 (lobster API-first reads). The durable source of truth is the database-backed `TaskApproval` resource owned by `services/tasks-api`; UI state, task comments, and spec markdown are projections or audit history only.

### Acceptance-criteria interpretation

AC1/AC2 say the click does not post a task comment, while AC7 requires every approval change to post an audit comment. The implementation will satisfy both by making the **client perform only the approval mutation**—it will not separately create/edit comments or task descriptions—while the Tasks API atomically writes the approval and its audit comment. This avoids duplicate/best-effort comments and preserves AC7 as the system-wide audit requirement.

## Ownership boundary and architecture

| Concern | Natural owner | Design |
|---|---|---|
| Approval state and mutation contract | Database-backed Tasks API domain resource | `TaskApproval` remains the sole gate state. Approval routes own mutation, attribution, and audit-comment creation. |
| Immediate checkbox/error state | UI-local state | `ApprovalsSection` keeps a per-type optimistic state, pending flag, and error; the server response reconciles it. Parent task state is refreshed/replaced after success. |
| Required approval types | Existing Tasks API config contract | Continue using `GET /task-types/:taskType/required-approvals`; no mapping changes. |
| Workflow approval writes | Tasks API client/agent workflow boundary | Agents call structured POST/DELETE directly. They do not emit approval tags. |
| Gate reads | Feature-task lobster | Structured `task.approvals` only. Legacy source selection/fallback is removed or rejected. |
| Human/agent identity | Authenticated actor boundary | **Tom selected Option A:** browser users authenticate with durable real login sessions; agents use scoped service credentials. The API derives actor and permissions server-side and rejects forgeable caller-supplied ownership. |
| Human-readable history | `TaskComment` audit projection | API-generated ordinary comments record actor, action, approval type, and server timestamp; comments never grant approval. |

This is one cross-surface implementation PR because UI mutation, API audit semantics, workflow migration, and fallback removal must ship atomically. Shipping any subset would leave either two sources of truth or a client that writes a gate the lobster may interpret differently.

## Current state

- `apps/tasks/src/components/ApprovalsSection.jsx` renders disabled/read-only checkboxes from `task.approvals` and loads required types.
- `apps/tasks/src/tasksApi.ts` has no approve/revoke client operations.
- `services/tasks-api/src/routes/taskApprovals.ts` trusts caller-supplied `owner`, performs standalone approval writes, and intentionally creates no comments.
- `services/tasks-api/src/routes/tasks.ts` creates comments separately and trusts caller-supplied `author`.
- `agents/workflows/feature-task/src/main.rs` supports `legacy`, `api`, and `auto`; `auto` falls back to comments/description markers when a row is absent **or revoked**.
- Quinn’s tech-design queue and approval instructions still discover/post `[tech-design-approved] true` comments.
- The Tasks UI has no session/current-user model. Existing comment author entry is free text, not authentication.

## Implementation plan

### 1. Approval API: actor attribution and atomic audit comments (AC1, AC2, AC5, AC7)

**Primary files**

- `services/tasks-api/src/routes/taskApprovals.ts`
- `services/tasks-api/test/taskApprovals.test.ts`
- `services/tasks-api/src/routes/tasks/_mapper.ts` only if response shape needs the generated comment
- `services/tasks-api/prisma/schema.prisma` only if the chosen auth decision requires persisted actor identifiers; no approval-state schema change is otherwise needed

Refactor POST and DELETE into a single transaction boundary:

1. Validate task id/type and resolve the acting identity using the approved auth decision below.
2. Load the task and current `(taskId, type)` row inside `prisma.$transaction`.
3. For POST, upsert to `approved`, stamp `approvedAt`, clear `revokedAt`, and set server-derived `owner`.
4. For DELETE, update an existing approved row to `revoked`; absent/already-revoked remains an idempotent no-op.
5. For each **real state change**, insert one `TaskComment` in the same transaction.
6. Return the mapped approval row; no-op DELETE returns `data: null` and creates no misleading audit comment.

Audit comment format is ordinary prose, deliberately not a legacy tag:

- `Approval changed: Spec approved by Tom at 2026-08-09T01:45:00Z.`
- `Approval changed: QA revoked by Tom at 2026-08-09T02:10:00Z.`

Use the API server timestamp in ISO-8601 UTC. Re-approving an already-approved row is idempotent unless actor/note changes are intentionally treated as a new approval event; recommendation: identical POST is a no-op with no duplicate comment, while a different actor re-approval is a real change and is audited.

The old integration assertion that approval writes create no comments must be replaced with transaction/audit assertions. Add rollback tests proving neither record commits if approval or comment creation fails.

### 2. Tasks UI mutation and resilient optimistic state (AC1–AC4)

**Primary files**

- `apps/tasks/src/tasksApi.ts`
- `apps/tasks/src/tasksApi.test.ts`
- `apps/tasks/src/components/ApprovalsSection.jsx`
- `apps/tasks/src/components/ApprovalsSection.test.jsx`
- `apps/tasks/src/components/TaskEditor.jsx`
- `apps/tasks/src/components/TaskEditor.test.jsx`
- `apps/tasks/test/e2e/approval-checkboxes.spec.js` (new)
- `apps/tasks/SPEC.md`

Add typed API operations:

```ts
approveTask(taskId, { type, note? }): Promise<TaskApproval>
revokeTaskApproval(taskId, type): Promise<TaskApproval | null>
```

The actor is not accepted from component-local free text; it follows the authorization decision. The browser sends credentials/session data or a configured trusted credential, never an arbitrary owner string presented as verified identity.

`ApprovalsSection` receives `task` plus an `onTaskChanged`/refresh callback from `TaskEditor`. For each type it tracks:

- optimistic `approved`/`revoked` projection;
- `pending` mutation state (disable repeated clicks only for that row);
- row-local error with an accessible live region.

Click flow:

1. Snapshot the current row.
2. Optimistically toggle the checkbox and disable that row.
3. POST or DELETE.
4. On success, replace optimistic state with the returned row and refresh/reload the task so parent state and comments converge.
5. On failure, restore the snapshot, keep the checkbox truthful, and show a clear error.

The checkbox is no longer globally `disabled`/`readOnly`. Loading required approvals or mutating another row must not block unrelated rows. Preserve keyboard activation, checked semantics, and existing avatar/tooltips.

E2E covers approve, revoke, immediate state, reload persistence, API-generated audit comment, and forced request failure/rollback.

### 3. Agent workflows write structured approvals (AC5)

**Primary files**

- `agents/skills/ops/tasks-api/tasks_api_client.py`
- `agents/skills/ops/tasks-api/SKILL.md`
- `agents/definitions/quinn/HEARTBEAT.md`
- `agents/skills/dev/tech-design/SKILL.md`
- `agents/definitions/rowan/WORKFLOW.md`
- `agents/skills/dev/pr-process/SKILL.md`
- `agents/skills/ops/factory-retro/SKILL.md`
- `agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py`
- `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`
- corresponding Python tests under `agents/skills/ops/tasks-api/scripts/`

Add first-class CLI/client commands for approve/revoke. Quinn’s queue reads `task.approvals` to determine whether `tech_design` is approved and, after review, calls POST with the authenticated/service actor rather than posting `[tech-design-approved] true`. QA and spec approval instructions migrate to the same API contract where they currently set state through `[qa-ac-verified] true` or `**Approved by Tom**`.

The API-generated comment is audit history only. Queue parsers must not infer approval from it.

Before implementation is declared complete, run a repository-wide search for the three legacy approval markers and classify every hit as one of:

- migration/history fixture intentionally retained;
- documentation describing retired behavior;
- test proving markers no longer grant approval;
- active setter/reader that must be replaced.

### 4. Lobster becomes structured-only (AC6)

**Primary files**

- `agents/workflows/feature-task/src/main.rs`
- `agents/workflows/feature-task/run.py`
- `agents/workflows/feature-task/feature-task.lobster.yaml`
- `agents/workflows/feature-task/code-task.lobster.yaml`
- `agents/crons/prompts/task-lobsters.md`
- Rust tests currently covering source selection and legacy tag parsing

Remove `legacy`/`auto` approval-setting semantics and make every gate read only structured approval rows. Preferred clean shape:

- remove `ApprovalSource::{Legacy, Auto}` and the fallback helpers;
- remove `--approval-source` from the Rust CLI, Python runner args, YAML interpolation, and cron prompt;
- preserve parsers only where still required for one-shot migration tooling, not in runtime gate code;
- update failure messages to request the relevant structured approval, not a task comment tag.

A revoked structured row must fail closed; it must never fall back to an old positive comment. Tests explicitly prove checked spec markers, `[tech-design-approved] true`, and `[qa-ac-verified] true` cannot satisfy gates when structured approval is absent/revoked.

### 5. Durable documentation updates

- Update `docs/systems/tasks.md` to make `TaskApproval` the only approval source, document the audit-comment projection, actor/auth contract, API writes, failure modes, and retired tags.
- Update `apps/tasks/SPEC.md` from read-only approval rows to the approve/revoke flow and link the new Playwright coverage.
- Update this design to `status: shipped` with PR/date in the implementation PR.
- Legacy migration script/docs may remain for historical recovery but must clearly state that runtime code never derives approval from legacy text.

## API contract

Existing endpoints remain:

```http
POST /api/v1/tasks/:id/approvals
Content-Type: application/json

{ "type": "tech_design", "note": "optional rationale" }
```

```http
DELETE /api/v1/tasks/:id/approvals/:type
```

The final authentication headers/cookies depend on the authorization decision. The server derives `owner`; body `owner` is ignored or rejected after migration. Success responses retain the current mapped `TaskApproval` shape. Errors use existing `{ error: { code, message } }` conventions.

Audit comment creation is part of the mutation contract but does not require a second client call. API documentation must state that a successful real state transition creates exactly one comment; idempotent no-ops create none.

## Authorization decision — Option A selected

**Decision:** Tom selected the durable boundary: real browser login sessions plus scoped service credentials for agents. The local-only credential shortcut and caller-supplied actor approaches are rejected.

Implementation contract:

- Browser users authenticate through a durable server-side session represented by an `HttpOnly`, `Secure`, `SameSite` cookie. The Tasks API derives the human actor from the session; browser JavaScript never supplies or stores an approval credential.
- Agents authenticate with separate scoped service credentials. The server maps each credential to a stable actor (`Quinn`, `Tom`, `Rowan`, etc.) and an allowed approval-type/action set.
- Approval routes reject unauthenticated requests and reject/ignore body `owner`; persisted `TaskApproval.owner` and audit-comment author come only from the authenticated principal.
- Session and service-principal authorization is enforced in shared Tasks API middleware so future privileged task actions can reuse the boundary rather than adding endpoint-local secrets.
- Credentials are revocable and fail closed. Logs and API responses never expose tokens or cookie contents.

Initial per-type policy remains a separate product confirmation: recommended defaults are `spec` and `qa` for Tom, `tech_design` for Quinn, with explicitly scoped automation credentials only where an agent acts on that human's delegated authority.

## `.openclaw` boundary

This feature changes agent operating instructions that are symlinked/shared through the repo (`agents/definitions/*`, skills, and cron prompt), so those updates ship in the implementation PR.

Option A requires session-signing material and agent service credentials. Secret values and runtime Gateway/environment configuration live outside this repo. The PR documents required variable names, rotation, and fail-closed behavior only; no secret is committed. Any live OpenClaw/config credential provisioning must be separately applied and verified after merge.

## Test plan and AC verification matrix

| AC | Verification | Planned tests |
|---|---|---|
| AC1 | Pending checkbox calls POST once, server derives actor, approval is persisted, client does not separately post/edit task content | `ApprovalsSection.test.jsx`, `tasksApi.test.ts`, `taskApprovals.test.ts`, Playwright `approval-checkboxes.spec.js` |
| AC2 | Checked checkbox calls DELETE once; approved row becomes revoked; client does not separately post/edit task content | Component/API integration + Playwright revoke flow |
| AC3 | Optimistic checkbox changes immediately; successful response reconciles state; reload reads persisted row | Component fake-timer/request test + Playwright reload assertion |
| AC4 | POST/DELETE failure restores previous state, exposes row-level accessible error, and permits retry | Component tests for approve and revoke failures + Playwright route-failure test |
| AC5 | Quinn/QA/spec workflows call structured API; queues read `task.approvals`; no active workflow posts legacy tags | Python client/queue tests plus repository legacy-marker audit |
| AC6 | Legacy description/comment tags cannot satisfy spec, tech-design, or QA gates; revoked/missing rows fail closed | Rust unit/integration tests replacing `legacy/api/auto` matrix; runner/YAML dry-runs without `approvalSource` |
| AC7 | Every real approve/revoke commits one correctly attributed audit comment atomically; idempotent no-ops create none; rollback is all-or-nothing | Tasks API transaction tests + Playwright comment-history assertion |

Required local gates before PR:

- `pnpm --filter @sindustries/tasks test` (or repo-equivalent Tasks app test command)
- Tasks Playwright approval spec
- Tasks API unit + DB integration suite
- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml`
- `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings`
- Python task workflow/client tests
- Lobster dry-run for feature and code pipelines after removing `approvalSource`

## Risks and mitigations

1. **Authorization scope can expand the task.** Resolve the decision before implementation. Prefer the smallest fail-closed credential boundary that can truthfully identify actors.
2. **Partial approval/comment writes would corrupt audit history.** Use one Prisma transaction and explicit rollback tests.
3. **Optimistic UI can display false state.** Snapshot per-row state, disable only the in-flight row, reconcile with server response, and rollback visibly on error.
4. **Legacy fallback removal can block active tasks missing migrated rows.** Before merge, query active tasks for required approvals and backfill through the structured API where necessary; do not preserve runtime fallback as a shortcut.
5. **Marker removal touches many operational docs/scripts.** Use a repository-wide inventory and tests proving retained marker strings are historical/negative fixtures only.
6. **AC1/AC2 wording conflicts with AC7.** Treat “no comment” as “no separate client-authored approval comment”; API-generated audit comments are mandatory. Confirm this interpretation in tech-design approval.

## Open questions / decisions needed

1. **Per-type permissions:** should the initial mapping enforce `spec` and `qa` as Tom-only and `tech_design` as Quinn-only, or may any authenticated actor change any required type? Recommendation: enforce a server-side map matching current ownership, configurable without client changes.
2. **AC1/AC2 vs AC7:** confirm the interpretation that the UI makes no separate comment request while the API atomically generates the audit comment.
3. **Idempotent re-approval:** confirm identical POST creates no new audit comment; a changed actor/note is treated as a new audited approval event.
4. **Completed tasks:** should approval controls be disabled after `done`? Recommendation: disable mutations for archived tasks and allow explicit revoke on `done` only if the product wants post-hoc audit correction; otherwise make `done` immutable.

## Delivery sequence

1. Confirm per-type authorization and AC-comment interpretation in tech-design approval; Option A actor architecture is already selected.
2. Implement API actor/transaction/audit semantics and tests.
3. Implement UI mutations/optimistic rollback and E2E coverage.
4. Migrate agent writers/queues to structured API.
5. Remove lobster fallback and validate active-task structured coverage.
6. Update system/app docs, run all gates, open one feature-task PR with all seven ACs verbatim and evidenced.
