---
status: shipped
task_id: 8352c722-7953-474a-82ed-a9e8a7fb8fa6
product_spec: n/a
shipped_pr: 971
shipped_date: 2026-11-12
---

# Content Scheduler: preserve in-progress edits across the 10-second refresh — tech design

## Product spec link

- Product spec: n/a. This is a bounded regression fix defined by task `8352c722-7953-474a-82ed-a9e8a7fb8fa6`.
- Task API detail: `http://localhost:4001/api/v1/tasks/8352c722-7953-474a-82ed-a9e8a7fb8fa6`

## Task and implementation context

- Task ID: `8352c722-7953-474a-82ed-a9e8a7fb8fa6`
- Task title: `🔧 Content Scheduler tweet edits revert after a few seconds (background poll overwrites in-progress edits)`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-8352c722-content-scheduler-edit-poll-clobber`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-8352c722-content-scheduler-edit-poll-clobber`
- Current system doc: `docs/systems/content-scheduler.md`
- Current app spec: `apps/mission-control/SPEC.md`

## Product intent summary

An operator must be able to open a scheduled tweet or thread, type changes, and leave the edit open while Mission Control's ten-second background refresh runs. The refresh must not replace the operator's unsaved draft with the last server copy. The same refresh must continue to surface auto-posted items and other server-side changes for rows that are not currently being edited.

The fix is a UI-state ownership correction, not a change to publishing, scheduling, approval, or the Content Scheduler API.

## Current behaviour and evidence

`useContentScheduler` calls `reload()` every ten seconds and replaces the `items` array. Each `SchedulerItemCard` keeps its unsaved edit in local React state.

The card currently syncs those local drafts back from props in effects:

- the single-item body and schedule are copied whenever `item.body` or `item.scheduledFor` changes;
- the thread part list is copied whenever `normalizedParts` changes;
- `normalizedParts` is derived from the current `item` object, so a poll that returns an equivalent but newly allocated item can still reset the thread draft.

A focused probe against the current implementation branch on 2026-11-11 produced these results:

| Open edit | Server copy returned by the next poll | Result before the fix |
| --- | --- | --- |
| Single tweet | unchanged | draft remained |
| Single tweet | changed | draft was replaced by the server copy |
| Thread | unchanged | draft was replaced by the server copy |
| Thread | changed | draft was replaced by the server copy |

The single-item path therefore has the same unsafe rule as the thread path, although its effect dependencies happen to mask the unchanged-copy case. The fix must make the rule explicit for both item kinds.

## Ownership boundary

### Natural source of truth

- The Content Scheduler API and database remain the source of truth for persisted item state.
- The open edit form's local React state is the source of truth for an unsaved draft. A background read must not mutate that draft while the operator is editing.
- Drafts are deliberately UI-local. Persisting them to the API or introducing a shared draft contract would make a small regression fix durable in the wrong place.

### Why the fix stays in the card

Suppressing the whole poll while any row is open would keep unrelated rows stale and violate the auto-post visibility requirement. Moving draft state into the hook would add a second state model without a durable benefit. The narrow boundary is the card that owns the edit controls: it should adopt server values only when it is not in an editing session.

This is one small, mergeable UI correction. No backend schema, endpoint, worker, cron, or shared-package change is warranted.

## `.openclaw` boundary notes

- No secrets, X credentials, `.openclaw` configuration, cron, heartbeat schedule, or host runtime change is required.
- The ten-second interval remains a UI-only freshness mechanism. It does not drive publishing.
- The implementation branch and its existing worktree are the only places this repository change belongs.

## Implementation plan

### 1. Make draft synchronization editing-aware

Update `apps/mission-control/src/tabs/SchedulerItemCard.jsx`:

- keep `draftBody`, `draftSchedule`, and `draftParts` local to the card;
- when the card is not editing, synchronize those drafts from the latest `item` props;
- when the card is editing, do not synchronize any draft from a poll result;
- remove the duplicated single-item body/schedule synchronization effect while making this change;
- keep the thread `draftParts` snapshot local for the full edit session.

The editing guard must cover both single items and threads. It should not depend on whether the server copy happens to be byte-for-byte equal, because equal values and newly allocated response objects are different concerns.

### 2. Snapshot the item when an edit session starts

Add a small `beginEditing` path used by the Edit button:

1. copy the current body and schedule from the latest item props;
2. for a thread, copy the current normalized part bodies;
3. open the editor.

This makes the start of an edit session explicit and avoids relying on effect timing between a poll render and the operator's click.

### 3. Define cancel and save transitions

- Cancel discards the local draft, restores the latest server copy, and closes the editor.
- Save sends the local draft through the existing `onSave` or `onSaveThread` contract. After the existing save/reload completes, the editor closes and the non-editing synchronization path adopts the persisted server copy.
- Do not change the backend update contract, approval invalidation, or error handling in this task.

The Content Scheduler API remains the authority after Save. Before Save, the local draft wins against background refreshes by design.

### 4. Leave the refresh path and API unchanged

Keep the ten-second interval in `apps/mission-control/src/tabs/useContentScheduler.js` unchanged. Keep `reload()` updating the complete list and today status. No change is needed in `apps/mission-control/src/contentSchedulerApi.js` or the Content Scheduler service.

### 5. Document the shipped behaviour

When the implementation ships:

- update `apps/mission-control/SPEC.md` to state that an open edit draft survives the ten-second refresh and list the manual fallback coverage;
- update `docs/systems/content-scheduler.md` with the UI refresh/draft ownership rule and the runbook symptom;
- update this design's frontmatter to `status: shipped`, `shipped_pr`, and `shipped_date` in the implementation PR.

## Data model and API contract changes

None.

- No database migration.
- No Content Scheduler endpoint or payload change.
- No new client-side storage or cross-session draft recovery.

## Workflow, cron, and skill changes

None.

- The auto-post worker and its scheduling version are unaffected.
- No cron or heartbeat change is required.
- No skill change is required; the Tasks API comment and structured tech-design approval are the only workflow state for this task.

## Test plan

### Automated component coverage

Extend the Mission Control Content Scheduler component tests with fake timers and controlled `listItems` responses:

1. **Single edit survives an unchanged poll.** Open a single edit, type a draft, advance past one ten-second interval with an unchanged server copy, and assert the textarea still contains the draft.
2. **Single edit survives a changed poll.** Repeat with a changed server copy and assert the open draft is still present.
3. **Thread edit survives an unchanged poll.** Open a thread edit, change one part, advance past one interval, and assert the edited part remains. This is the regression case that currently fails even when the server copy is unchanged.
4. **Thread edit survives a changed poll.** Repeat with changed root and part bodies and assert the local draft remains.
5. **Non-edited rows still refresh.** Keep one row in edit mode while the poll returns a changed value for another row; assert the other row displays the new server value.
6. **Save sends the local draft.** Advance past a poll, save, and assert the existing update API receives the operator's typed value rather than the polled server copy.
7. **Cancel discards the local draft.** Advance past a poll, cancel, and assert the card returns to the latest server copy.

Retain the existing ten-second refresh test as the regression guard for AC2. Add the new cases to `apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx` or a focused `SchedulerItemCard` test file if that keeps the fixtures clearer.

### Manual verification

Use a real Mission Control instance and a scheduled item:

1. open a single tweet or thread for editing;
2. change the body or one thread part without saving;
3. wait longer than ten seconds while the edit remains open;
4. confirm the typed value is still present;
5. repeat with another non-edited item visible and confirm it can still reflect an auto-post or other server-side update;
6. save, reopen the item, and confirm the persisted value is the operator's draft.

Record the observed result in the implementation PR with the exact item kind used. Mission Control currently has component coverage rather than a dedicated browser E2E harness for Content Scheduler, so this manual app-flow check is the required fallback layer for AC3.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Component-testable with fake timers for single and thread edit forms, including unchanged and changed poll responses. Manual confirmation in a running app. | Vitest cases assert the open textarea values survive a poll; PR verification note records the manual wait-and-confirm result. |
| AC2 | Retain the existing mounted ten-second refresh test and add a non-edited-row refresh assertion. | Vitest proves `listItems`/`getTodayStatus` still run and a non-edited card renders the new server value while another card is being edited. |
| AC3 | Manual app-flow verification because Mission Control has no dedicated Content Scheduler browser E2E harness. | PR comment/verification section records the single or thread item used, the wait longer than ten seconds, and the observed draft state. |

## Open questions and risks

1. **Concurrent remote edits.** Preserving the local draft prevents a read-only poll from overwriting operator input, but the existing API has no version/precondition contract. A later Save remains last-write-wins if another operator changed the same item. Conflict detection is a separate API product decision and is out of scope here.
2. **Thread response identity.** Thread normalization currently depends on the item object and therefore on poll allocation identity. The editing guard makes this harmless for drafts; the implementation should not rely on reference equality as a proxy for “server changed.”
3. **Save failure.** The current card closes edit mode after the existing save callback resolves. Changing failed-save draft retention is not required by this task and should not be bundled into the regression fix.
4. **Effect dependencies.** The implementation must keep the editing state in the effect dependency list so React can re-enable synchronization after Save or Cancel. Lint or hook tests should catch an accidental stale closure.
5. **Manual versus automated scope.** The component suite is the practical automated layer for the regression. The manual wait longer than ten seconds is still mandatory because the original symptom is timing-sensitive.
