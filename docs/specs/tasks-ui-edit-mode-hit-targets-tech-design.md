---
status: shipped
task_id: 88cd00e0-50ee-4733-8a59-670282525eb6
product_spec: n/a
shipped_pr: null
shipped_date: 2026-11-19
---

# Tasks UI Edit-Mode Hit Targets — Tech Design

**Task:** `88cd00e0-50ee-4733-8a59-670282525eb6` — Fix Tasks UI edit-mode hit targets
**Branch:** `task-88cd00e0-tasks-ui-edit-mode-hit-targets`
**Worktree:** `/Volumes/WD1/worktrees/rowan/rowan-task-88cd00e0-edit-mode-hit-targets`
**Repository:** `Stoffer-Industries/sindustries`
**Owner:** Rowan

## Product intent

The Tasks description preview currently turns *any* click inside it into "enter inline text edit mode", including clicks that were meant for something else. Two concrete failures were reported:

1. Mis-clicking near an acceptance-criteria checkbox puts the description into inline text edit mode instead of toggling (or doing nothing), so the user loses their read-only view and has to escape out of a textarea.
2. Cmd-clicking a URL inside the description enters inline text edit mode instead of opening the link in a new tab.

The intent is to separate **interaction targets** from **edit entry**: checkbox rows are checkbox targets, links are link targets, and inline editing is reached deliberately rather than by accident.

## Root cause (current state)

`apps/tasks/src/components/TaskEditor.jsx:335-341` renders the read-only description as a click-to-edit container:

```jsx
<div
  className="description-preview"
  onClick={() => setIsDescriptionEditing(true)}
  role="button"
  tabIndex={0}
  aria-label="Click to edit description"
  ...
>
  <MarkdownContent markdown={draft.description} onCheckboxToggle={handleDescriptionCheckboxToggle} />
</div>
```

`MarkdownContent` (`apps/tasks/src/components/MarkdownContent.jsx`) renders sanitized markdown (task-list checkboxes and links) via `dangerouslySetInnerHTML`, and its own click handler only recognises `input[type="checkbox"]` targets:

```jsx
function handleClick(event) {
  if (!onCheckboxToggle) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
  ...
  onCheckboxToggle(event, checkboxIndex);   // preventDefault + stopPropagation
}
```

Consequences:

- Clicking the checkbox itself is safe — `handleDescriptionCheckboxToggle` calls `event.preventDefault()` and `event.stopPropagation()`, so the click never reaches `.description-preview`.
- Clicking **near** the checkbox (the AC text, the list-item padding, the row) hits a non-checkbox target, `MarkdownContent.handleClick` returns early *without* stopping propagation, and the click bubbles to `.description-preview` → edit mode. This is AC1's bug.
- Cmd-clicking a link hits an `<a>` target → same early return → the click bubbles to `.description-preview` → edit mode, while the browser simultaneously performs its native Cmd-click new-tab navigation. AC2's bug is the two behaviours racing, not a missing navigation.

So the defect is a missing *interaction classification* layer: nothing in the component tree knows which rendered markdown nodes are interactive, and the outermost container treats every click as an edit request.

## Acceptance-criteria interpretation

AC1 says hit areas must be "large enough that clicking the checkbox **or its surrounding target** does not enter inline text edit mode". This design reads the surrounding target as the AC row itself becoming a **checkbox hit target** — clicking the AC text toggles that AC's checkbox — rather than a dead zone. If Quinn prefers the row to be inert (no toggle), see Open Question 1; the implementation differs by one branch in the interaction classifier.

AC3 says "intentional text editing continue to work as before". Because AC rows stop being edit entry points under this interpretation, the design adds an **explicit edit affordance** (an "Edit description" control in the description header) so deliberate editing is always one click away, including for AC text inside a task-list row. Plain description text outside a task list keeps the existing click-to-edit behaviour.

## Ownership boundary and architecture

| Concern | Natural owner | Design |
|---|---|---|
| Task description text (the markdown source) | Database-backed Tasks API domain resource (`Task.description`) | Unchanged. The UI still edits the description through the existing `onPatch`/`onSave` payload; no schema, route, or contract change. |
| Checkbox state inside a markdown description | Existing `toggleMarkdownTaskCheckbox` string transform + Tasks API description patch | Unchanged. Row-click toggling reuses the same index-based transform so the persisted markdown format is identical. |
| Which click means "toggle", "open link", or "edit" | UI-local interaction state in the Tasks app | New: a single interaction classifier in `MarkdownContent`, consumed by `TaskEditor`. No API or shared-package change is warranted — the rule is about pointer semantics in one UI, not a cross-surface contract. |
| Link navigation (open in new tab on Cmd/Ctrl-click) | Browser default behaviour | Preserved: the classifier never calls `preventDefault()` for links, so native Cmd/Ctrl-click new-tab behaviour is untouched. |
| Edit-mode entry / exit | UI-local state (`isDescriptionEditing` in `TaskEditor`) | Extended with an explicit edit control; the state machine stays local to the component. |

This is deliberately a **UI-local** change. The durable source of truth for a task's acceptance criteria is the task description owned by the Tasks API; nothing about "which pixel is a hit target" belongs in the API, the database, or a shared package, and there is no second consumer of the markdown renderer that would justify extracting a shared interaction contract now. If a second surface (e.g. Mission Control) later embeds the same markdown preview, the classifier can be lifted into `packages/` at that point — not before.

Per Rowan's incremental-delivery posture: the durable fix here *is* a small one (classify interactions in one component), so no interim shim is proposed. A "stop propagation on every markdown click" hack would silence the symptom while leaving AC rows inert, which is the intermediate shape this design deliberately avoids.

## Implementation plan

### 1. Interaction classifier in `MarkdownContent` (AC1, AC2)

**Primary file:** `apps/tasks/src/components/MarkdownContent.jsx`

Replace the checkbox-only click handler with a classifier that resolves the click target to exactly one interaction kind, in priority order:

1. **Link target** — `event.target.closest('a[href]')` is present → the click is a link interaction. Do **not** `preventDefault()` (native Cmd/Ctrl-click new-tab and plain-click navigation are preserved) and do **not** let the click reach any edit-on-click ancestor. Do not toggle a checkbox.
2. **Checkbox target** — the click target is `input[type="checkbox"]` → existing behaviour: toggle that checkbox by index, `preventDefault()` + `stopPropagation()`.
3. **Task-list row target** — the click target is inside an `li` that contains a task-list checkbox (`li:has(input[type="checkbox"])`) → treat it as a checkbox hit target: resolve the row's checkbox index (the same index space `toggleMarkdownTaskCheckbox` already uses — the position of the row's checkbox among all rendered checkboxes) and toggle it, `preventDefault()` + `stopPropagation()`.
4. **Anything else** → do not interfere; let the event bubble so existing click-to-edit behaviour on plain description text is unchanged.

Notes and constraints:

- The classifier must work against the sanitized HTML that `renderMarkdown` produces. `DOMPurify` is configured with `ALLOWED_TAGS` including `input`, `a`, `li`, and strips `disabled` from checkboxes, so task-list checkboxes are interactive and the DOM shape is stable.
- Index resolution must use the *rendered* checkbox order (`root.querySelectorAll('input[type="checkbox"]')`), exactly as the current implementation does, so `toggleMarkdownTaskCheckbox`'s line-scanning index semantics stay valid.
- Clicking a link **inside** an AC row must open the link, not toggle the checkbox — link priority (1) is above row priority (3).
- The classifier lives in `MarkdownContent` so it applies to every markdown surface, but it only *acts* when the consumer supplies a handler. Comment bodies (`TaskEditor.jsx:599`) pass no `onCheckboxToggle` and must keep rendering as inert content.
- `MarkdownContent` gains an optional `onRowToggle` (or an extended `onCheckboxToggle(event, index, { source: 'checkbox' | 'row' })`) so `TaskEditor` can distinguish a direct checkbox click from a row click if it needs different affordances later. Keep the existing prop working so no other call site breaks.

### 2. Explicit edit affordance in `TaskEditor` (AC3)

**Primary file:** `apps/tasks/src/components/TaskEditor.jsx`

- Add an "Edit description" control in the description header (`apps/tasks/src/components/TaskEditor.jsx:315-320`) that sets `isDescriptionEditing` to `true`. When editing, the control becomes "Done"/"Cancel" semantics consistent with the existing textarea behaviour (`Escape` exits, blur exits).
- Keep the existing click-to-edit on the preview for plain (non-interactive) text so the current muscle memory still works.
- Because AC rows no longer enter edit mode on click, the explicit control is the path to editing AC text.
- Accessibility: the preview container currently is `role="button"` with `aria-label="Click to edit description"`. With the classifier in place the container is no longer uniformly a button, so:
  - keep the keyboard path (`Enter`/`Space` → edit) for the preview,
  - give the new control an accessible name (`aria-label="Edit description"`),
  - ensure the AC row toggle is reachable by keyboard — the checkbox input itself stays a native focusable control and remains the keyboard-accessible toggle path (row-click is a pointer convenience only).

**Styling:** `apps/tasks/src/styles/editor.css` — enlarge the AC row hit area (padding on the task-list `li` inside `.description-preview`) so the pointer target matches the "large enough hit area" requirement, and style the new edit control consistently with the existing design-system `Button` usage already in this file. No new colour tokens; reuse the existing design system components (`@sindustries/ui/react`).

### 3. Tests (AC1, AC2, AC3, AC4)

**Primary files:**

- `apps/tasks/src/components/TaskEditor.test.jsx` (extend)
- `apps/tasks/src/components/MarkdownContent.test.jsx` (new — component-level classifier coverage)
- `apps/tasks/test/e2e/description-edit-targets.spec.js` (new — Playwright)

Component tests (jsdom + Testing Library, matching the existing `TaskEditor.test.jsx` patterns):

- clicking the checkbox toggles the description and does **not** switch to the textarea;
- clicking the AC text inside a task-list row toggles that checkbox and does **not** switch to the textarea (AC1);
- Cmd-click (and Ctrl-click) on a link does **not** switch to the textarea, and the event is **not** `preventDefault`ed, so native new-tab behaviour survives (AC2);
- plain click on plain description text still enters edit mode (AC3);
- the explicit "Edit description" control enters edit mode (AC3);
- clicking a link inside an AC row opens the link and does not toggle the checkbox.

E2E (Playwright, `apps/tasks/test/e2e/`, existing harness):

- open a task with an AC list and a URL in the description, click the AC text → the checkbox toggles and the description stays read-only (no textarea appears);
- Cmd/Ctrl-click the URL → a new tab/page opens and the description stays read-only;
- click plain description text → the textarea appears, edit and blur.

### 4. Documentation (app spec + system doc)

- `apps/tasks/SPEC.md` — describe the interaction contract: which regions are checkbox targets, which are link targets, and how inline editing is entered (required by `agents/definitions/rowan/DoD.md:19` because this is user-visible behaviour change).
- `docs/systems/tasks.md` — one paragraph recording the interaction boundary in the Tasks UI section (interaction classification is UI-local; the API contract is unchanged). Keep it high-level per `docs/CONVENTIONS.md` consolidation bias; do not create a new system doc.
- This design moves to `status: shipped` with `shipped_pr`/`shipped_date` in the implementation PR.

## Data model / API contract changes

None. No Prisma schema change, no Tasks API route change, no request/response shape change. The description patch path (`onPatch` → existing description replace endpoint) is used exactly as it is today; only *when* the UI decides to send it changes.

## Workflow / cron / skill changes

None. No agent workflow, cron, skill, or `.openclaw` file is touched.

## `.openclaw` boundary

None. No workspace, agent, or Gateway configuration change is required. The change is confined to `apps/tasks` and `docs/`.

## Test plan and AC verification matrix

| AC | Verification | Planned tests |
|---|---|---|
| AC1 | Clicking the checkbox or the AC row toggles the AC checkbox and never enters inline text edit mode (no textarea appears) | `TaskEditor.test.jsx` (row-click and checkbox-click cases), `MarkdownContent.test.jsx` (classifier), Playwright `description-edit-targets.spec.js` |
| AC2 | Cmd/Ctrl-click on a URL does not enter edit mode and does not `preventDefault`, so the browser opens it in a new tab | `TaskEditor.test.jsx` (metaKey/ctrlKey cases, assert no textarea + event not default-prevented), Playwright popup/new-page assertion |
| AC3 | Checkbox toggling still persists the description change; plain URL opening still navigates; plain-text click still enters edit mode; explicit "Edit description" enters edit mode | `TaskEditor.test.jsx` (regression cases), Playwright happy-path regression |
| AC4 | Automated coverage exists for the checkbox mis-click boundary and the Cmd-click URL interaction | The test files named above, wired into the existing `tasks app tests` CI job and the `tasks app e2e (ui + api + db)` job |

Required local gates before the PR is opened:

- `pnpm --filter @sindustries/tasks test` (Vitest, jsdom)
- Tasks Playwright spec: `description-edit-targets.spec.js`
- `pnpm --filter @sindustries/tasks build`
- `git diff --check`

E2E note: the Cmd-click new-tab assertion is feasible in Playwright via the `page.waitForEvent('popup')` / `context.waitForEvent('page')` API, so no fallback layer is needed for AC2.

## Risks and mitigations

1. **Over-capturing clicks (the AC row swallows clicks meant for text selection).** Mitigation: the classifier only claims clicks inside `li` elements that actually contain a task-list checkbox; plain text and headings keep their current behaviour. Risk accepted: selecting AC text by dragging requires leaving the row first — acceptable, and the explicit Edit control covers editing that text.
2. **Index drift between rendered checkboxes and `toggleMarkdownTaskCheckbox`.** Both already rely on rendered order matching the markdown source line order. The row path must reuse the *same* index space (`querySelectorAll('input[type="checkbox"]')` position), not a per-row counter. Mitigation: a unit test that toggles the second AC in a two-AC description and asserts the correct markdown line changed.
3. **Regression to comment rendering.** `MarkdownContent` is also used for comment bodies. Mitigation: the classifier only acts when a handler prop is supplied; existing comment tests stay green.
4. **Keyboard accessibility regression** when the preview stops being uniformly click-to-edit. Mitigation: the checkbox input stays natively focusable and is the keyboard toggle path; the preview keeps `Enter`/`Space` → edit; the new edit control is focusable and labelled.
5. **The `role="button"` preview semantics.** With mixed interaction targets inside, `role="button"` on the container is no longer strictly correct for assistive tech. Mitigation: keep the container's keyboard edit path, expose the new explicit control, and evaluate `role="group"` with an accessible description during implementation; note it as a design-review item rather than silently leaving a misleading role.

## Open questions / decisions needed

1. **Should an AC row click toggle the checkbox, or be inert?** This design implements "toggle" (matches the "hit areas are large enough" wording and gives a bigger, more forgiving target). Alternative: the row is inert and only the checkbox itself toggles — one branch change in the classifier plus dropping the row-click test.
2. **Should plain-text click-to-edit be kept at all?** This design keeps it (AC3 "as before") and adds the explicit control. Alternative: make editing explicit-only (remove click-to-edit entirely), which is cleaner but changes an established gesture.
3. **Is a row-click toggle consistent with the card view?** The Tasks card view renders acceptance criteria read-only. If the card view later gets inline checkbox toggling, the same classifier should be reused — but that is out of scope for this task.
4. **Product spec path:** this task originated as a bug report with no `brain/` product spec; `product_spec: n/a` is recorded. Confirm no product spec exists that should be linked.

## Delivery sequence

1. Quinn approves (or amends) this design, especially Open Question 1.
2. Implement the classifier in `MarkdownContent` + the explicit edit affordance in `TaskEditor` + CSS.
3. Component tests, then Playwright spec.
4. Update `apps/tasks/SPEC.md` and `docs/systems/tasks.md`; flip this design to `status: shipped` in the implementation PR.
5. Open a **draft** PR, assign `rowanstoffer`, request reviewers `quinnstoffer` (blocking) and `Stoff81` (visibility), then convert to ready-for-review and post `[implementer-prs] <url>` on the task.
