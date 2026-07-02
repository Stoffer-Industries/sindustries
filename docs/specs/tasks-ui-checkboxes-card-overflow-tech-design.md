---
status: draft
task_id: 99982ee9-6077-4cec-b387-bcd56efaa1d6
product_spec: brain/tasks/specs/tasks-ui-checkboxes-card-overflow-2026-07-02.md
shipped_pr: null
shipped_date: null
---

# Tasks UI — Interactive Checkboxes and Card Overflow — Tech Design

## Links

- Task: `99982ee9-6077-4cec-b387-bcd56efaa1d6` (`🔧 Tasks UI: interactive checkboxes and card overflow fix`)
- Product spec: `brain/tasks/specs/tasks-ui-checkboxes-card-overflow-2026-07-02.md`
- App spec: `apps/tasks/SPEC.md` (will gain two flows under "View and edit a task": click-to-toggle AC checkboxes and view-mode wrap behaviour)
- Task API detail: `http://localhost:4001/api/v1/tasks/99982ee9-6077-4cec-b387-bcd56efaa1d6`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-99982ee9-tasks-ui-checkboxes-card-overflow`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surface: `apps/tasks/src/components/MarkdownContent.jsx`, `apps/tasks/src/components/TaskEditor.jsx`, `apps/tasks/src/utils/markdown.js`, `apps/tasks/src/styles/editor.css`, `apps/tasks/src/styles/task.css`
- Test surface: `apps/tasks/src/utils/markdown.test.js`, `apps/tasks/src/components/TaskEditor.test.jsx`, new `apps/tasks/src/components/MarkdownContent.test.jsx`, new `apps/tasks/test/e2e/tasks-ui-checkboxes-card-overflow.spec.js`

No `.openclaw` runtime change. No Tasks API change. No data model change. The Tasks API already does partial-PATCH (single-field description updates persist correctly); the bug is purely in the React component layer.

## Product Summary

The Tasks app's inline editor shows task descriptions as rendered markdown in view mode (a `description-preview` div that becomes a textarea on click). Two UX gaps:

1. **AC1 — Checkbox click does not toggle.** A task description often contains a GFM task list (`- [ ] AC1: ...`). Clicking an AC checkbox currently opens the edit-mode textarea (because the entire `description-preview` is the edit-mode trigger) instead of toggling the checkbox. Users have to enter raw text edit mode to tick or untick an AC. The desired behaviour is: clicking a checkbox toggles its state inline and persists via `PATCH /tasks/:id { description }`, without opening the editor.

2. **AC2 — Markdown content overflows the card.** In view mode, certain markdown children (long URLs in plain text, long words, `<pre>` blocks with no horizontal scroll context, table cells with long strings) push wider than the card and create horizontal overflow. `.markdown-body` has `word-wrap: break-word`, but the parent grid/flex containers along the path lack the constraints needed to actually clip the overflow. The desired behaviour is: markdown content wraps within card boundaries in view mode; no horizontal scrollbar appears at the card level; `<pre>` keeps its own horizontal scroll for long code lines (acceptable internal overflow).

Non-goals: no rich WYSIWYG editing, no changes to edit-mode behaviour, no new AC lifecycle logic (Tom/QA still owns AC checking on the task description).

## Implementation Plan

### 1. Markdown checkbox toggle — `apps/tasks/src/utils/markdown.js`

Add a pure helper next to `renderMarkdown`:

```js
/**
 * Toggle a GFM task-list checkbox on a specific line index.
 * Lines outside the task-list are not considered. Returns the original
 * markdown unchanged when the target line is not a task-list item.
 *
 * @param {string} markdown
 * @param {number} lineIndex - 0-based index relative to the start of the markdown
 * @returns {string} New markdown with the checkbox state flipped on the target line
 */
export function toggleCheckboxInMarkdown(markdown, lineIndex) {
  if (!markdown || typeof markdown !== 'string') return markdown;
  const lines = markdown.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return markdown;
  const target = lines[lineIndex];
  const checkedMatch = target.match(/^(\s*[-*]\s+\[)([ xX])(\])/);
  const uncheckedMatch = target.match(/^(\s*[-*]\s+\[)([ xX])(\])/);
  if (!checkedMatch) return markdown;
  const [, prefix, current, suffix] = checkedMatch;
  const next = current.toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIndex] = `${prefix}${next}${suffix}${target.slice(checkedMatch[0].length)}`;
  return lines.join('\n');
}
```

Behavioural contract:

- Returns markdown unchanged when the target line does not match a GFM task-list pattern.
- Flips `[ ]` → `[x]` and `[x]` → `[ ]` (case-insensitive on the existing state).
- Preserves indentation and trailing text on the line.

### 2. Markdown content click delegation — `apps/tasks/src/components/MarkdownContent.jsx`

Extend the component to accept an optional `onCheckboxToggle` prop. Use event delegation on the wrapper `<div>` so we don't need to mutate the rendered HTML:

```jsx
export function MarkdownContent({ markdown, className = '', onCheckboxToggle }) {
  const html = renderMarkdown(markdown);

  function handleClick(event) {
    const target = event.target;
    if (!target?.matches?.('input[type="checkbox"]')) return;
    if (typeof onCheckboxToggle !== 'function') return;
    const item = target.closest('li.task-list-item');
    if (!item) return;
    const list = target.closest('.markdown-body');
    if (!list) return;
    const items = Array.from(list.querySelectorAll(':scope > ul > li.task-list-item, :scope > ol > li.task-list-item'));
    const lineIndex = items.indexOf(item);
    if (lineIndex < 0) return;

    event.preventDefault();
    event.stopPropagation();
    onCheckboxToggle(toggleCheckboxInMarkdown(markdown, lineIndex));
  }

  if (!html) return null;
  return (
    <div
      className={`markdown-body ${className}`.trim()}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

Notes:

- The line index is computed against rendered `<li.task-list-item>` siblings, which is the same set the parser rendered, so it aligns with `toggleCheckboxInMarkdown`'s expectations (each `<li>` maps to a task-list line, in order).
- `event.stopPropagation()` prevents the `description-preview`'s click-to-edit handler from firing.
- The handler no-ops gracefully when `onCheckboxToggle` is not provided (preserves existing call sites like `comment-body` rendering at line 566).

### 3. Editor wiring — `apps/tasks/src/components/TaskEditor.jsx`

Add a new optional prop `onPersistDescription(taskId, newDescription): Promise<boolean>` to `TaskEditor`. The editor passes a handler to `MarkdownContent` that:

1. Computes the toggled markdown via the helper above (already done in `MarkdownContent`).
2. Calls `onDraftChange({ ...draft, description: newDescription })` so the editor's draft state stays in sync (does not mark dirty in a way that triggers a "Save" prompt — the checkbox toggle is its own micro-save).
3. Calls `onPersistDescription(task.id, newDescription)` to write through to the API immediately.
4. On failure, calls `onDraftChange` with the previous description to revert the optimistic UI, and surfaces a toast via a new `onError` callback or by returning the failure to the parent (see step 4).

Because checkbox toggles go through the API immediately and the parent re-fetches the task, the draft should already be re-synced after the PATCH. The local `onDraftChange` call is purely so the textarea is correct if the user opens edit mode mid-flight.

The existing `description-preview` click handler stays unchanged for non-checkbox clicks.

### 4. App-level wiring — `apps/tasks/src/App.jsx`

Add an `onPersistDescription(id, description)` handler that calls the existing `patchTaskRequest` (already wrapped by `patchTask` at line 259). On success, refresh the task in state. On failure, surface a toast and revert the draft via the existing `setSelectedDraft` machinery.

Re-use the existing `patchTask(id, { description })` flow rather than introducing a new path. The handler should not block on draft dirty state — checkbox toggles are explicit one-shot saves.

### 5. Card overflow fix — CSS

Two related issues, both in view mode:

- The `.task-card-editor` grid container can grow beyond its parent's intrinsic width when its children (`.description-preview` → `.markdown-body`) contain non-wrapping content. CSS Grid items default to `min-width: auto`, which is the min-content size of their children — long URLs and code blocks can blow this past the card.
- `.markdown-body` has `word-wrap: break-word` but the parent containers along the path don't clip overflow.

Changes:

In `apps/tasks/src/styles/task.css`:

```css
.task-card,
.board-card {
  /* existing rules plus: */
  min-width: 0;
}

.editor-fields {
  /* new rule */
  min-width: 0;
}
```

In `apps/tasks/src/styles/editor.css`:

```css
.task-card-editor {
  /* existing rules plus: */
  min-width: 0;
}

.description-preview {
  /* existing rules plus: */
  min-width: 0;
  overflow-wrap: anywhere;
}

.markdown-body {
  /* replace word-wrap: break-word with the modern equivalent and apply it
     broadly so inline text and links wrap correctly */
  overflow-wrap: anywhere;
  word-break: break-word;
}

.markdown-body p,
.markdown-body li {
  overflow-wrap: anywhere;
}

.markdown-body a {
  /* long URLs must break inside the link text */
  overflow-wrap: anywhere;
}

.markdown-body table {
  table-layout: fixed;
}

.markdown-body td,
.markdown-body th {
  overflow-wrap: anywhere;
}

.markdown-body pre {
  /* preserve horizontal scroll inside code blocks (acceptable internal overflow) */
  overflow-x: auto;
  max-width: 100%;
}
```

The `table-layout: fixed` change is needed so table cells divide width by column count rather than min-content width of cell contents.

### 6. Tests

#### Unit tests — `apps/tasks/src/utils/markdown.test.js`

Add to the existing `describe('renderMarkdown')`:

- `toggleCheckboxInMarkdown flips [ ] to [x]` — input `- [ ] foo\n- [x] bar`, toggle line 0 → `- [x] foo\n- [x] bar`.
- `toggleCheckboxInMarkdown flips [x] to [ ]` — toggle line 1 → `- [ ] foo\n- [ ] bar`.
- `toggleCheckboxInMarkdown preserves indentation` — input `  - [ ] foo`, toggle line 0 → `  - [x] foo`.
- `toggleCheckboxInMarkdown ignores non-task-list lines` — input `- item`, toggle line 0 → `- item` (unchanged).
- `toggleCheckboxInMarkdown handles out-of-range index` — input `- [ ]`, toggle line 5 → unchanged.

#### Component tests — new `apps/tasks/src/components/MarkdownContent.test.jsx`

- `renders markdown and forwards clicks on non-checkbox elements` — click on a `<strong>` element does NOT call `onCheckboxToggle`.
- `calls onCheckboxToggle when a checkbox is clicked and stops propagation` — clicking an `<input type="checkbox">` inside `<li.task-list-item>` invokes `onCheckboxToggle(newMarkdown)` with the toggled string, and `event.stopPropagation` is honoured (verified via a sibling click handler spy).
- `does nothing when onCheckboxToggle is not provided` — clicking a checkbox does not throw and does not navigate to edit mode (we can verify via a wrapper).

#### Component tests — `apps/tasks/src/components/TaskEditor.test.jsx`

Add to the existing `describe('TaskEditor')`:

- `clicking a checkbox toggles it without opening edit mode` — render with a description containing `- [ ] foo\n- [x] bar`, click the first checkbox; assert `onPersistDescription` was called with the toggled string; assert the `Detail description` textarea is NOT in the document.
- `clicking the description preview (non-checkbox area) still opens edit mode` — click on a `<strong>` element in the rendered markdown; assert the textarea is now in the document.
- `checkbox toggle failure reverts the draft` — `onPersistDescription` resolves to `false`; assert `onDraftChange` was called twice (once with the new description, once with the previous description to revert).

#### E2e — new `apps/tasks/test/e2e/tasks-ui-checkboxes-card-overflow.spec.js`

Single Playwright spec:

- **AC1 (toggle):**
  1. Open a task with a description containing `- [ ] AC1: foo` and `- [ ] AC2: bar`.
  2. Assert both checkboxes are present and unchecked.
  3. Click the first checkbox.
  4. Assert the first checkbox is checked, the second is not.
  5. Reload the page (or refetch the task via the API).
  6. Assert the first checkbox is still checked after reload.
  7. Assert the editor was NOT opened at any point (the description textarea never appeared).

- **AC2 (overflow):**
  1. Open a task with a description containing a long URL (`https://example.com/<200-char-path>`), a long word (`supercalifragilisticexpialidocious` repeated 5 times), a `<pre>` block with a long line, and a markdown table with long cell values.
  2. Read the bounding box of `.task-card-editor` (the editor card) and the bounding box of `.markdown-body`.
  3. Assert `markdownBody.right <= taskCardEditor.right` (no horizontal overflow).
  4. Assert the `<pre>` block has its own horizontal scrollbar (internal overflow is acceptable).
  5. Assert no horizontal scrollbar on the editor card's parent chain.

## Test Plan

- Unit + component tests:
  - `cd apps/tasks && npm test -- --run`
    - `renderMarkdown` suite (existing + new toggle tests) — pass.
    - `MarkdownContent` new suite — pass.
    - `TaskEditor` suite (existing + 3 new toggle tests) — pass.
  - All other vitest suites in `apps/tasks/src/**` — pass.
- E2e:
  - `cd apps/tasks && npm run test:e2e -- tasks-ui-checkboxes-card-overflow.spec.js` — pass.
  - The full happy-path suite still passes (regression).
- Visual smoke:
  - Open a task with a long-URL/long-word description in dev (`npm run dev`) and confirm the card does not overflow horizontally.
  - Click a checkbox in the view-mode description and confirm it toggles inline, persists after refresh, and the editor textarea does not appear.

## Open Questions and Risks

- **Checkbox index alignment:** the line-index calculation is based on the rendered `<li.task-list-item>` siblings. If `marked` ever nests task lists (it doesn't currently in our config), the index could desync. Risk is low — `marked` task lists are flat by default. If a future spec needs nested task lists, the helper needs to take a DOM element instead of an index.
- **Optimistic update + revert:** checkbox toggles are optimistic. If the API rejects (e.g. transient network), the editor reverts the draft via `onDraftChange`. The revert path is simple because `onDraftChange` is already wired. No background sync logic needed.
- **Comment body Markdown:** line 566 also renders comments via `MarkdownContent`. We will NOT pass `onCheckboxToggle` there — comment markdown is not editable by users via checkbox toggle. The new prop is optional, so the existing comment renderer is unchanged.
- **DOM event delegation:** `event.target.matches` is supported in all browsers we ship to. No polyfill needed.
- **Accessibility:** the `<input type="checkbox">` inside markdown remains a native checkbox, so keyboard interaction (Space toggles) and screen-reader semantics continue to work. We do not add custom `aria-label` to the toggled element — the surrounding line text provides context.

## App SPEC.md updates

Append two entries to `apps/tasks/SPEC.md` "Flows" section (under "View and edit a task"):

- 9. Click an AC checkbox in view mode to toggle it without entering edit mode.
- 10. Markdown content wraps within card boundaries in view mode; `<pre>` blocks retain their own horizontal scroll.

Add an E2e coverage row linking the new spec file.

## Tasks API

No API change. `PATCH /tasks/:id` with `{ description }` is already supported (see `services/tasks-api/src/routes/tasks.ts`). Single-field description updates persist correctly (verified via the `tasks-api-patch-description-replace` task).

## System doc

No durable system change. `apps/tasks` is a standalone surface — there is no `docs/systems/tasks-app.md` and none is needed for this scope.