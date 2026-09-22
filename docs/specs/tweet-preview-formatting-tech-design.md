---
status: draft
task_id: d06edf9a-79eb-433a-b08c-2fa410de496f
product_spec: null
shipped_pr: null
shipped_date: null
---

# Tweet Preview Formatting — Tech Design

## Links

- Task: `d06edf9a-79eb-433a-b08c-2fa410de496f` (`💻 Fix tweet preview formatting in Content Scheduler`)
- Task API detail: `http://localhost:4001/api/v1/tasks/d06edf9a-79eb-433a-b08c-2fa410de496f`
- Bug surface: `apps/mission-control/src/tabs/SchedulerItemCard.jsx` — queued/approved tweet preview collapses paragraph breaks and visible list-item separation that the edit view preserves.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-d06edf9a-tweet-preview`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-d06edf9a-tweet-preview`
- Primary code surfaces:
  - `apps/mission-control/src/tabs/SchedulerItemCard.jsx` — apply `white-space: pre-wrap` (plus `overflow-wrap: break-word`) to the three body renderers that today drop into a plain `<p>` / `<span>`: the single-item preview, the thread root body preview, and the thread reply-part preview. Add `data-body-text` for the single-item path so the test can target the rendered text deterministically.
  - `apps/mission-control/src/styles/components.css` — extend `.content-scheduler-row__body`, `.content-scheduler-row__thread-root`, and `.content-scheduler-row__thread-part-body` with a single shared utility class that applies `white-space: pre-wrap; overflow-wrap: anywhere;` so paragraph breaks and bullet markers become visible.
  - `apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx` — add three coverage cases that pin the bug-report ACs (multi-paragraph body, bullet-list body, mixed paragraph-and-bullet body) for the queued single-item preview, plus an analogous coverage case for the expanded thread reply-part preview.

No `.openclaw` runtime change. No Tasks API change. No data-shape change. The fix is a UI-only rendering tweak plus a shared CSS utility plus tests that pin the ACs.

## Product Summary

`SchedulerItemCard.jsx` renders a Content Scheduler item in one of two states:

- **Edit view** (`editing && !isThread`, line ~114): wraps `<Textarea>` from `@sindustries/ui/react` (a native `<textarea>`). A native `<textarea>` preserves every character verbatim — `\n` shows as a visible line break, leading whitespace indents bullets, and bullet markers (`- `, `* `, `• `) are visible.
- **Preview view** (`!editing`, line ~138 for single items, line ~131 for thread root, line ~119 for thread reply parts): wraps the body in a plain `<p>` (single item + thread root) or `<span>` (thread reply parts). HTML collapses every whitespace run — including `\n` — to a single space, and a `<span>` strips indentation entirely.

The result, observed in the queued / approved column and in the thread reply-part list: a tweet body that has multiple paragraphs and bullet items renders in the preview as a single dense text block, while the same body in the edit view shows paragraphs visibly separated and bullet items visibly indented. Tom has to click into the edit view to verify that his queued content actually contains the paragraphs and bullets he typed — there is no way to glance at a queued tweet and confirm its structure.

The fix makes the preview render preserve the same whitespace the editor preserves. Native `<textarea>` semantics render newlines as visible line breaks; the same semantics are needed on the preview side. Using `white-space: pre-wrap` on the three preview wrappers does exactly that, with two additions:

1. `overflow-wrap: anywhere` (instead of `break-word`) so long unbroken strings (URLs without dashes, hashtag strings, a vanity run of letters) wrap onto a new line at viewport edge rather than push the card wider than its column.
2. A shared CSS utility class so the three body renderers share the same `white-space` / `overflow-wrap` values, so a future regression in one path is visible in all three at once and tests don't need to be duplicated per renderer.

The thread reply-part layout (line ~155) is flex with `.content-scheduler-row__thread-part-label` (1.5em fixed width) on the left and `.content-scheduler-row__thread-part-body` (flex-grow) on the right. The fix wraps the body in a `<span class="content-scheduler-row__thread-part-body content-scheduler-row__body-text">` so the `white-space: pre-wrap` applies to the inner span only — the layout's flex gap stays unaffected and the label column stays fixed-width. Pre-wrap on an inline `<span>` works because the inner text wraps automatically once whitespace is preserved.

AC3 ("Preview rendering does not alter, omit, duplicate, or expose formatting artifacts in the tweet text") is the boundary that decides *what* shows up on screen versus in the published text. The fix preserves every character: a `<p>` showing `Hello\n\n- alpha\n- beta` after `white-space: pre-wrap` displays two paragraphs and two bullet items, identical characters to the stored body. No content stripping, no marker hiding, no character escaping.

The X publish path passes `body` through verbatim — `contentSchedulerPublishService` calls the X API with `text: input.text` for each part. So whatever Tom sees in the preview is exactly what X sees; the preview is the operator's verification surface for that pipeline.

## Implementation Plan

### 1. Add a shared body-text utility class in `apps/mission-control/src/styles/components.css`

```css
.content-scheduler-row__body-text {
  /* The edit view (native <textarea>) preserves every character
   * verbatim — \n shows as a visible line break, bullet markers are
   * visible, indentation survives. The preview view uses the same
   * `pre-wrap` semantics so a queued / approved item shows the same
   * paragraph and list structure Tom typed. `overflow-wrap: anywhere`
   * lets long unbroken strings (URLs, hashtags) wrap at the column
   * edge instead of pushing the card wider than its column. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  margin: 0;
}
```

`word-break: normal` re-enables normal word-break behaviour (the `overflow-wrap` rule above already takes care of long strings; `word-break: break-all` would be too aggressive and chop normal English words mid-letter). `margin: 0` keeps it inside the existing card layout (the surrounding `<p>` would already neutralise margin, but the `<span>` used for thread parts needs an explicit zero).

### 2. Apply the class to the three preview renderers in `SchedulerItemCard.jsx`

Three call sites; the editor's `<Textarea>` is left untouched because `<textarea>` already preserves whitespace natively.

- **Single-item preview** (current line ~141, the `<p>{item.body}</p>` fallback inside the `!editing ? isThread && normalizedParts` ternary):

  ```jsx
  <p
    className="content-scheduler-row__body-text"
    data-testid={`content-scheduler-body-${item.id}`}
  >
    {item.body}
  </p>
  ```

  Adding `data-testid` here locks the rendered body text to a stable selector the new tests can target. The `data-testid` was previously on the wrapping `<div>` (which also wraps the thread branch); promoting it onto the `<p>` itself makes the single-item path targetable without breaking the thread-path tests that already use the wrapping `<div>` testid.

- **Thread root body** (current line ~131, `<p className="content-scheduler-row__thread-root">{normalizedParts[0].body}</p>`):

  ```jsx
  <p className="content-scheduler-row__thread-root content-scheduler-row__body-text">
    {normalizedParts[0].body}
  </p>
  ```

  Composes the existing `.content-scheduler-row__thread-root` rule (margin: 0; font-weight: 500) with the new utility so the CSS rule order doesn't matter (both rules apply, neither overrides).

- **Thread reply-part body** (current line ~155, the `<span className="content-scheduler-row__thread-part-body">{part.body}</span>` inside the `<li>`):

  ```jsx
  <span className="content-scheduler-row__thread-part-body content-scheduler-row__body-text">
    {part.body}
  </span>
  ```

  Composes with the existing flex layout. Pre-wrap on an inline `<span>` is well-defined: the inner text wraps once `white-space` is `pre-wrap` because the parent's flex container provides a width and `overflow-wrap: anywhere` allows breaks mid-URL. Test coverage in step 3 verifies this on a body with an internal newline (e.g. `"alpha\n\nbeta"` inside one part).

The editor's `<Textarea>` (line ~109 and line ~120 in the same file) is left alone. A native `<textarea>` already renders newlines and leading whitespace verbatim — no fix needed there.

### 3. Add tests in `apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx`

Three new tests pin the bug-report ACs for the single-item preview, and one new test pins the analogous behaviour for the thread reply-part preview. All use the existing `render(<ContentSchedulerTab />)` + `listItems.mockResolvedValue(fixture({...}))` test harness; the existing `fixture` builder is extended for the multi-paragraph / bullet-list body cases.

- **`single-item preview preserves paragraph breaks from a multi-paragraph body`** — extend `fixture()` to return at least one item with `body: 'Intro paragraph\n\nSecond paragraph\n\nThird paragraph'`. Assert `screen.getByTestId(\`content-scheduler-body-${id}\`).textContent === 'Intro paragraph\n\nSecond paragraph\n\nThird paragraph'` and that the wrapping `<p>` has the `content-scheduler-row__body-text` class. The character-equality assertion is the AC3 boundary (no character alteration). The class assertion is the AC1 boundary (whitespace preservation is the load-bearing property, not a happy coincidence).
- **`single-item preview preserves bullet items from a list body`** — extend `fixture()` with `body: 'Three launches this week:\n\n- Mission Control v2\n- GymTrack MCP\n- Sindustries site'`. Same character-equality assertion + class assertion. Covers AC2 (list readability).
- **`single-item preview preserves a mixed paragraph + bullet body` (AC4 body shape)** — extend `fixture()` with `body: 'Spec went green today.\n\nAction items:\n\n- Approve tech design\n- Land Quinn merge\n- Update retro notes'`. Same assertions; covers AC4 (the body containing multiple paragraphs and bullet items).
- **`thread reply-part preview preserves paragraph breaks within one part`** — extend the existing `threadFixture()` with a part whose body contains `\n\n`. Assert `screen.getByTestId(\`content-scheduler-thread-part-${THREAD_ID}-1\`).textContent` equals the part body verbatim and that the inner `<span>` has both `content-scheduler-row__thread-part-body` and `content-scheduler-row__body-text` classes.

A new fixture helper function `singleItemWithBody(body)` is added that wraps a single-item variant of the existing `fixture()` shape. The three single-item tests pass it directly to `listItems.mockResolvedValue`.

The existing `threadFixture()` is extended in place (one new field on the existing `parts` entry); no fixture rename, no test restructure.

Existing structural tests are unchanged. The rendered DOM still wraps each item in the same `<div data-testid="content-scheduler-body-${id}">`, so the existing "renders a thread card as one row" test (line 470) still finds `Root tweet text` and the existing "scheduler row contains the body testid" assertions in the single-item tests still pass against the new `<p>` shape because the wrapper testid moved one element up but the assertions target the rendered text, not the element type.

### 4. Manual visual check (sandbox is enough; no Fly-side change)

Boot `apps/mission-control` (`npm run dev` from the worktree). Open the Content Scheduler tab with three test items in the queue:

1. A queued single tweet with body `'para 1\n\npara 2\n\n- bullet 1\n- bullet 2'`.
2. A queued single tweet with body `'plain one-liner'` (regression baseline — should still render as a single line).
3. A queued thread with one part whose body is `'reply intro\n\nreply body'`.

Confirm in browser that (1) shows paragraphs visibly separated and bullet items indented; (2) renders unchanged (no extra blank line or trailing whitespace); (3)'s part-1, when expanded, shows two paragraphs. A screenshot is sufficient evidence for a UI rendering tweak and matches the precedent on prior visual-fix tasks.

## Ownership boundary check

- **Natural source of truth:** UI-local rendering in `SchedulerItemCard.jsx` and the CSS in `components.css`. The data layer (`buildStackedOwnerLayers` analogue — the `useContentScheduler` data flow) is correct; only the rendered element type and class list are wrong.
- **Incremental-delivery posture:** four added lines (one CSS rule + two className additions + one data-testid promotion) and four new tests. No interim shim — the durable fix is the same shape and same effort as a shim would be.
- **No cross-app / cross-service impact.** The `Textarea` component (`@sindustries/ui/react`) is unchanged. The Content Scheduler API schema, the X publish path, the worker, and the validation layer are all unchanged. No migration. No `.openclaw` boundary touched.
- **No AC checkboxes on the task description.** Per `WORKFLOW.md`, AC toggling is Tom/QA's gate; Rowan's evidence goes in the PR body.

## Data model / API contract changes

None. The Content Scheduler API still returns `body` as a `VARCHAR(1000)`; the X publish pipeline still uses that string verbatim. Only the in-app preview rendering changes.

## Workflow, cron, and skill changes

None. The fix is local to one JSX file, one CSS file, and one test file.

## Test plan — AC verification matrix

| AC | Layer | Plan |
|---|---|---|
| AC1 — queued preview preserves paragraph breaks and list-item separation from the tweet body | Component test | "single-item preview preserves paragraph breaks from a multi-paragraph body" — asserts character-equality on `screen.getByTestId(\`content-scheduler-body-${id}\`).textContent` for body `'Intro paragraph\n\nSecond paragraph\n\nThird paragraph'`, plus class assertion `toHaveClass('content-scheduler-row__body-text')`. |
| AC2 — preview formatting matches the edit view for the same tweet, including wrapping, spacing, and list readability | Component test | "single-item preview preserves bullet items from a list body" + "single-item preview preserves a mixed paragraph + bullet body" — both assert character-equality plus the same class. Manual visual check (`npm run dev`, screenshot in PR body) confirms bullet markers read as visually distinct items and the bulk-style matches the textarea. |
| AC3 — preview rendering does not alter, omit, duplicate, or expose formatting artifacts in the tweet text | Component test | All three single-item tests assert exact character equality (no trim, no replace, no escape). The class assertion pins the *why* (a future regression that strips `\n` would fail the character-equality even if it kept the class, and vice versa). |
| AC4 — fix is verified for queued and approved tweet previews, including a body containing multiple paragraphs and bullet items | Component test | One single-item test exercises a queued item (default `status: 'queued'`); one test exercises an approved item (`status: 'approved'`); the mixed paragraph+bullet body case lives in the queued fixture and is reused. Manual visual check covers both states. |

E2E coverage (Playwright) is **not** planned for this task because:

1. The renderer is already covered by the existing `ContentSchedulerTab.test.jsx` surface (~25 tests), which pins the DOM testids the feature relies on.
2. The fix is a CSS rule plus className additions — the risk surface is the new class choice, not user-flow correctness.
3. A manual visual check (one queued and one approved item with a multi-paragraph body, screenshot in the PR body) is sufficient evidence for a UI rendering tweak and matches the precedent on prior visual-fix tasks.

Falling back to component tests + manual visual is proportionate here; no need to spin up a full Playwright run for a CSS-class change.

## Open questions and risks

- **None blocking.** The bug is fully specified by the task ACs; the fix is a CSS rule plus three className additions plus four new tests.
- **Risk: <span> with `white-space: pre-wrap` does not behave like <p>.** The thread reply parts use an inline `<span>` inside a flex layout. Native browsers handle pre-wrap on inline elements by wrapping the text once the parent has a defined width (the flex container provides this) — the same wrapping behaviour as on `<p>`. The new test asserts this on a body containing `\n\n` to lock it in. If the test fails in jsdom, the fix falls back to rendering the reply-part body inside a `<div>` (which still composes with the flex label layout) — the data-testid and class name stay the same; only the wrapper element changes.
- **Risk: regression of column width on long URLs.** `overflow-wrap: anywhere` is more aggressive than `break-word`; it will wrap inside long URLs at any character. This matches the intent of AC1 ("preserves ... wrapping") and is the correct trade-off here — Content Scheduler cards live in fixed-width calendar columns, and an unbreakable URL would push the card wider than its column. The CSS comment calls this out so a future maintainer doesn't soften the rule.
- **Risk: existing tests silently regress.** The existing `it('renders a thread card as one row with a Thread · N parts badge and a collapsed root preview')` test (line 470) and the other 4 PR-B thread tests assert against `screen.getByTestId(\`content-scheduler-body-${THREAD_ID}\`)` which used to target the wrapping `<div>` and now targets the inner `<p>`. Both contain the body text (the wrapper testid used to wrap the `<p>`'s text), so `textContent` assertions still pass. The DOM-tree shape test (`toHaveTextContent` style) — there is none in the file today — would need to be reviewed if added later. The new tests' class assertions (`content-scheduler-row__body-text` present on the inner element) lock the new DOM shape.
- **Out of scope:** parsing the body into structured blocks (real markdown lists, headings, bold/italic), supporting rich text in the editor, changing the textarea to a rich-text editor, sanitising HTML, switching `white-space` to `pre-line`, exposing format tokens as a separate Content Scheduler field. Any of those would be a separate task.
