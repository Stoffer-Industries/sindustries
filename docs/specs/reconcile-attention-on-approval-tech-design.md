---
status: draft
task_id: 45a759ac-8e0d-40f7-8d07-590149dc8643
product_spec: n/a (Tasks API/workflow contract internal change)
shipped_pr: null
shipped_date: null
---

# Reconcile workflow attention owner immediately when approval is recorded — Tech Design

## Links

- Task: `45a759ac-8e0d-40f7-8d07-590149dc8643` (`Reconcile workflow attention owner immediately when approval is recorded`)
- Task API: `http://localhost:4001/api/v1/tasks/45a759ac-8e0d-40f7-8d07-590149dc8643`
- Closely related: task `e67c8835` (`Fix lobster attentionOwners reconciliation draining doing-status tasks to []`) — merged lobster-side fix that stops unintended draining; this task is the complementary **API-side synchronous write** that closes the UI/routing lag window before the next lobster sweep.
- Wider programme: task `3caabf49` (`attention-control-plane`) — ongoing broader restructuring of the attention-owner control plane; out of scope here, but the design below slots into the same data model without conflict.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-45a759ac-reconcile-attention-on-approval` (from `origin/main`)
- Worktree: `~/workspace/worktrees/task-45a759ac-reconcile-attention-on-approval`
- Primary code surfaces:
  - `services/tasks-api/src/config/workflowHandoffs.ts` — add an `APPROVAL_ATTENTION_OWNERS` map and a small helper `attentionOwnerForApproval(type)`.
  - `services/tasks-api/src/routes/taskApprovals.ts` — extend `approvalHandoffUpdate` (or add a sibling helper) to compute the desired `attentionOwners` delta; apply it in the same `$transaction` as the `TaskApproval` upsert/update, in both `POST /tasks/:id/approvals` and `DELETE /tasks/:id/approvals/:type`.
  - `services/tasks-api/test/taskApprovals.test.ts` — new tests covering AC1, AC2, AC3 (atomicity, slot preservation, idempotency, no-premature-done, other-approval-types-untouched).
- One drive-by fix in the same file: the `INVALID_APPROVAL_TYPE` error message in `taskApprovals.ts` line ~92 still says `"spec, tech_design, qa"` while `validApprovalTypes` in `services/tasks-api/src/routes/tasks/_constants.ts` now includes `qa_agent` and `accepted`. Update the message to match the canonical set so 400 responses stop misleading clients.
- No lobster (Rust) changes. The lobster's `reconcile_workflow_attention` continues to run on every stage call and periodic sweep; this task is additive and makes the head-slot removal observable immediately instead of after the next sweep.
- No `.openclaw` boundary work — pure Tasks API code.

## Product intent (one-paragraph)

`attentionOwners` is the ordered action/escalation stack the Tasks API exposes; position 0 is the currently actionable owner, and the heartbeat queue, Tom's `WAITING_EXTERNAL` filter, the mission-control UI, and the lobster's `verify_delivery` stage all read it to decide what to surface. Today, when a structured workflow approval lands (`POST /tasks/:id/approvals` for `spec`, `tech_design`, `qa_agent`, or `accepted`), the API only writes `Task.workflowHandoffRoleId/Gate/Reason` — a single-slot field — and the ordered `attentionOwners[]` array is only updated by the lobster's `reconcile_workflow_attention` on its next stage call or periodic sweep. That sweep lag produces a window where, e.g., Tom has just signed `accepted` on a task in `acceptance` but Tom is still listed at the actionable head until the next sweep, so the queue still flags the task as `WAITING_EXTERNAL` for Tom and other surfaces double-render. The fix is to add a narrow synchronous write inside the existing approval transaction: when the recorded approval's attention-owner (Tom for `spec`/`accepted`, Quinn for `tech_design`, Ash for `qa_agent`) matches the current head and the action is `approved`, remove that single head entry and preserve everything else; symmetrically, when the action is `revoked` and the owner is missing, prepend them back. The API does **not** touch `task.status` and does **not** mark the task done — the lobster still owns lifecycle transitions on its next stage call, which preserves its final-validation contract.

## Ownership boundary check

The natural source of truth for `attentionOwners` is the **API-owned contract** (it's a Prisma-backed field on `Task`, surfaced via `services/tasks-api`). The lobster consumes it but does not own it; the previous draining bug (`e67c8835`) was fixed in the lobster because the lobster was the only writer that mutated the array asynchronously. After this change, the API becomes the synchronous writer for the head-slot removal/re-add path; the lobster remains the asynchronous writer for the broader reconciliation (state-driven head replacement, assignee alignment, duplicate-tail preservation). Both writers share the same Prisma `TaskAttentionOwner` table — there is no second source of truth. The lobster's `reconciled_attention_owners` function reads `Task.attentionOwners` plus `TaskApproval` rows; its `else`-branch (`owners.remove(0)` when the head's `managed_owner_reason_satisfied`) is now a defensive idempotent guard, not the primary writer for that case.

To keep these two writers from drifting, the design **extracts the per-approval owner mapping into the API config** (`APPROVAL_ATTENTION_OWNERS`), and the lobster continues to read the `TaskApproval` rows directly (the type field is already authoritative there — no new shared package or enum duplication). The helper that computes "what head slot does this approval type's owner occupy" lives in `services/tasks-api/src/config/workflowHandoffs.ts` next to the existing `workflowHandoffForApproval(type)` so a future reviewer can audit both writers in the same file. No TS/Rust cross-language helper is needed because the Rust side already keys on the structured `TaskApproval.type` field; the only "knowledge" that needs to stay aligned is the four-entry owner table, which is small enough to verify by inspection and by the lobster's existing `routing_*` tests.

Rowan's incremental-delivery posture: the durable fix is about as easy as any interim shim (a small helper plus four route-layer call sites plus tests). No interim shim is needed; design the final shape directly.

## Implementation plan

### Change 1 — add the approval-type → attention-owner map

In `services/tasks-api/src/config/workflowHandoffs.ts`, add:

```ts
/**
 * Map a structured approval type to the attention-owner role that the
 * lobster (and the heartbeat queue, MC UI, etc.) treat as the head when
 * this approval is the active gate. The lobster already encodes the same
 * mapping in `workflow_attention_owner` (Rust) keyed on TaskApproval rows;
 * keeping a small TS mirror here is preferable to a cross-language helper
 * because the mapping is one entry per approval type and easy to audit.
 *
 * Distinct from `APPROVAL_WORKFLOW_HANDOFFS`, which clears the single-slot
 * `task.workflowHandoffRoleId/Gate/Reason` on approval; this map drives the
 * ordered `attentionOwners[]` head-slot routing on the same write. Both
 * writers stay in the same $transaction so a single approval lands
 * atomically across both fields.
 */
export const APPROVAL_ATTENTION_OWNERS = {
  spec: 'Tom',         // product_spec_approver — Tom
  tech_design: 'Quinn', // tech_design_approver — Quinn
  qa_agent: 'Ash',      // Ash's mechanical verification gate
  accepted: 'Tom'       // Tom's final human sign-off
} as const satisfies Record<string, string>;

export type ApprovalAttentionType = keyof typeof APPROVAL_ATTENTION_OWNERS;

export function attentionOwnerForApproval(type: string): string | null {
  return APPROVAL_ATTENTION_OWNERS[type as ApprovalAttentionType] ?? null;
}
```

Notes:
- The keys mirror `validApprovalTypes` in `services/tasks-api/src/routes/tasks/_constants.ts` (`spec`, `tech_design`, `qa_agent`, `accepted`).
- `accepted` is intentionally mapped to **Tom**, not the existing `qa_verifier` role id, because the user's task AC2 names Tom explicitly and the lobster's `accepted_structured` predicate also keys on the `accepted` TaskApproval row's owner being Tom.

### Change 2 — extend the per-approval attentionOwners helper

In `services/tasks-api/src/routes/taskApprovals.ts`, alongside the existing `approvalHandoffUpdate` helper, add:

```ts
type AttentionOwnersAction = 'approved' | 'revoked';

/**
 * Compute the desired `attentionOwners[]` array after a structured approval
 * write, mirroring the lobster's `reconciled_attention_owners` else-branch
 * for the head-slot-pop / head-slot-prepend path. Returns:
 *   - `null` when the approval type has no attention-owner mapping, when the
 *     current head is unrelated (e.g. the assignee is at position 0 and the
 *     just-recorded approval satisfies a different gate), or when no change
 *     is needed (idempotent). The caller treats `null` as "leave the array
 *     alone; let the lobster's next sweep handle the broader reconciliation."
 *   - The new array otherwise. The caller MUST apply it via the same
 *     Prisma transaction that wrote the TaskApproval row, so a single
 *     approval lands atomically across both fields.
 *
 * Behaviour:
 *   - approved + head matches type's owner → remove the head (single pop).
 *     Tail slots (including duplicates) are preserved byte-for-byte.
 *   - revoked + head does NOT match type's owner (and owner is absent) →
 *     prepend the owner. This keeps the gate-owner on the routing stack
 *     while their gate is open.
 *   - revoked + head already matches → no-op (idempotent).
 *   - anything else (head doesn't match on approve, owner already present on
 *     revoke, no owner for this type) → null.
 *
 * Case-insensitive comparison mirrors the lobster's `eq_ignore_ascii_case`
 * so a task created with `"tom"` at the head behaves identically to `"Tom"`.
 */
function attentionOwnersForApproval(
  current: string[],
  type: ApprovalType,
  action: AttentionOwnersAction
): string[] | null {
  const owner = attentionOwnerForApproval(type);
  if (!owner) return null;
  const head = current[0];
  const matchesHead = head !== undefined
    && head.trim().toLowerCase() === owner.toLowerCase();
  if (action === 'approved') {
    return matchesHead ? current.slice(1) : null;
  }
  // action === 'revoked'
  if (matchesHead) return null;
  if (current.some((o) => o.trim().toLowerCase() === owner.toLowerCase())) return null;
  return [owner, ...current];
}
```

Then refactor `approvalHandoffUpdate` to **also return the attentionOwners delta** in the same shape, so the route handlers apply both writes via a single `tx.task.update` call:

```ts
type HandoffUpdate = {
  workflowHandoffRoleId?: string | null;
  workflowHandoffGate?: string | null;
  workflowHandoffReason?: string | null;
  attentionOwners?: string[];
};

function approvalHandoffUpdate(task, type, action) {
  const handoff = workflowHandoffForApproval(type);
  const attentionOwners = attentionOwnersForApproval(
    (task.attentionOwners ?? []).map((row) => row.owner),
    type,
    action
  );
  const update: HandoffUpdate = {};
  if (handoff) {
    if (action === 'approved') {
      if (task.workflowHandoffGate !== type) {
        // No handoff state to clear; still allow attentionOwners update.
      } else {
        update.workflowHandoffRoleId = null;
        update.workflowHandoffGate = null;
        update.workflowHandoffReason = null;
      }
    } else {
      const required = requiredApprovalsFor(loadRequiredApprovalsConfig(), task.taskType);
      if (required.includes(type)) {
        update.workflowHandoffRoleId = handoff.roleId;
        update.workflowHandoffGate = type;
        update.workflowHandoffReason = handoff.reason;
      }
    }
  }
  if (attentionOwners) update.attentionOwners = attentionOwners;
  return Object.keys(update).length > 0 ? update : null;
}
```

Note: `approvalHandoffUpdate` already returns `null` when no write is needed; callers already handle that branch with `if (handoffUpdate) await tx.task.update(...)`. No call-site branching needs to change beyond extending the update object's accepted keys — and the task PATCH endpoint (`routes/tasks.ts` lines 538–619) already accepts `attentionOwners` as a full-replacement array, so the same `tx.task.update({ data: { ..., attentionOwners: desired } })` call works. The Prisma update path through the existing `tx.task.update` is the durable write; no new table, no migration.

### Change 3 — fix the stale approval-type error message

In `services/tasks-api/src/routes/taskApprovals.ts`, the `badRequest` text on the type-validation branch (line ~92) currently reads:

```ts
return badRequest(res, 'INVALID_APPROVAL_TYPE', 'type must be one of: spec, tech_design, qa');
```

Replace with:

```ts
return badRequest(res, 'INVALID_APPROVAL_TYPE', `type must be one of: ${Array.from(validApprovalTypes).sort().join(', ')}`);
```

This is a one-line drive-by fix that prevents a `qa_agent` or `accepted` POST from misleading the client with a stale vocabulary. It is in scope because the same approval type that the new `APPROVAL_ATTENTION_OWNERS` map keys on is what this error message advertises; otherwise the doc and the runtime message would disagree on day one.

### Change 4 — tests

Extend `services/tasks-api/test/taskApprovals.test.ts` (and add a sibling file `services/tasks-api/test/approvalAttentionOwners.test.ts` if the surface grows). The mock harness at the top of `taskApprovals.test.ts` already provides a working `prismaMock` and `activeTask` fixture; extend `activeTask` to include `attentionOwners` rows so the helper can read them.

Test matrix (all rows target AC1/AC2/AC3):

| Test | Setup | Action | Expected `attentionOwners` | AC |
| --- | --- | --- | --- | --- |
| `approval_approved_with_owner_at_head_removes_head_preserves_tail` | attentionOwners `[{owner:"Quinn",position:0},{owner:"Rowan",position:1},{owner:"Tom",position:2}]`, task in `ready`, handoff gate `tech_design` | POST `tech_design` approved by Quinn | `[Rowan, Tom]` | AC1 |
| `approval_approved_with_unrelated_head_is_a_noop_on_attention_owners` | head `Rowan` (assignee), no handoff gate | POST `tech_design` approved by Quinn | unchanged `[Rowan, …]` | AC1 (negative), AC3 |
| `approval_accepted_by_tom_removes_tom_in_acceptance_without_status_change` | head `Tom`, task in `acceptance`, handoff gate `accepted` | POST `accepted` approved by Tom | `[…tail]`; task.status still `acceptance` | AC2, AC3 (no-premature-done) |
| `approval_idempotent_when_replayed_with_same_owner_and_note` | prior approval already `approved` by same actor with same note | POST again | attentionOwners after first call preserved on the second | AC3 (idempotency) |
| `approval_other_types_unaffected_when_only_qa_agent_handoff_matches` | head `Quinn`, gate `tech_design` | POST `qa_agent` approved by Ash | attentionOwners unchanged (Quinn is not Ash) | AC3 (other types retain handoff behaviour) |
| `approval_revoked_re_adds_owner_when_absent` | head `Rowan`, gate `qa_agent`, attentionOwners `[Rowan]` | DELETE `qa_agent` | `[Ash, Rowan]` | AC1 (symmetric), AC3 (atomicity) |
| `approval_revoked_is_noop_when_owner_already_at_head` | head `Tom`, gate `accepted` | DELETE `accepted` | unchanged `[Tom, …]` | AC3 (idempotency) |
| `approval_unknown_type_does_not_touch_attention_owners` | POST with a type not in `APPROVAL_ATTENTION_OWNERS` (defensive — should be 400 already, but cover the path) | n/a | attentionOwners unchanged, 400 returned | AC3 |

The Prisma mock's `prismaMock.task.update` should assert that the call's `data` includes the expected `attentionOwners` array AND that no `status` field is included (the no-premature-done check). This is a one-line assertion: `expect(updateArgs.data).not.toHaveProperty('status')`.

Test layer rationale: TypeScript route integration tests with a Prisma mock are the durable layer for this surface — they exercise the actual `taskApprovals.ts` route handler, the actual `approvalHandoffUpdate` body, and the same Prisma update shape the live API uses. E2E is not appropriate: the change is internal routing/state-coherence with no user-visible flow (a heartbeat queue operator would not see any UI difference; only the timing of when Tom's name disappears from `attentionOwners[0]` changes).

### Change 5 — no system-doc / app-spec update needed

- `docs/systems/tasks.md` already describes `attentionOwners` and `TaskApproval` routing. The new behaviour (synchronous write inside the existing transaction) does not change the wire shape, the data model, or the lifecycle state machine; it changes only the timing of when the head slot disappears. A short note can be appended in the PR description if Quinn wants it, but a system-doc edit is not strictly required.
- `apps/tasks/SPEC.md` describes user-visible flows; this change is not user-visible. No edit required.

## Data model / API contract changes

None. The Prisma `Task` model already has `attentionOwners: TaskAttentionOwner[]` (ordered by `position`); the API already accepts `attentionOwners: string[]` as a full-replacement field on `PATCH /tasks/:id`; the route handlers in `taskApprovals.ts` already run inside `prisma.$transaction`. The new behaviour is purely additive within that transaction.

## Workflow / cron / skill changes

None. No new task comment tags, no new structured approval types, no new workflow gates, no cron changes, no skill changes. The lobster still drives `doing → acceptance` on `qa_agent_verified` and `acceptance → done` on `accepted_structured`. The only observable change is timing: the head-slot removal happens inside the approval POST transaction instead of waiting for the lobster's next sweep.

## Test plan (AC matrix)

| AC | Layer | Coverage | Rationale |
| --- | --- | --- | --- |
| AC1 — approved gate matches head owner at position 0, sync remove only that satisfied head slot, preserve unrelated/tail slots | TS route integration (`services/tasks-api/test/taskApprovals.test.ts`) | `approval_approved_with_owner_at_head_removes_head_preserves_tail` (positive), `approval_approved_with_unrelated_head_is_a_noop_on_attention_owners` (negative), `approval_unknown_type_does_not_touch_attention_owners` (defensive) | The behaviour is pure logic over the `Task` shape inside the route handler; the existing Prisma-mock supertest harness is the durable layer. |
| AC2 — Tom's `accepted` approval in `acceptance` removes Tom from position 0, no `task.status` change, lobster's acceptance-to-done checks still own the transition | TS route integration | `approval_accepted_by_tom_removes_tom_in_acceptance_without_status_change` (asserts attentionOwners after, and asserts `tx.task.update` data does NOT include `status`) | The "no premature done" guarantee is the load-bearing one for AC2; the negative `status` assertion makes any regression fail loudly. |
| AC3 — idempotent retries, other approval types retain existing handoff behaviour, tests cover atomicity, slot preservation, no-premature-done | TS route integration | `approval_idempotent_when_replayed_with_same_owner_and_note`, `approval_other_types_unaffected_when_only_qa_agent_handoff_matches`, `approval_revoked_re_adds_owner_when_absent`, `approval_revoked_is_noop_when_owner_already_at_head`, plus the same Prisma-mock harness that already asserts `tx.task.update` is called inside `prisma.$transaction` | Each AC3 sub-clause maps to one test row above; idempotency uses the same `existing?.state === 'approved' && existing.owner === actor && existing.note === note` branch the existing tests already cover, just with the new `attentionOwners` payload asserted. |

## Open questions and risks

1. **Does `attentionOwnersForApproval` need to also handle the assignee being a managed owner?** No. The lobster's `reconciled_attention_owners` has a `Some(desired)` arm that handles the case where the workflow wants a different owner at the head; the API path here only fires when the head already matches the approval type's owner. If the head is the assignee (e.g. `Rowan` doing implementation) and Quinn records `tech_design` approval, `matchesHead` is false → `null` → no API write. The lobster's next sweep will see the structured approval and `workflow_attention_owner` will compute the right head. That is the correct fallback.
2. **Does the revoke path create a duplicate head?** No. `attentionOwnersForApproval` checks `current.some((o) => o.trim().toLowerCase() === owner.toLowerCase())` before prepending; if the owner is already anywhere in the array (not just position 0), revoke is a no-op. This matches the lobster's "don't deduplicate" rule — each entry is a role slot — by leaving existing rows alone.
3. **Race with the lobster sweep?** Both the API and the lobster wrap their writes in `prisma.$transaction`. The API path's `tx.task.update` reads `attentionOwners` from `tx.task.findUnique` inside the same transaction, so a concurrent sweep's write either lands before the API tx starts (the API tx reads the swept value) or after the API tx commits (the next sweep sees the API-written value). The race is benign because both writers converge on the same desired state for the (head matches owner) case.
4. **Should the API also set `topAttentionOwner`?** No — `topAttentionOwner` is computed in the mapper (`_mapper.ts` line ~183) from `attentionOwners[0]`. It's not a stored field; nothing to write.
5. **The `qa` key in the existing `APPROVAL_WORKFLOW_HANDOFFS` map.** That key is stale (the actual API uses `qa_agent` and `accepted`), but it is referenced only inside `workflowHandoffForApproval(type)` for the `workflowHandoffRoleId` lifecycle field. Leaving it alone preserves existing behaviour; the new `APPROVAL_ATTENTION_OWNERS` map keys on the real API types. Future cleanup of the stale `qa` key is out of scope.
6. **Will this change interact with the lobster's `managed_owner_reason_satisfied` (post-`e67c8835`)?** No. The lobster's predicate still fires on its next sweep; with the API already having removed the head, the sweep's `else`-branch is a no-op (the head slot is already gone or doesn't match a managed owner). The lobster's `Some(desired)` arm handles unrelated heads (e.g. the assignee) as before. The two writers converge.
7. **Atomicity guarantee.** The Prisma `$transaction` body already wraps the approval upsert, the `tx.task.update`, and the audit `tx.taskComment.create`. The new `attentionOwners` write piggybacks on the existing `tx.task.update` call (single statement), so there is no new atomicity boundary to verify — it inherits the existing one.

## Definition of done

- [ ] `APPROVAL_ATTENTION_OWNERS` and `attentionOwnerForApproval` added to `services/tasks-api/src/config/workflowHandoffs.ts` with the four-entry map and a doc comment distinguishing it from the existing `APPROVAL_WORKFLOW_HANDOFFS`.
- [ ] `attentionOwnersForApproval` helper added to `services/tasks-api/src/routes/taskApprovals.ts`; `approvalHandoffUpdate` extended to return both the workflowHandoff delta and the attentionOwners delta in a single object, applied via one `tx.task.update` call inside the existing `$transaction` body in both `POST /tasks/:id/approvals` and `DELETE /tasks/:id/approvals/:type`.
- [ ] Stale `INVALID_APPROVAL_TYPE` message replaced with a `validApprovalTypes`-derived string.
- [ ] At least the eight tests in Change 4 added to `services/tasks-api/test/taskApprovals.test.ts`, with the no-`status`-on-update assertion in the AC2 row.
- [ ] `pnpm --filter tasks-api test` is green locally and in CI.
- [ ] PR opened from `task-45a759ac-reconcile-attention-on-approval` with this tech design linked in the PR body.
- [ ] PR body does **not** include a `- [x] AC<N>: ...` checklist for any AC until implementation lands — the lobster would treat a merged docs-only PR's checklist as implementation coverage and create a false signal. The AC verification matrix lives only in this doc and in the new test names.
- [ ] On merge, frontmatter is updated to `status: shipped`, `shipped_pr: <N>`, `shipped_date: <YYYY-MM-DD>`.
