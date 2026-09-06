# Tech Design — Let Tom approve tech-design and QA gates (task 2c3bf69b)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/2c3bf69b-d729-471c-9326-9a68f62e6bf4 (full UUID on Tasks API)
**Branch:** `2c3bf69b-tom-approve-override` (off `origin/main`, commit `bf399ad`)
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-06

---

## Problem

Tom currently cannot grant `tech_design` or `qa_agent` structured approvals. `ACTOR_PERMISSIONS.Tom` in `services/tasks-api/src/middleware/approvalAuth.ts` only includes `spec` and `accepted`. A `POST /tasks/:id/approvals` call authenticated as Tom for `tech_design` or `qa_agent` returns `403 APPROVAL_TYPE_FORBIDDEN`, and the Tasks UI (`apps/tasks/src/components/ApprovalsSection.jsx`) renders those checkboxes disabled for his session because `GET /auth/session` returns only the types he currently holds.

This blocks Tom when he already knows the design/QA is good and wants to unblock without waiting on Quinn/Ash — a recurring friction point whenever the design or QA gate is the last remaining structured approval on a task that's otherwise done.

## Goals (and non-goals)

**In scope**
- Allow Tom to grant (`POST /tasks/:id/approvals`) and revoke (`DELETE /tasks/:id/approvals/:type`) `tech_design` and `qa_agent` approvals, additively on top of his existing `spec` and `accepted` grants.
- Update the Tasks UI to render those checkboxes enabled for Tom (expected to flow through automatically via the existing `actor.approvalTypes.includes(type)` check).
- Confirm that the gate's routable attention-owner head slot stays `Quinn` for `tech_design` and `Ash` for `qa_agent` regardless of who granted the approval (per existing `APPROVAL_ATTENTION_OWNERS` and Rust `workflow_attention_owner` keyed purely on approval type).
- Cover the new behavior with tests in `services/tasks-api/test/taskApprovals.test.ts` and `apps/tasks/src/components/ApprovalsSection.test.jsx`.

**Out of scope**
- Changing `APPROVAL_ATTENTION_OWNERS` / `DEFAULT_APPROVAL_OWNERS` (`services/tasks-api/src/config/workflowHandoffs.ts`) or the Rust `workflow_attention_owner` / `managed_owner_reason_satisfied` logic in `agents/workflows/feature-task/src/main.rs`. (AC4 invariant.)
- Changing Quinn's `tech_design` grant or Ash's `qa_agent` grant semantics. (AC5 invariant.)
- Adding new UI affordances for Tom as the routine approver — Tom is an override actor, not the default routable head. (AC4 invariant.)
- Service-credential-backed grants. Tom uses a browser session (`tasks_api_session` cookie via `POST /auth/session`); the service-credential path is unaffected and stays scoped by per-credential `approvalTypes` arrays.

## Source-of-truth docs

- `docs/systems/tasks.md` — approval pipeline, structured approvals, attention-owners
- `services/tasks-api/src/middleware/approvalAuth.ts` — `ACTOR_PERMISSIONS` map (the change)
- `services/tasks-api/src/config/workflowHandoffs.ts` — `APPROVAL_ATTENTION_OWNERS` (touched only to verify AC4)
- `agents/workflows/feature-task/src/main.rs` — Rust `workflow_attention_owner` (read-only, to confirm independence from `ACTOR_PERMISSIONS`)
- `apps/tasks/src/components/ApprovalsSection.jsx` — UI checkbox enablement (expected to require no code change)
- `services/tasks-api/test/taskApprovals.test.ts` — service-credential + browser-session tests (fixtures and one assertion need updating)

## Architecture / approach

A single line change plus test/fixture updates:

1. **`services/tasks-api/src/middleware/approvalAuth.ts:25`** — extend the Tom entry from
   ```ts
   Tom: new Set(['spec', 'accepted']),
   ```
   to
   ```ts
   Tom: new Set(['spec', 'accepted', 'tech_design', 'qa_agent']),
   ```

   Every downstream consumer reads from this map:
   - `permissions()` filters requests to types the actor holds (line 64).
   - `approvalTypesForActor()` returns the session actor's types to the UI (line 70).
   - `POST /api/v1/auth/session` and `GET /api/v1/auth/session` both return `approvalTypes: approvalTypesForActor(session.actor)` (`services/tasks-api/src/routes/approvalSessions.ts:53,61`).

   No further middleware change is needed; the permission gate already short-circuits cleanly.

2. **`apps/tasks/src/components/ApprovalsSection.jsx`** — no code change required. The existing `const isAuthorized = authStatus !== 'authenticated' || actor?.approvalTypes?.includes(type);` (line 269) already enables the checkbox once Tom's session returns the new types. AC3 is satisfied by the backend change alone. Verified by reading the file: the component trusts the server's `approvalTypes` and renders checkboxes against `requiredApprovals` set by the server, which is independent of `ACTOR_PERMISSIONS`.

3. **`apps/tasks/src/components/ApprovalsSection.test.jsx`** — add a single test case: with Tom's session returning `approvalTypes: ['spec', 'accepted', 'tech_design', 'qa_agent']`, all four checkboxes (`spec`, `tech_design`, `qa_agent`, `accepted`) render `disabled={false}` and respond to clicks (existing `requestToggle` path already covers the click handler). The test runs against the existing fixture shape; only the mock for `fetchAuthSession` needs the extended list.

4. **`services/tasks-api/test/taskApprovals.test.ts`** — three targeted updates:
   - **Line 8** (`tomServiceCredentials` fixture): change `approvalTypes: ['spec', 'accepted']` to `['spec', 'accepted', 'tech_design', 'qa_agent']` so the service-credential mock matches the new policy. (This fixture models a credential Tom would set up; without the update, the Tom-service-credential grant path would 403 even though the policy permits it.)
   - **Line 79–83** ("enforces Tom-only spec/accepted and Quinn-only tech_design"): rewrite to assert the new policy — Tom's POST for `tech_design` returns 200, Quinn's POST for `spec` still returns 403, and the cross-actor denial still holds. Add a second assertion row for Tom granting `qa_agent`.
   - **Add a new test** verifying that when Tom grants `tech_design`, the audit row is written with `owner: 'Tom'` (not derived from request body) and the existing `$transaction` payload still routes the approval atomically with the audit comment.

5. **No changes to** `services/tasks-api/src/config/workflowHandoffs.ts`, `agents/workflows/feature-task/src/main.rs`, `agents/workflows/code-task/`, `agents/workflows/feature-task/`, or the lobster configuration. `APPROVAL_ATTENTION_OWNERS` (workflowHandoffs.ts:45) keys `tech_design → 'Quinn'`, `qa_agent → 'Ash'`, and the Rust `workflow_attention_owner` mirrors that mapping. Both writers key on approval type, not actor, so a Tom-granted approval satisfies the gate exactly as a Quinn/Ash grant would; Quinn/Ash still own the routable head slot in the normal case.

## Service boundary and data ownership

- **Who owns the change:** services/tasks-api is the single owner; the UI flows from the server response. No new shared-package, no new database column, no migration.
- **No new external integration.** The change is bounded to the existing structured-approval route surface.
- **No consumers affected outside the approval surface.** `agent_task_queue.py` reads `topAttentionOwner` from the task's `attentionOwners` array, which is set by the lobster on structured approval via `agents/workflows/feature-task/src/main.rs::workflow_attention_owner` — keyed on approval type, not on the granting actor. So a Tom-granted approval still routes to Quinn/Ash at the head slot, exactly as the task description requires.

## Milestones

All milestones land on the same PR (no interim shipping — the change is too small to merit a slice):

- **M1 (this PR):** one-line `ACTOR_PERMISSIONS.Tom` extension + four targeted test updates (one fixture row, one assertion row rewrite, one new test for Tom-grant audit semantics, one new test for Tom UI enablement in the React component). No other files change.

## Risk and mitigations

- **Risk: someone assumes Tom is the routine tech_design/qa_agent approver because the gate is now Tom-grantable.**
  Mitigation: AC4 explicitly tests that `APPROVAL_ATTENTION_OWNERS` is untouched, and the design doc states that the routable head stays `Quinn`/`Ash`. The heartbeat queue (`agent_task_queue.py`) reads `topAttentionOwner`, which the lobster writes from `APPROVAL_ATTENTION_OWNERS` (type-keyed), so Tom-grants do not move the head.

- **Risk: regression in Quinn's `tech_design` grant path or Ash's `qa_agent` grant path.**
  Mitigation: AC5 is preserved by the test-isolation strategy — Quinn's and Ash's tests are not modified, and the cross-actor denial test (Quinn → `spec` → 403) stays in place. The service-credential fixture for Quinn (`approvalTypes: ['tech_design']`) and Ash (which routes through `feature_task_lobster`) are untouched.

- **Risk: production service credential for Tom accidentally becomes permissive.**
  Mitigation: Tom authenticates via `POST /api/v1/auth/session` (browser-session flow), not via `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`. The service-credential array is not affected by `ACTOR_PERMISSIONS`; it carries per-credential `approvalTypes` and only the existing Quinn/Ash/lobster/brain_spec_reconciler entries use it. No service-credential row for Tom exists today, and adding one would require explicit operator action via the env-var contract.

- **Risk: UI shows the new checkboxes enabled but the server still rejects the grant.**
  Mitigation: the `actor.approvalTypes` returned by `GET /auth/session` comes from the same `approvalTypesForActor()` function the middleware uses to enforce permissions, so server-side gating matches UI rendering by construction. The end-to-end test in step 4 (new test for `requestToggle` with Tom session + `tech_design`) covers the round-trip.

## Test plan

1. Existing unit tests in `services/tasks-api/test/taskApprovals.test.ts` — all 36 tests must pass after the fixture and assertion updates. The targeted tests (Tom-grants-`tech_design`, Tom-grants-`qa_agent`, cross-actor denial preserved) are the gate.
2. New React test in `apps/tasks/src/components/ApprovalsSection.test.jsx` — Tom's session with the new `approvalTypes` array renders four enabled checkboxes; clicking `tech_design` triggers `createTaskApproval({ type: 'tech_design' })` and the optimistic UI state update.
3. Manual smoke: `make up MODE=prodlike`, login as Tom via the Tasks UI, confirm all four checkboxes on a `doing` task are enabled and toggle `tech_design` once → confirm the structured approval row writes `owner: 'Tom'` and the audit comment writes `Approval tech_design approved by Tom.`.
4. Manual smoke (separate session): login as Quinn on the same task and confirm `tech_design` and `qa_agent` checkboxes are still disabled (Quinn's `approvalTypes` is unchanged). Same for Ash on `qa_agent`.
5. AC4 invariant smoke: after Tom's `tech_design` grant, `GET /api/v1/tasks/<id>` should show `topAttentionOwner: 'Quinn'` (not `'Tom'`), and `agent_task_queue.py --assignee <assignee>` should not move the task to a Tom-routable slot.

## Open questions

None blocking. Two informational items:

- **Q1 (resolved):** should the override behavior be audit-logged specially, e.g. an additional comment like "Tom override on Quinn's gate"?
  **Resolution:** no. The existing audit row already records `owner: 'Tom'`, which is the durable signal. The audit comment `Approval tech_design approved by Tom.` is the human-readable marker. Adding a second comment would be noise.

- **Q2 (informational):** does Tom want a UI badge showing "Override mode" when he grants a non-default gate?
  **Resolution:** deferred. Out of scope; Tom can always read the audit row if he wants to confirm the grant was his.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 | Code review: `ACTOR_PERMISSIONS.Tom` includes `tech_design` and `qa_agent`. |
| AC2 | New tests in `services/tasks-api/test/taskApprovals.test.ts` — `POST /tasks/:id/approvals` with Tom cookie and `type: 'tech_design'` (and `type: 'qa_agent'`) returns 200; `DELETE /tasks/:id/approvals/<type>` returns 200. |
| AC3 | New React test in `apps/tasks/src/components/ApprovalsSection.test.jsx` — Tom's session renders four enabled checkboxes. |
| AC4 | No diff to `services/tasks-api/src/config/workflowHandoffs.ts` or `agents/workflows/feature-task/src/main.rs::workflow_attention_owner` in this PR; manual smoke confirms `topAttentionOwner` after Tom's grant is still `Quinn` for `tech_design` and `Ash` for `qa_agent`. |
| AC5 | Existing Quinn (`approvalTypes: ['tech_design']`) and Ash (lobster) fixtures unchanged; Quinn-grants-`spec` still returns 403 in the updated assertion block. |
| AC6 | This document is the deliverable; Quinn's structured `tech_design` approval + Tom's sign-off (per task AC6: "Before merge") gate the PR. |
