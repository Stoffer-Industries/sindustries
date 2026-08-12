---
status: draft
task_id: 66054ab4-24e2-4cc6-9847-0faa4e94f041
product_spec: brain/tasks/specs/in-progress/task-blocked-by-escalation-owners-and-stacked-avatars-2026-08-05.md
shipped_pr: null
shipped_date: null
---

# Tech Design — Workflow-gate ownership, attention owners, and stacked task avatars

## Links and scope

- Product spec: `brain/tasks/specs/in-progress/task-blocked-by-escalation-owners-and-stacked-avatars-2026-08-05.md`
- Task: `66054ab4-24e2-4cc6-9847-0faa4e94f041`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-66054ab4-blocked-by-escalation-owners`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-66054ab4-blocked-by-escalation-owners`
- Primary surfaces: `services/tasks-api`, `apps/tasks`, `agents/skills/ops/tasks-api`, `docs/systems/tasks.md`

## Product summary

The revised spec defines five independent task concepts:

1. `Task.assignee` owns delivery.
2. `TaskDependency` represents task-to-task prerequisites.
3. `Task.blocked` remains the existing generic Blocked indicator.
4. Outstanding explicit workflow gates expose their configured owners and drive normal handoffs/discovery.
5. `TaskAttentionOwner` represents exceptional or unmodelled requests for attention, with context.

No concept silently derives from, replaces, clears, or duplicates another. Attention ownership is not blocked state and does not implement an incident lifecycle.

## Ownership boundary check

The Tasks API is the source of truth for attention-owner rows and workflow-gate ownership. Workflow-gate owners come from the required-approval policy plus current approval state; they are not copied into attention-owner rows. The Tasks app owns avatar composition and visual deduplication. `docs/systems/tasks.md` remains the durable cross-system documentation surface.

This durable API-backed shape is no harder than a UI-local shim and avoids duplicated ownership metadata. The implementation stays mergeable in two cuts: API/domain first, then UI, while retaining one task delivery branch/PR unless review risk warrants splitting.

## `.openclaw` boundary

No secrets, external services, cron changes, or OpenClaw runtime changes are required. The checked-in Tasks API client is updated in-repo. Incident detection/escalation remains explicitly out of scope.

## Data model

Add a first-class attention-owner join:

```prisma
model Task {
  // existing fields remain unchanged
  attentionOwners TaskAttentionOwner[]
}

model TaskAttentionOwner {
  id        String   @id @default(uuid()) @db.Uuid
  taskId    String   @db.Uuid
  owner     String
  addedBy   String?
  note      String?
  createdAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@unique([taskId, owner])
  @@index([owner])
  @@index([taskId, createdAt])
}
```

Each row means “this task needs exceptional attention from this owner.” `note` explains what needs attention. It does not mean the task is blocked. `Task.blocked`, dependencies, assignee, and approvals remain unchanged.

No data backfill is performed: automatically inferring attention owners from existing blocked tasks would violate the revised spec.

## Workflow-gate ownership

Required approval policy is the structured gate definition. For every required approval type, the API derives its gate state from the task’s approval rows:

- no approved row or a revoked row: gate is outstanding;
- approved row: gate is satisfied and no longer an outstanding handoff.

The gate owner comes from the approval row when present. For a never-created pending row, the required-approval contract must expose the configured owner alongside the approval type; this is the natural source of truth and avoids hard-coding `spec → Tom`, `tech_design → Quinn`, and `qa → Tom` in the UI.

Add a derived `workflowGates` response field:

```json
[
  { "type": "spec", "owner": "Tom", "state": "outstanding" },
  { "type": "tech_design", "owner": "Quinn", "state": "approved" }
]
```

Only `state: "outstanding"` entries drive discovery-queue handoffs and the workflow-gate avatar layer. No `TaskAttentionOwner` row is created for a gate-owned action.

## API contract

### Task response (additive)

```json
{
  "assignee": "Rowan",
  "blocked": true,
  "dependsOnIds": ["uuid"],
  "dependencyBlocked": true,
  "workflowGates": [
    { "type": "tech_design", "owner": "Quinn", "state": "outstanding" }
  ],
  "attentionOwners": ["Tom"],
  "attentionOwnerDetails": [
    { "id": "uuid", "owner": "Tom", "addedBy": "Rowan", "note": "Unexpected production access issue", "createdAt": "..." }
  ]
}
```

Do not add `hasAttentionOwners`, `genericBlocked`, or any derived blocked field: those invite callers to infer blocked state from attention ownership. Existing `blocked` and `dependencyBlocked` semantics remain authoritative and unchanged.

### PATCH `/tasks/:id`

Accept `attentionOwners` as a full-replacement array. Omission means no change; `[]` clears all generic attention requests only. Validate non-empty strings, deduplicate case-insensitively, cap owner length at 64 and rows at 16. Preserve each surviving row’s note. A detail-level add/update endpoint may set `note` and `addedBy`; bulk replacement must not silently discard surviving context.

Clearing one or all rows never updates `blocked`, dependencies, assignee, approvals, or workflow transitions.

### GET `/tasks` discovery filters

- `?workflowGateOwner=Quinn` returns tasks with an outstanding explicit gate owned by Quinn.
- `?attentionOwner=Tom` returns tasks with exceptional attention requested from Tom.

Normal discovery defaults to workflow-gate ownership. Attention ownership is a separate filter/signal, not a substitute for normal gate work and not an incident queue.

### Tasks API client

Add explicit list filters and patch flags:

- `list --workflow-gate-owner OWNER`
- `list --attention-owner OWNER`
- `patch --attention-owners OWNER...`
- `patch --clear-attention-owners`

## UI behavior

### Task cards

Render one visually deduplicated avatar stack in this responsibility order:

1. delivery assignee;
2. outstanding workflow-gate owners;
3. attention owners.

When one person has multiple roles, render one avatar but include all roles in its accessible label. Stable ordering within gate owners follows required-gate policy order; attention owners follow insertion order.

Example accessible group label: `Delivery: Rowan; workflow gate: Quinn for tech design; exceptional attention: Tom.`

The existing Blocked badge and dependency UI remain unchanged and can appear with zero attention owners.

### Task details/editor

Use a clearly named “Attention needed from” editor, not “Blocked by.” Show each owner’s context note and added-by metadata. Display separate sections for delivery owner, outstanding workflow gates, dependencies, existing Blocked state, and exceptional attention requests.

Removing one attention owner removes only that row. Removing all rows leaves every other task field untouched.

### Discovery queue

The normal handoff view queries `workflowGateOwner=<self>`. Exceptional attention requests are exposed separately via `attentionOwner=<self>` and visually labelled as exceptional/unmodelled. The UI must not generate an attention request when an explicit gate already represents the action.

## Implementation plan

1. Rename the initial `TaskBlockedBy` foundation to `TaskAttentionOwner`; remove blocked-derived mapper fields.
2. Extend required-approval policy responses with configured gate owners and derive `workflowGates` per task.
3. Add attention-owner validation, persistence, PATCH semantics, and independent list filtering.
4. Add workflow-gate-owner discovery filtering without materializing duplicate rows.
5. Extend the Tasks API client and tests.
6. Build the ordered, role-aware avatar stack and separate detail/editor sections.
7. Update `apps/tasks/SPEC.md` and `docs/systems/tasks.md`.

## AC verification matrix

| AC | Verification |
| --- | --- |
| AC1 | API integration test creates assignee, dependency, `blocked=true`, outstanding gate, and multiple attention owners together; changing each plane leaves the others unchanged. |
| AC2 | API tests cover zero/one/many attention owners, context retention, removing one row, and clearing all rows without changing blocked state. |
| AC3 | Policy/route tests derive outstanding gate owners and `?workflowGateOwner=` results; assert no attention row is created for a gate handoff. |
| AC4 | API and detail-component tests distinguish `workflowGates` from `attentionOwners` and preserve attention context as future incident input without lifecycle behavior. |
| AC5 | Component/E2E tests assert avatar order, visual deduplication, and multi-role accessible labels. |
| AC6 | Detail/component tests assert separate delivery, workflow-gate, and exceptional-attention labels and context. |
| AC7 | Regression tests assert dependencies and Blocked badge remain visible with zero attention owners and with an outstanding gate. |
| AC8 | API tests remove one/all attention owners and assert approvals, dependencies, assignee, and `blocked` are byte-for-byte unchanged. |

Validation gates: Tasks API unit/integration tests, Prisma validation/migration checks, Tasks app component tests, focused Playwright flow, Tasks API client pytest, and system/app spec inspection.

## Risks and decisions

- Required-gate policy currently exposes approval types; deriving pending owners may require extending that contract. This is preferable to hard-coded UI ownership.
- Free-form attention-owner names mirror `Task.assignee`; unknown users may lack avatars but remain valid API data.
- Visual deduplication must retain multiple semantic roles in accessibility/detail text.
- The previous design and commit incorrectly modelled attention owners as `blockedBy` and derived blocked semantics from them. Those names and derived fields must be removed before route/UI work continues.
- The revised spec approval is currently revoked and the prior tech-design approval predates the revision. Implementation should not proceed beyond reconciling this foundation until Tom re-approves the spec and Quinn approves this revised design.


## WS5 revision — Lobster-owned active workflow handoffs (2026-08-12)

The original WS1 derived every missing required approval as an outstanding `workflowGate`. That made future gates appear actionable too early—for example, the QA owner appeared while a task was still in `doing`. The Tasks API cannot correct this by inspecting task status without duplicating Lobster lifecycle rules.

### Source-of-truth correction

- `TaskApproval` remains the durable record of required, approved, and revoked gates.
- Lobster becomes the sole authority for the handoff currently blocking its next transition.
- The task stores one optional `activeWorkflowHandoff` carrying a stable role ID, gate ID, and human-readable reason.
- Lobster sets the handoff when a gate blocks, clears it when the gate passes, and replaces it when a later gate becomes active.
- The Tasks API validates and persists the handoff but does not derive it from status or approvals.
- The Tasks app renders the API result and contains no lifecycle-state rules.

### Global role vocabulary

Lobster writes stable role IDs, never names:

- `product_spec_approver`
- `tech_design_approver`
- `qa_verifier`

The centrally loaded Tasks API policy resolves these roles to current owners. Defaults remain Tom, Quinn, and Tom respectively. Changing a role holder therefore requires configuration, not a Rust workflow change. Unknown roles fail closed rather than being guessed or displayed as people.

### API projection and compatibility

The public `workflowGates` array remains as the compatibility projection consumed by the existing UI, but contains at most the explicitly active handoff. `?workflowGateOwner=<owner>` filters by the stored role after resolving that role through central policy. Approved and future `TaskApproval` rows do not create discovery results or avatars.

### Transition semantics

| Lobster gate | Active role while blocked | On success |
|---|---|---|
| Feature spec check | `product_spec_approver` | clear |
| Feature/code tech-design check | `tech_design_approver` | clear |
| Delivery/PR verification | none; assignee remains delivery owner | clear |
| Post-merge QA verification | `qa_verifier` | clear on `done` |

Direct recovery transitions use the same rule: reverting to `acceptance` for missing QA sets `qa_verifier`; reverting to `doing` for uncovered ACs clears QA because implementation is again the active responsibility.

### WS5 validation

- Tasks API tests: explicit handoff persistence, validation, role resolution, owner filtering, and independence from `TaskApproval`.
- Rust tests: blocked gates write the correct role ID; successful transitions clear stale handoffs; dry-run performs no write; reruns repair stale state.
- Tasks app tests: stacked avatars consume only the projected active handoff and do not infer future gates.
