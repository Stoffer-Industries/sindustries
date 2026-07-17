---
status: draft
task_id: 95e65d06-e529-466e-a6b0-d8dfb1e2eb87
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-calendar-view-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Content Scheduler 10-day calendar view — tech design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-calendar-view-2026-07-16.md`
- Approved by Tom in the product spec.

## Task and implementation context

- Task ID: `95e65d06-e529-466e-a6b0-d8dfb1e2eb87`
- Task title: `🔧 Content Scheduler: 10-Day Calendar View`
- Branch: `task-95e65d06-content-scheduler-calendar-view`
- Worktree: `~/workspaces/rowan/sindustries-task-95e65d06-content-scheduler-calendar-view`
- Repository: `Stoffer-Industries/sindustries`

## Product intent summary

Mission Control's Content Scheduler should make the upcoming publishing plan visible as a 10-day forward calendar from today through today + 9 in `Pacific/Auckland`. Approved, queued, and published scheduler items appear as cards on their scheduled day; items without an in-window `scheduledFor` appear in an Unscheduled overflow area. Tom can drag non-published cards between day columns to reschedule them while preserving the time-of-day. Published cards are read-only, visually distinct, and each day with a published item blocks dropping a second item into that day with an inline error.

## Service boundary and data ownership

- Domain owner remains the existing Content Scheduler backend surface exposed through `apps/mission-control/src/contentSchedulerApi.js`.
- This task is UI-first and does not introduce a new service boundary.
- The existing item contract is enough for the calendar: `id`, `body`, `source`, `status`, `scheduledFor`, `approvedAt`, `approvedBy`, `publishedAt`, `publishedUrl`, `publishError`, `position`, `createdAt`, `updatedAt`.
- Rescheduling uses the existing `PATCH /content-scheduler/items/:id` client helper (`updateItem`) with `{ scheduledFor }`. The backend already refuses updates to `published`/`removed` items; the UI will additionally prevent dragging published cards before a request is made.
- The max-one-published-per-day rule is already enforced for publishing. This task adds the calendar-side drop guard so Tom cannot move another card onto a day that already contains a published item.

## `.openclaw` boundary notes

- None for implementation. The product spec lives under `.openclaw/workspace/brain`, but all code and durable repo documentation changes are in `Stoffer-Industries/sindustries`.
- Do not read or write `.openclaw` runtime state as part of the implementation beyond the already-approved product spec reference.

## Implementation plan

### 1. Refactor Content Scheduler view into calendar primitives

Scope:

- `apps/mission-control/src/tabs/ContentSchedulerTab.jsx`
- `apps/mission-control/src/styles/components.css`
- `apps/mission-control/SPEC.md` when implementation ships

Plan:

- Keep the existing composer and action handlers (`create`, `approve`, `unapprove`, `publish`, `remove`, `save`) intact.
- Replace the three status group sections as the primary listing with a calendar layout:
  - A 10-column grid for today through today + 9.
  - Each column header labels the day using `Pacific/Auckland`, e.g. `Wed 16 Jul`.
  - Each column uses `CardContainer variant="column"` where practical and `Card` for items, matching the tasks/kanban card-column visual language.
  - A separate `Unscheduled` overflow `CardContainer variant="column"` appears below or beside the calendar for items with no `scheduledFor` or a date outside the 10-day window.
- Extract small pure helpers in the same file initially; move to `apps/mission-control/src/tabs/contentSchedulerCalendar.js` only if the component becomes unwieldy:
  - `buildCalendarDays(now, timeZone)` → 10 day descriptors with `{ key: 'YYYY-MM-DD', label, dateParts }`.
  - `getAucklandDayKey(isoTimestamp)` → `YYYY-MM-DD` for grouping by Pacific/Auckland date.
  - `groupItemsForCalendar(items, days)` → `{ byDayKey, unscheduled }`, including queued/approved/published non-removed items.
  - `getPublishedItemForDay(items, dayKey)` → published card, if any, for header/drop guarding.
- Keep the existing queue list only if needed as a secondary debugging fallback during implementation. The shipped primary view should be the calendar plus overflow, not three status groups competing with it.

### 2. Card rendering and visual states

- Reuse the current item card body/action logic where possible, renaming `ItemRow` to `SchedulerItemCard` or keeping it if the diff is smaller.
- Add `Badge` from `@sindustries/ui/react` for status pills and published indicators.
- Published cards:
  - Render in their scheduled/published day column when in the 10-day window.
  - Add a `Published` badge and muted/greyed styling.
  - Set `draggable={false}` and omit edit/remove/approve/unapprove controls as the current UI already does for published status.
- Non-published cards:
  - Keep edit, approve/unapprove, publish, and remove actions.
  - Show compact metadata: source, scheduled local date/time when present, approved status, publish errors.
- Day header states:
  - Normal: day label plus count of cards.
  - Published day: show a small `Published today` / `Published` badge or lock indicator in the header.
  - Drop refused: show inline error text in the target column header/body; clear it on the next successful drop or when dragging over another valid day.

### 3. Drag-and-drop reschedule interaction

The approved product spec asks for native HTML5 drag-and-drop and explicitly avoids a new drag library. The implementation should therefore extend the existing native drag approach instead of adding `dnd-kit`/`react-dnd`.

- Track drag state with local React state:
  - `draggingItemId`
  - `dragOverDayKey` or `dragOverZone` (`day:<key>` / `unscheduled`)
  - `calendarDropError` as `{ dayKey, message } | null`
- On card drag start:
  - Refuse if `item.status === 'published'`.
  - Write the item id into `event.dataTransfer` and set an explicit effect (`move`).
- On day column drag over:
  - `preventDefault()` only for non-published dragged items.
  - Apply a dashed/brand outline to the target column using existing design tokens.
- On drop to a day:
  - Look up the source item from current `items`.
  - If the source item is missing or published, no-op and show no request.
  - If the target day already contains a different published item, refuse the drop, set inline error `Already has a published post — choose another day.`, and do not call the API.
  - Compute a new `scheduledFor` for the target `Pacific/Auckland` date while preserving the source HH:MM where present, otherwise defaulting to `09:00`.
  - Call `updateItem(id, { scheduledFor: nextIso }, { actor: ACTOR })`, then `reload()`.
- On drop to Unscheduled:
  - Optional but useful: support moving a non-published item to overflow by setting `scheduledFor: null`. If this is too much scope, the overflow can be a display-only drop target; the required behavior is day-to-day rescheduling.
- Remove or isolate the old queue-only reorder drag path so it does not conflict with calendar drag. `reorderItems` is not needed for date rescheduling.

### 4. Pacific/Auckland date/time helpers

Timezone handling is the main correctness risk. The UI should not rely on the browser/system local timezone except as a fallback.

- Define `const SCHEDULER_TIME_ZONE = 'Pacific/Auckland'`.
- Use `Intl.DateTimeFormat('en-NZ', { timeZone: SCHEDULER_TIME_ZONE, ... })` for:
  - Day labels.
  - Day keys (`YYYY-MM-DD`).
  - Extracting the source item HH:MM.
- Implement a tested `zonedDateTimeToIso(dayKey, hour, minute, timeZone)` helper using `Intl` offset correction:
  1. Start with a UTC guess from the target date/time.
  2. Format that instant in `Pacific/Auckland`.
  3. Calculate the minute delta between formatted parts and requested parts.
  4. Adjust the UTC instant and verify the formatted date/time matches.
  5. Return ISO string, or throw a friendly error if conversion fails.
- Preserve HH:MM from `scheduledFor` if valid; default to `09:00` when missing/invalid.
- Add unit coverage for at least one standard-time and one DST date so rescheduling does not silently drift by a day/hour.

### 5. Max-one-published-per-day guard

- Build a `publishedByDayKey` map from loaded `items` where `status === 'published'` and the grouping day is in Pacific/Auckland.
- Header indicator appears when a day has any published item.
- Drop refusal applies when:
  - Target day has a published item, and
  - Dragged item is not that same published item (published items cannot drag anyway), and
  - Dragged item is non-published.
- This guard intentionally blocks queued/approved cards from being scheduled onto a day with an already-published card. It does not block multiple queued/approved cards on the same future day unless one is already published, matching the task wording.

### 6. Styling and layout

- Add focused `.content-scheduler-calendar*` classes to `apps/mission-control/src/styles/components.css`.
- Desktop Mission Control only: use horizontal scroll if 10 columns cannot fit comfortably.
- Suggested structure:
  - `.content-scheduler-calendar` as `display: grid; grid-template-columns: repeat(10, minmax(220px, 1fr)); gap: var(--si-space-4); overflow-x: auto;`
  - `.content-scheduler-day-column` using existing card container surfaces.
  - `.content-scheduler-day-column--published` and `--drop-error` modifiers.
  - `.content-scheduler-card--published` muted opacity/background.
- Keep existing error banner behavior for API errors; add per-column drop error for refused reschedules.

## Data model and API contract changes

No database schema change is planned.

Existing API usage:

- `GET /content-scheduler/items` — unchanged; the frontend groups the returned items into calendar days.
- `PATCH /content-scheduler/items/:id` — used for drag reschedule with `{ scheduledFor: <ISO string|null> }`.
- `GET /content-scheduler/today-status` — keep for the existing day-status strip, but do not use it as the only source for future day publish locks because it only describes today.

`scheduledFor` update rules on drag:

- Target day comes from the dropped calendar column's `Pacific/Auckland` date key.
- Time comes from the existing `scheduledFor` interpreted in `Pacific/Auckland`.
- If the item has no valid time, use `09:00` Pacific/Auckland.
- Store the result as UTC ISO via existing `updateItem` behavior.
- Published items are not draggable and cannot be patched by this flow.

## Workflow, cron, and skill changes

- No cron changes.
- No agent skill changes.
- No publishing workflow changes: Tom still explicitly publishes items; this task only changes visibility and rescheduling.
- Update `apps/mission-control/SPEC.md` in the implementation PR to document the calendar as the Content Scheduler primary screen and link the new test coverage.
- If a durable system doc for Content Scheduler exists after service extraction lands, update that doc on ship. On the current main branch the closest durable doc is `docs/systems/content-factory.md`; update only if implementation changes its described runtime behavior.

## Test plan

Run at minimum:

- `npm --workspace @sindustries/mission-control test -- ContentSchedulerTab.test.jsx`
- `npm --workspace @sindustries/mission-control test`
- `npm --workspace @sindustries/mission-control build`

Add/adjust component tests in `apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx` and pure helper tests if helpers are split into a separate module.

| AC | Verification layer | Planned coverage |
| --- | --- | --- |
| AC1 | Component test | Freeze/mock current date to a known Pacific/Auckland day and assert 10 day columns render from today through today + 9 with labels like `Wed 16 Jul`. |
| AC2 | Component test | Mock queued, approved, and published items with in-window `scheduledFor` values; assert each appears in the correct Pacific/Auckland day column as task-style cards with status badges. |
| AC3 | Component test | Mock items with `scheduledFor: null`, invalid/outside-past date, and outside-future date; assert they render in `Unscheduled` and not in the 10 day columns. |
| AC4 | Component test + helper unit coverage | Simulate native drag/drop from one day column to another and assert `updateItem` is called with an ISO timestamp on the target date preserving HH:MM; add a no-time/default case asserting `09:00`. |
| AC5 | Component test | Render a published item and assert it has the published badge/muted class, lacks drag affordance (`draggable=false`), and does not expose edit/remove controls. |
| AC6 | Component test | Render a target day with a published item, drag a queued/approved item onto that day, assert no `updateItem` call occurs and an inline error is shown in that day column/header. |

Manual smoke after tests:

1. Start Mission Control against the local Content Scheduler API.
2. Open `/content-scheduler`.
3. Create or use sample queued/approved/published rows across multiple dates.
4. Verify drag between days updates the scheduled date while preserving the visible time.
5. Verify a published day refuses another dropped card and shows the inline error.

## Open questions and risks

- **Timezone conversion:** Pacific/Auckland must be explicit. Relying on Tom's browser timezone would be simpler but brittle; use `Intl` helpers and tests, especially around DST.
- **Spec/library mismatch:** The task prompt mentioned `dnd-kit`/`react-dnd` as likely options, but the Tom-approved product spec says to use native HTML5 drag API and add no new dependency. This design follows the approved spec.
- **Published day semantics:** The requirement blocks dropping onto a day that already has a published item. It does not block multiple queued/approved items on a day with no published item; preserving that behavior avoids inventing stricter scheduling rules.
- **Calendar orientation wording:** The spec says row/columns inconsistently. This design uses 10 day columns because AC1 and the prompt call out a 10-day column calendar; the Unscheduled area can sit below or beside depending on cleanest desktop layout.
- **Existing reorder behavior:** The old queue reorder drag path may become obsolete. Removing it is acceptable if the calendar is the primary view and no acceptance criterion requires position reordering.
- **E2E coverage:** Existing Mission Control coverage for this tab is Vitest component-level rather than browser E2E. Component tests are the right layer for native drag events here unless the repo already has an e2e harness available at implementation time.
