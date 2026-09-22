---
status: draft
task_id: 08362d54-3939-41c7-bbef-7a8313ecaf3a
product_spec: null
shipped_pr: null
shipped_date: null
---

# Attention-Owner Avatar Stack Z-Order — Tech Design

## Links

- Task: `08362d54-3939-41c7-bbef-7a8313ecaf3a` (`💻 Fix attention-owner avatar stack z-order in app-tasks`)
- Task API detail: `http://localhost:4001/api/v1/tasks/08362d54-3939-41c7-bbef-7a8313ecaf3a`
- Bug evidence: Telegram message `19792` (2026-09-23); rightmost attention-owner avatar renders under the avatars to its left in overlapping task-card stacks.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-08362d54-avatar-z-order`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-08362d54-avatar-z-order`
- Primary code surfaces:
  - `apps/tasks/src/components/StackedAvatarGroup.jsx` — flip the inline `zIndex` expression so later DOM-order items (the rightmost avatars) stack above earlier ones (leftmost). Update the embedded comment to match the new direction.
  - `apps/tasks/src/components/StackedAvatarGroup.test.jsx` — update the `places the top attention owner visually above context and escalation slots` test to assert the corrected values, and add explicit coverage for the bug-report ACs (rightmost-on-top, single-avatar unchanged, stacks of 2/3/4 all correct).

No `.openclaw` runtime change. No Tasks API change. No data-shape change. No CSS rule change. The fix is local to the inline `zIndex` math in `StackedAvatarGroup.jsx` plus its accompanying test.

## Product Summary

`StackedAvatarGroup` renders the task-card avatar stack. It already produces the right DOM order (delivery, then the exact status-actionable workflow gate, then `attentionOwners` in escalation-slot order, all left-to-right). Each avatar is `position: relative` and is pulled leftward by `margin-left: -8px` so consecutive avatars overlap. Today the inline `zIndex` is computed as `roleDepth - index`, where `roleDepth` (100/200/300) sets the role-tier baseline and `index` is the avatar's position in the rendered slice.

That expression puts the **leftmost** avatar on top within each role tier — exactly the opposite of what the bug reports. Users expect the **rightmost** avatar to render above the avatars to its left (so the most recently added attention slot is not hidden by earlier slots). The fix flips the sign of `index` so later DOM-order items get a higher z within the same role tier while keeping the role-tier baselines (delivery < workflow-gate < attention) intact.

`buildStackedOwnerLayers`, the role/owner-key normalisation, the overflow chip, the `data-role` / `data-owner-key` attributes, and the accessibility labels are all unchanged — the bug is purely visual stacking order, not data flow.

## Implementation Plan

### 1. Flip the inline `zIndex` direction in `StackedAvatarGroup.jsx`

Current expression (line 144):

```jsx
const roleDepth = entry.role === 'attention' ? 300 : entry.role === 'workflow-gate' ? 200 : 100;
// ...
style={{ zIndex: roleDepth - index }}
```

Replace with:

```jsx
const roleDepth = entry.role === 'attention' ? 300 : entry.role === 'workflow-gate' ? 200 : 100;
// ...
// Within a role tier, the rightmost avatar (highest DOM index in the slice)
// is the most recently added slot and should render above earlier ones so
// it stays visible in the overlap. The role-tier baseline (delivery <
// workflow-gate < attention) is preserved by keeping `roleDepth` as the
// dominant term; the `+ index` only adjusts ordering within a tier.
style={{ zIndex: roleDepth + index }}
```

For a stack with `delivery=Rowan`, `workflowGates=[qa_agent:Ash]`, `attentionOwners=[Quinn, Tom]` the new z values are `[100, 201, 302, 303]`. The role-tier separation between delivery / workflow-gate / attention is preserved (each tier's lowest z is still strictly above the previous tier's highest), and within each tier the rightmost avatar wins.

The embedded comment in `StackedAvatarGroup.jsx` ("The `data-role` attribute lets the task-details surface and the accessibility script read the role without re-parsing the label.") is unrelated and stays. The component's JSDoc header at the top of the function references the rendering order in prose ("Renders the delivery assignee first, then outstanding workflow-gate owners, then the ordered attention stack") — that prose describes DOM order, which is unchanged, so it stays.

### 2. Update the one test that asserts the old z-ordering direction

`apps/tasks/src/components/StackedAvatarGroup.test.jsx`, the `places the top attention owner visually above context and escalation slots` test (around line 132) currently asserts `[100, 199, 298, 297]`. With the fix the values become `[100, 201, 302, 303]`. Rename the test to reflect the new direction (e.g. `places the rightmost attention owner visually above context and escalation slots`) so a future regression check does not silently re-flip the direction.

### 3. Add explicit coverage for AC1–AC3

The existing tests do not separately cover the bug-report ACs. Add three narrow tests:

- `rightmost avatar in a same-role attention stack renders above the avatars to its left` — `attentionOwners: ['Quinn', 'Tom']` only (no workflow-gate, no assignee). Assert the rightmost item has the strictly-highest inline `zIndex` among the rendered slice.
- `single-avatar rendering is unchanged` — `attentionOwners: ['Quinn']` only. Assert exactly one `.task-owner-stack-item` is rendered and its `zIndex` matches `300 + 0 = 303` (or whatever the exact role-tier baseline produces for that role; pick whichever the actual expression yields and pin it).
- `stacks of three and four avatars follow rightmost-on-top` — `attentionOwners: ['A', 'B', 'C']` and `['A', 'B', 'C', 'D']`. For each, assert the rendered `zIndex` values are strictly increasing left-to-right (i.e. item N has a higher z than item N-1).

Do not change the existing structural tests (DOM count, role attribute presence, overflow chip, missing-task no-op). Those already pass against the fixed component and verify the data layer, which the bug does not touch.

### 4. Manual visual check (sandbox is enough; no Fly-side change)

Boot `apps/tasks` (`npm run dev` from the worktree) with a task whose `attentionOwners` has 2–4 people and no assignee / gate. Confirm visually that the rightmost avatar covers the overlapping portion of the avatars to its left. This is the same shape of evidence Tom already accepted on prior visual-fix tasks — a screenshot in the PR description is sufficient because the change is local and the existing role/aria/data tests are unchanged.

## Ownership boundary check

- **Natural source of truth:** UI-local render order in `apps/tasks/src/components/StackedAvatarGroup.jsx`. The data layer (`buildStackedOwnerLayers`) is correct; only the inline `zIndex` expression is wrong.
- **Incremental-delivery posture:** a one-line JSX edit plus one test-array update plus three new tests. No interim shim — the durable fix is the same shape and same effort as a shim would be.
- **No cross-app / cross-service impact.** The `Avatar` component (`@sindustries/ui/react`) is unchanged. The Tasks API schema is unchanged. No migration. No `.openclaw` boundary touched.
- **No AC checkboxes on the task description.** Per `WORKFLOW.md`, AC toggling is Tom/QA's gate; Rowan's evidence goes in the PR body.

## Data model / API contract changes

None. The Tasks API still returns `attentionOwners` as an ordered string array; the component still respects the array order left-to-right. Only the within-tier z direction flips.

## Workflow, cron, and skill changes

None. The fix is local to one JSX expression and one test file.

## Test plan — AC verification matrix

| AC | Layer | Plan |
|---|---|---|
| AC1 — rightmost avatar visually above overlapping avatars to its left | Component test | New test "rightmost avatar in a same-role attention stack renders above the avatars to its left": `attentionOwners: ['Quinn', 'Tom']`, no delivery / gate. Assert item at index 1 has strictly-higher inline `zIndex` than item at index 0. Manual visual confirmation via `npm run dev` with a 2-owner attention task to confirm in browser, screenshot attached to PR body. |
| AC2 — visual stack order matches the existing attention-owner order without changing task routing or `attentionOwners` data | Component test | Existing structural tests (DOM count, role attributes, `aria-label`, `data-owner-key`, overflow chip, missing-task no-op, approved-gate skipping, repeated-people rendering) are unchanged and still pin the logical order left-to-right. No `tasks-api` change; `attentionOwners` array is rendered in the same array order. |
| AC3 — works for stacks of 2/3/4+; single-avatar unchanged | Component test | Two new tests: "stacks of three avatars follow rightmost-on-top" and "stacks of four avatars follow rightmost-on-top" (strictly increasing z left-to-right). Plus one new test: "single-avatar rendering is unchanged" (one item, zIndex pinned at role-tier baseline + 0). |

E2E coverage (Playwright) is **not** planned for this task because:

1. The component is already covered by 18+ existing component tests that pin DOM/aria/data semantics.
2. The fix is a single arithmetic operator; the risk surface is the new operator choice, not user-flow correctness.
3. A manual visual check (`npm run dev`, screenshot) is sufficient evidence for a one-line visual tweak and matches the precedent on prior visual-fix tasks.

Falling back to manual visual + component tests is proportionate here; no need to spin up a full Playwright run for a one-character change.

## Open questions and risks

- **None blocking.** The bug is fully specified by the task ACs and the screenshot reference; the fix is a one-line arithmetic flip plus accompanying test updates.
- **Risk: regression of role-tier separation.** The `roleDepth` baseline of 100/200/300 still dominates the per-tier `+ index` because role-tiers do not overlap in normal data — a 4-avatar attention tier peaks at `300 + 3 = 303`, still strictly above the workflow-gate tier ceiling of `200 + 1 = 201` (the only status-actionable gate per status). If someone later relaxes the "exactly one status-actionable gate" invariant, this expression would need a re-check; the comment in the JSX should call that out (added in step 1).
- **Risk: existing tests silently regress.** The `[100, 199, 298, 297]` assertion in the test file encodes the bug. If the test runner somehow caches or the test file is skipped in CI, the bug would resurface. The renamed test (step 2) plus the new AC1/AC3 tests make the regression catchable from the test name alone.
- **Out of scope:** changing the role-tier baseline values, changing the `margin-left: -8px` overlap distance, switching from inline `zIndex` to CSS `:nth-child` selectors, or touching the `Avatar` component. Any of those would be a separate task.