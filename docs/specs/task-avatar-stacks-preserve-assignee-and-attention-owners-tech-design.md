---
status: draft
task_id: 479d76f8-9f70-4ffc-b6e4-9a0d5058dd9e
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Task avatar stacks — preserve assignee and attention owners

## Product intent

`apps/tasks` renders a stacked avatar group on every task card so reviewers can
see, at a glance, **who owns the work** (delivery assignee) and **who currently
needs to act on it** (attention owners, ordered). Each plane is a separate
ordered role — the assignee is the durable shipping owner, the attention stack
is the escalating action surface. Collapsing them removes the assignee from
view whenever the same person is also blocking the task, which hides the
shipping ownership signal that `TaskCardSummary` is supposed to surface
alongside the attention escalation.

`apps/tasks/SPEC.md` section 11.3 already states: *"Every role slot remains
visible, including repeated people. Stable keys combine role, position, and a
case-insensitive trimmed owner string; duplicates are never collapsed because
order communicates escalation."* The current `StackedAvatarGroup.jsx`
implementation deviates from that contract: the `buildStackedOwnerLayers` helper
contains a cross-role collapse pass that drops the delivery entry whenever the
same owner also appears in the attention stack, replacing it with a single
attention avatar. This task brings the code back into line with the documented
contract, restores the assignee-on-the-card signal, and locks the contract with
explicit unit tests so the regression cannot reappear.

The recently-shipped "top-of-stack on top" change (task `61716ab6`, PR #? in
the avatar-z-order series) stays intact: the rightmost visual child is still
position-0 attention owner, z-index math is still anchored to the original
logical order, and the render-order flip is unchanged. This change only edits
the per-slot key strategy and the `buildStackedOwnerLayers` collapse pass.

## Task ID, branch, worktree, repo

- **Task ID:** `479d76f8-9f70-4ffc-b6e4-9a0d5058dd9e`
- **Branch:** `task-479d76f8-avatar-stacks-preserve-roles`
- **Worktree:** `/Volumes/WD1/worktrees/quinn/task-479d76f8-avatar-stacks-preserve-roles`
- **Canonical checkout:** `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries` (untouched, stays on `main`)
- **Repo:** `Stoffer-Industries/sindustries`
- **App:** `apps/tasks` (UI-only; no backend or shared-package change)
- **No `.openclaw` boundary work** is required for this task. The
  `agent_task_queue.py` heartbeat wiring is already in place; no skill or
  workspace doc change is needed.

## Implementation plan

### Files in scope

| Path | Change |
|---|---|
| `apps/tasks/src/components/StackedAvatarGroup.jsx` | Remove cross-role collapse; emit every role slot unchanged; document the new behaviour in the function-level JSDoc. |
| `apps/tasks/src/components/StackedAvatarGroup.test.jsx` | Update affected unit tests; add new cases for combined ownership, repeated identities across roles, and the "no collapse" contract. |
| `apps/tasks/SPEC.md` | Section 11.3 — clarify that *no* collapse happens (already documents the contract, but tighten the wording to match the implementation). |
| `docs/systems/tasks.md` | If the system doc currently describes the cross-role collapse, remove that sentence so the system doc matches the code. Verify on first edit; skip if it is already correct. |

No other files in `apps/tasks` consume the cross-role collapse behaviour.
`TaskCardSummary` calls `StackedAvatarGroup` and treats its output as
informational; the single-assignee `Avatar` in `TaskCardSummary` is preserved
separately for backward compatibility and is not part of this change. No new
CSS, no new component, no new exports.

### `buildStackedOwnerLayers` — concrete edit

1. **Drop the cross-role collapse block.** Delete the post-layer
   `seenAcrossTiers` / `ROLE_TIER` loop in `buildStackedOwnerLayers`. Every
   layer entry (attention, workflow-gate, delivery) is appended to `layers`
   exactly once, in the order they were built. The function returns
   `{ entries: layers }`.
2. **Keep the intra-tier repeat.** Attention repeats like
   `attentionOwners: ['Rowan', 'Rowan', 'Tom']` continue to render three
   attention slots, each with its own `slot` and `key`. This was already
   correct and is what the new AC1/AC2 require. No edit needed there.
3. **Per-slot keys stay the same** — `attention:<slot>:<owner>`,
   `workflow-gate:<gateIndex>:<owner>`, `delivery:<owner>`. Cross-role
   duplicates therefore render as two distinct entries (e.g. an attention
   slot and a delivery slot for the same owner both appear), which is the
   correct behaviour for AC1.
4. **JSDoc rewrite.** Replace the `AC4 cross-role collapse` paragraphs
   inside the function-level comment with a short paragraph stating that
   every role slot is rendered, including repeated people and cross-role
   repeats, and pointing the reader at `apps/tasks/SPEC.md` section 11.3
   for the source of truth. Keep the existing note that the pure helper
   contract is anchored to the logical escalation order (the render-order
   flip is unchanged).

### `StackedAvatarGroup` render — concrete edit

1. **No render-path change.** The component continues to reverse the
   logical escalation order at the render boundary so position-0 attention
   is rightmost, and continues to compute z-index from the original
   `entries` order. Because the helper now returns one entry per role slot,
   the visible count for a `Rowan`-only task grows from 1 → 2 (attention
   `Rowan` + delivery `Rowan`). For `attentionOwners: ['Rowan', 'Rowan',
   'Tom']` + `assignee: 'Quinn'`, the count grows from 3 → 4 (the previous
   code collapsed the first attention `Rowan` against the delivery `Quinn`
   and dropped Quinn's delivery slot; the new code keeps all four).
2. **No `maxVisible`/overflow change.** `maxVisible` stays at 4; the
   overflow chip keeps saying "N more owners" with the same singular /
   plural rule. The `data-owner-key` attribute continues to be the
   authoritative identity for analytics and the task-details surface.
3. **No accessibility change.** The per-slot `aria-label` keeps using
   `roleLabel(entry.role)` and the per-row note excerpt for attention
   rows. The container `aria-label` keeps listing every visible owner in
   the same wording. Repeated names render as repeated `aria-label` rows
   (`'attention owner Rowan'` × 2 + `'delivery assignee Rowan'`), which is
   what AC2 wants and what assistive technology already announces from the
   per-slot labels.
4. **z-index math stays anchored to the logical order.** `sameRoleEntries`
   continues to be computed against the un-reversed `visible` array, and
   `roleZIndex = roleDepth + sameRoleEntries.length - roleIndex - 1` is
   unchanged. The render-order flip does not affect z-index, so the
   top-of-stack-on-top contract from `61716ab6` is preserved.

### Files I will *not* touch

- `apps/tasks/src/components/TaskCardSummary.jsx` — the parent already
  passes the whole `task` object to `StackedAvatarGroup`; no API change.
- `apps/tasks/src/components/AttentionOwnersPanel.jsx` — the editor panel
  for attention rows is unrelated to the card render. Its data path
  (separate `attentionOwnerDetails` array) is unchanged.
- `apps/tasks/src/users/assignees.js` — `findAssigneeUser` and
  `assigneeDisplayName` already use the un-normalised `owner` string per
  the SPEC. No change.
- `apps/tasks/src/styles/task.css` — the existing `.task-owner-stack` flex
  layout already handles a variable number of avatars (the negative
  margin trick). The two-avatar same-name case is already covered by the
  z-index logic, no new CSS.

## Service boundary and data ownership

The stacked avatar group is a presentation-only component inside `apps/tasks`.
There is no API, no shared package, no cross-app consumer, and no
`services/` change. The "natural source of truth" for the role tiers is the
task payload the API already returns — `assignee` (single string),
`workflowGates` (derived view), `attentionOwners` (ordered string array),
`attentionOwnerDetails` (audit rows). All four are produced by the
`services/tasks-api` mapper; no mapper change is required because the data
is already in the right shape. The fix is a UI-only contract enforcement
to match the SPEC.

No new database column, no new migration, no new endpoint. The PR is a
single-component behaviour change plus test updates and a one-paragraph
SPEC.md tightening.

## Data model and API contract changes

None. The mapper output is already correct; only the render path was
diverging from the contract.

## Workflow, cron, and skill changes

None. The change does not touch the agent loop, the tasks API, or the
`.openclaw` workspace.

## Test plan

The acceptance-criterion verification matrix below is the contract this
PR must satisfy. Every AC has a primary assertion path (the layer it
exercises in the test pyramid) and a fallback path if that layer turns
out to be flaky in the worktree test setup.

| AC | What it asserts | Primary test layer | Fallback / notes |
|---|---|---|---|
| **AC1** | A task with an assignee and attention owners renders the assignee first, followed by every attention-owner slot. | `apps/tasks/src/components/StackedAvatarGroup.test.jsx` — pure-function assertion on `buildStackedOwnerLayers` + DOM-order assertion on the rendered component. | If jsdom `Avatar` rendering is flaky, the pure-function assertion alone locks the contract; the DOM-order test in the existing file already passes for the helper, so no new fallback is needed. |
| **AC2** | Entries preserve configured order and role labels, including repeated identities across roles. | Same `StackedAvatarGroup.test.jsx` — add a fixture `assignee: 'Rowan'`, `attentionOwners: ['Rowan', 'Tom']` and assert the helper returns three entries in order `[attention:Rowan@0, attention:Tom@1, delivery:Rowan]`. Then render the component and assert the DOM is `[delivery:Rowan, attention:Tom, attention:Rowan]` (render-order flip). | The per-slot `data-owner-key` plus `data-role` data attributes are part of the assertion. No new helper exports. |
| **AC3** | Assignee-only, attention-owner-only, empty-state, and avatar-overflow rendering continue to work. | Extend existing tests in `StackedAvatarGroup.test.jsx` — assignee-only, empty, and `maxVisible=2` overflow. All four cases already exist in the test file; this PR verifies they still pass after the collapse-block removal. | If any of the existing cases regressed, that is a `// FIXME:` flag in the PR description and a follow-up. |
| **AC4** | UI/component tests cover combined ownership, ordering, repeated identities, and the existing baseline cases. | New fixtures: combined-ownership (`assignee + workflow-gate + 2 attention slots, one of which duplicates the assignee`), intra-tier repeat (`attentionOwners: ['Rowan', 'Rowan', 'Tom']`), cross-role repeat (`assignee: 'Rowan' + attentionOwners: ['Rowan', 'Tom']`), and the no-collapse invariant on the helper. | All new tests run in the existing `vitest` setup; no new test runner or fixtures. |

### Why a UI component test, not E2E

The user-visible behaviour is "the task card shows an extra avatar when the
assignee is also in the attention stack." That is a single-component
visual change; an E2E test would only re-exercise the same code through
Playwright. The component-level test already mounts the same `Avatar` and
the same `TaskCardSummary` that production renders. The SPEC section 11
already documents the E2E coverage map; this PR does not add a new E2E
file because the existing `apps/tasks/test/e2e/happy-path.spec.js`
exercises the same card render path and any regression there will surface
in CI.

### Manual verification on the dev server

After the PR is open and the branch is deployed to a preview environment:

1. Pick a task where the assignee is also in the attention stack (any
   task currently routed through `attentionOwners` is a candidate — the
   easiest is to add `Rowan` as both the assignee and position-0
   attention owner on a fresh test task).
2. Open the task card and confirm the assignee avatar renders leftmost
   and the position-0 attention avatar renders rightmost, with both
   visible.
3. Open the detail view and confirm the task-details surface still
   surfaces the assignee section and the attention-owner section
   independently — that surface is fed by the same data plane and is not
   re-rendered through `StackedAvatarGroup`, but the manual check is
   worth a single observation.

The manual check is a one-time observation; it is not a gate and does
not block merge.

## Open questions and risks

- **Q1 — Display name for repeated avatars.** When the same owner appears
  twice in the rendered stack, the `aria-label` repeats the display name
  twice. Screen-reader output will read "attention owner Rowan, delivery
  assignee Rowan" back-to-back. That is the AC2 contract and matches the
  SPEC. No change needed; flagging it for review so the contract is
  explicit.
- **R1 — `data-owner-key` is no longer unique across the stack.** Two
  entries can share the same normalised owner string (one attention row
  + one delivery row for the same person). `data-owner-key` was previously
  implicitly unique because of the cross-role collapse. The new keys
  already include the role prefix (`attention:` vs `delivery:`), so the
  attribute remains unique within the rendered DOM. Any analytics or
  task-details consumer that relied on the cross-role collapse for
  deduplication must switch to grouping on `data-role` + owner instead
  of owner alone. I will grep for `data-owner-key` consumers before
  opening the PR and flag any that need a coordinated change.
- **R2 — Audit-trail dependency on the SPEC contract.** This PR aligns the
  code with the SPEC that was already in place. If any downstream
  consumer of the task card relied on the prior collapse behaviour, the
  visible avatar count will change. I have searched the repo for
  `task-owner-stack` consumers; the only consumer is
  `TaskCardSummary`. No analytics, no exports, no email templates.
- **R3 — `StackedAvatarGroup` z-index math.** The
  `sameRoleEntries.length - roleIndex - 1` formula assumes that
  `sameRoleEntries` is in the same order as `visible`. After this change
  the helper returns more entries (no collapse), but the per-role tier is
  unchanged, so the math is unchanged. No regression risk.
