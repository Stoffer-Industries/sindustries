---
status: draft
task_id: 7c008472-8c99-4151-bf42-79771ece6457
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Task Cards Overflowing Their Containers — Tech Design

**Task:** `7c008472-8c99-4151-bf42-79771ece6457` — Fix task cards overflowing their containers
**Branch:** `task-7c008472-task-card-overflow-containment`
**Worktree:** `/Volumes/WD1/worktrees/rowan/task-7c008472-task-card-overflow-containment`
**Repository:** `Stoffer-Industries/sindustries`
**Owner:** Rowan
**Task type:** `code`
**Reported on:** prodlike Tasks board, Acceptance lane, task `5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c`

## Product intent

On the prodlike Tasks board, task `5cb4a8fe` ("Add stable app-name hostnames for staging and production") visibly extends beyond the width of its board column. Other cards in the same lane are correctly contained. The board is the primary way anyone reads the task pipeline, so a card that bleeds into the neighbouring lane makes the board unreadable and hides the fact that the card's own content is not being contained.

The intent is a **layout guarantee**, not a cosmetic patch: every task card stays inside its column at every viewport, whatever content the task carries, and the guarantee is enforced by automated tests so it cannot silently regress.

## Current state

### The board's column sizing is already correct

`apps/tasks/src/styles/task.css:154-163`:

```css
.board {
  align-items: stretch;
  display: grid;
  flex: 1;
  gap: 12px;
  grid-template-columns: repeat(var(--visible-columns, 5), minmax(0, 1fr));
  max-width: none;
  min-height: 100%;
  width: 100%;
}
```

`minmax(0, 1fr)` is the important part: it lets a track shrink below its content's intrinsic width. Without the `0` minimum, a `1fr` track is floored at `auto` (min-content) and the whole board grows instead of the columns shrinking. **The board itself is not the bug** — the tracks do shrink, and at `max-width: 768px` the board switches to `repeat(var(--visible-columns, 5), minmax(240px, 1fr))` with `overflow-x: auto`, which is the intended narrow-viewport behaviour.

The overflow happens *inside* a column, between the column track and the card's own content box.

### The containment chain is missing `min-width: 0` at every level

The chain from the column down to the card content is:

| Level | Selector | Declaration | `min-width` |
|---|---|---|---|
| Column | `.si-card-container--column ol` | `display: flex; flex-direction: column; flex: 1;` (`task.css:165-173`) | **absent** |
| List item | `li` (unclassed, `App.jsx:820`) | flex item of the column | **absent** |
| Card | `.board-card` / `.task-card` | `display: grid; gap: 12px; width: 100%;` (`task.css:2-8`) | **absent** |
| Card body | `.task-card-editor` | `display: grid; gap: 12px; width: 100%;` (`editor.css:2-6`) | **absent** |
| Editor fields | `.editor-fields` | `display: grid; gap: 12px;` (`editor.css:71-74`) | **absent** |
| Title | `.task-card-title` | `width: 100%;` button (`task.css:23-36`) | n/a — no break rule |
| Title input | `.task-card-title-input.si-input` | `flex: 1;` (`task.css:38-50`) | n/a |
| Footer | `.task-card-footer` | `display: flex;` (`task.css:58-63`) | n/a |
| Footer tags | `.task-card-footer-tags` | `flex: 1; min-width: 0;` (`task.css:65-72`) | **present** ✓ |
| Footer meta | `.task-card-footer-meta` | `flex-shrink: 0;` (`task.css:74-80`) | n/a |
| Description | `.description-preview` | `overflow: hidden; min-width: 0;` (`editor.css:408-420`) | **present** ✓ |
| Markdown | `.markdown-body` | `min-width: 0; overflow-wrap: anywhere; word-break: break-word;` (`editor.css:462-468`) | **present** ✓ |

**Grid and flex items default to `min-width: auto`, which resolves to the item's *min-content* size — not zero.** The one place that has been fixed is the footer tags (`min-width: 0` on `.task-card-footer-tags`, `task.css:65-72`), which is the tell: somebody already hit this class of bug once and patched the single element that was visibly misbehaving, rather than the chain that causes it. Every other level of the chain still floors at min-content.

The consequence: when a card's content has a large min-content width, that width propagates *up* the chain. The card's min-content width becomes the column's min-content width, the column overflows its `minmax(0, 1fr)` track (the track is 0-floored, so the item overflows the track rather than growing it), and the card visibly bleeds into the neighbouring lane. The `minmax(0, 1fr)` on `.board` protects the *other* columns from being pushed wider; it does not protect the overflowing column from spilling.

### What makes this task the one that breaks

Task `5cb4a8fe`'s description is 8 044 characters and contains the longest unbreakable tokens on the board:

| Length | Token | Kind |
|---|---|---|
| 67 | `task-5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c-stable-app-name-hostnames` | branch name, inline code span |
| 59 | `https://github.com/Stoffer-Industries/sindustries/pull/1020` | PR URL |
| 58 | `https://github.com/Stoffer-Industries/sindustries/pull/973` (and 6 more) | PR URLs |
| 49 | `.github/workflows/stable-hostname-live-verify.yml` | workflow path, inline code span |
| 46 | `task-5cb4a8fe-harness-transport-classification` | branch name |

For comparison, the card's own title — "🔧 Add stable app-name hostnames for staging and production" — contains **no** token longer than 11 characters. The title is not what overflows; the **long content** is. That is why "other task cards appear correctly contained" while this one does not: this is the only task whose body carries a 67-character unbreakable identifier.

The relevant nuance in CSS: `overflow-wrap: anywhere` and `word-break: break-word` behave **differently for min-content sizing**. `overflow-wrap: anywhere` allows the min-content contribution of the text to be reduced to the smallest character, so it protects a block whose *own* width is constrained. `word-break: break-word` does **not** affect min-content sizing. `.markdown-body` sets both (`editor.css:462-468`), so the markdown body itself is well-behaved — but `.markdown-body` is only one of the possible content sources, and the chain that carries min-content upward (the grid levels in the table above) has no `min-width: 0` at all.

### A second, independent contributor: the card's rotation

`packages/ui/src/react/kit-pulse.css:112-120`:

```css
.si-card--pulse {
  ...
  padding: 14px 16px;
  transform: rotate(var(--si-card-rotate, 0deg));
}
```

with tilt classes from `--si-card-rotate: -0.85deg` (`kit-pulse.css:159-171`), applied per task via `taskCardTilt(task.id)` (`apps/tasks/src/utils/helpers.js:74`, used at `App.jsx:738` and `App.jsx:824`).

`transform: rotate()` does not affect layout — the rotated card keeps its layout box but its **visual** bounding box becomes larger. For a card of height *H* rotated by *θ*, the visual bounding box is approximately `W·cos θ + H·sin θ` wide. At `θ = 0.85°` (`sin θ ≈ 0.0148`), a 1 000 px-tall card overhangs by ~15 px horizontally, ~7 px each side; a 2 000 px-tall card overhangs by ~30 px, ~15 px each side.

This matters because task `5cb4a8fe`'s expanded card is one of the tallest on the board (8 KB description), and the report is specifically about the **Acceptance lane**, where cards are stacked vertically. The overhang scales with height, so the tallest card in a lane is the one that visibly crosses the column boundary — which matches the report's "other task cards appear correctly contained".

**The two contributors are additive and independent.** A `min-width: 0` fix alone leaves the rotation overhang; a rotation fix alone leaves the min-content propagation. The implementation must establish which contributor dominates at the reported viewport — **by measurement, not by assumption** — and address both, because AC1 and AC2 are containment guarantees, not a single-cause patch.

## Scope

**In scope**

- Identify the precise overflow mechanism by reproduction (the task explicitly asks for this: "Investigate the card layout and long-content handling ... and fix the underlying cause rather than adding a task-specific workaround").
- Establish containment for **every** task card in **every** state (collapsed, expanded/editing, and the editor preview strip) at desktop and narrow viewports (AC1, AC2, AC3).
- Add automated regression coverage that fails if any card overflows its column (AC4).

**Out of scope**

- Redesigning the board's visual language, tilt angles, or card styling. Containment is the goal; the cards keep their look.
- Changing how the Tasks API returns or truncates descriptions. The overflow is a client-layout defect, not a data defect.
- Content-level mitigation (shortening descriptions, truncating URLs in data). Explicitly excluded by the task: the fix must be the underlying cause, not a workaround for this one task.
- The board's intentional horizontal scroll at ≤ 768 px. `minmax(240px, 1fr)` + `overflow-x: auto` there is designed behaviour — narrow-viewport testing must assert **cards stay inside their column**, not that the board never scrolls.

## Ownership boundary

**Natural source of truth: UI-local state.** This is a pure client-side layout defect. The correct home for the fix is the Tasks app's own stylesheet, where the card/column layout is defined. It is **not**:

- an API concern — the Tasks API returns the description verbatim and correctly; truncating or re-shaping it there would corrupt data for every other consumer (the agent queue, the CLI, `gh` views);
- a shared design-system concern — the `Card` primitive in `packages/ui/src/react/kit-pulse.css` is used by other apps, and its rotation behaviour is intentional. Changing the primitive's overflow semantics to fix one app's board would risk every other consumer for no benefit. The fix belongs in the **Tasks app's** layout rules, where the board's column contract lives.

**Decision: fix the containment chain in `apps/tasks/src/styles/`, with the primitive left alone.**

`min-width: 0` on the grid/flex chain is not a workaround — it is the *declared intent* of the chain. `minmax(0, 1fr)` on `.board` already states that columns may shrink below content size; the levels below it were simply never told the same thing. Fixing it there makes the whole chain consistent, fixes every present and future long-content task, and needs no per-element exception list.

## Implementation plan

### WS1 — Reproduce and measure before changing anything

**No code changes in this workstream.** Its output is a recorded measurement that identifies the dominant contributor.

1. Seed a task carrying the offending content shape — a description with a 67-character unbreakable branch-name token and several 58+ character URLs — and render it in a board lane.
2. Reproduce at the **affected desktop viewport** and at a **narrower responsive viewport**, in both the collapsed and expanded card states.
3. Measure, in the browser, for the overflowing card:
   - `card.getBoundingClientRect()` vs the lane's `getBoundingClientRect()` — is the card's *layout* box wider than the column, or is the layout box contained and only the *painted* (rotated) box exceeding it?
   - `card.scrollWidth` vs `card.clientWidth` — is there internal content overflow, or does the card merely paint outside?
   - The width of the widest descendant (`min-content` contributor) and which element it is.
4. Record the numbers in the PR body.

This split matters because the two contributors have **different fixes** (see WS2 and WS3), and fixing only the one that happens to reproduce first would leave the other live. The measurement decides which is dominant; the design below fixes both.

### WS2 — Contain the layout chain (AC1, AC2)

**File:** `apps/tasks/src/styles/task.css` and `apps/tasks/src/styles/editor.css`

Add `min-width: 0` to the grid/flex levels that currently lack it, so no level floors at min-content:

- `.si-card-container--column ol` (`task.css:165`) — the column list itself.
- `.board-card` / `.task-card` (`task.css:3`) — the card grid.
- `.task-card-editor` (`editor.css:2`) — the expanded card grid.
- `.editor-fields` (`editor.css:71`) — the editor's field grid.

**Why `min-width: 0` and not `overflow: hidden`.** `overflow: hidden` would clip content that still does not fit, silently hiding it — for a task card that means hiding acceptance criteria or a URL the operator needs to read. `min-width: 0` lets the card shrink to its column and lets its *contents* then decide how to fit, which is what the wrapping rules below are for.

**Companion break rules.** `min-width: 0` lets the box shrink; it does not by itself make long words fit. The text-level rules must accompany it:

- `.task-card-title` (`task.css:23`) — the title is a `<button>`; add `overflow-wrap: anywhere;` so a long unbroken title wraps instead of setting the card's min-content width.
- Any text surface inside the card that can carry a URL or branch name and is *not* already covered by `.markdown-body`'s rules (`editor.css:462-468`) — audit the editor's comment body, dependency rows, and title input. `.markdown-body` already sets `overflow-wrap: anywhere; word-break: break-word;`, which is the correct pairing; the audit confirms each candidate surface either inherits those or needs the same pair added.

**The fix must be class-level, not task-level.** No selector may reference `5cb4a8fe`, a task id, a task title, or a specific length threshold. The rule is "cards contain their content", expressed as a property, not as a special case.

### WS3 — Handle the rotation overhang (AC1)

**File:** `apps/tasks/src/styles/task.css` and/or `packages/ui/src/react/kit-pulse.css`

If WS1's measurement confirms the painted-box overhang is a material contributor, the containment guarantee must include it — a card whose painted pixels cross the column boundary fails AC1 even when its layout box is contained.

Two candidate approaches, to be chosen by the WS1 measurement:

- **(a) Contain the painted box.** The board's lane clips or masks at its boundary, so a rotated card's overhang is clipped to the column. Preserves the tilt aesthetic; requires the lane to establish a clipping context that does not clip the card's *shadow* in a way that looks broken (the cards use `box-shadow: 5px 5px 0` hard shadows — a hard clip at the column edge would cut those off visibly).
- **(b) Neutralise the overhang's horizontal component.** The overhang comes from `sin θ · H`, so it grows with card height. Reducing the effective rotation for tall cards, or applying the rotation to a wrapper that does not affect the card's painted extent, removes the growth term.

**Recommendation: (b)**, because (a) fights the design system's hard shadows and (b) addresses the cause (height-scaled overhang) rather than clipping its symptom. The exact mechanism is decided during implementation once the measurement is in hand.

**This workstream touches `packages/ui/src/react/` only if the shared primitive is genuinely the wrong layer** — and the ownership boundary above says it usually is not. Prefer keeping the change inside `apps/tasks/src/styles/`. If the implementation finds the primitive must change, that is a scope decision for Quinn, not a silent expansion.

### WS4 — Automated regression coverage (AC4)

**File:** `apps/tasks/test/e2e/card-overflow.spec.js` (new)

The Tasks app already has a Playwright e2e harness (`apps/tasks/playwright.config.js`, `testDir: './test/e2e'`) with a `page.route('**/api/v1/**')` fixture pattern for serving a synthetic task list (`apps/tasks/test/e2e/description-edit-targets.spec.js:31`+ is the reference implementation of that pattern). The new spec reuses it.

**The assertion must be geometric, not a screenshot.** A screenshot comparison would encode incidental rendering and would not detect a 2 px overflow reliably. The test asserts containment numerically:

- For a seeded long-content task in a board lane, assert the card's layout box does not exceed its lane's content box — via `boundingBox()` comparison against the lane's box, allowing a small epsilon for sub-pixel rounding.
- Assert `card.scrollWidth <= card.clientWidth` (no internal content overflow) and, for the lane, that the card's right edge does not cross the lane's right edge.
- Assert the same for the **expanded** card state (click the card to select it) — AC3 requires both states.
- Run at **two viewports**: the affected desktop width and a narrower responsive width.

**The seed must be a realistic long-content fixture**, not a synthetic one-character token: a description containing a 67-character unbreakable branch-name token, several 58+ character URLs, and long acceptance-criteria text. A fixture of the wrong shape would let the test pass while the real task still overflows — which is precisely how this defect reached production.

**Also assert the negative case**, so the test cannot pass vacuously: a deliberately overflowing element must be detected by the assertion helper. Without this, a broken selector in the test would make the suite green forever.

### WS5 — App spec and system doc

- `apps/tasks/SPEC.md` — **must be updated.** The containment guarantee is user-visible behaviour ("a task card never extends beyond its column"), and the app spec is the behavioural contract for this app. Add the containment rule to the board/card behaviour section and link the new e2e spec in its e2e coverage table, per the spec's existing structure.
- `docs/systems/` — **no new system doc.** Per `docs/CONVENTIONS.md`, a per-feature UI detail does not warrant a new cross-cutting system document. If an existing system doc already describes the Tasks board layout, it is updated with the containment rule; otherwise the app spec is the correct and sufficient home. Rowan's judgement, stated in the PR body either way.

## Test plan

### AC-by-AC verification matrix

| AC | Verification | Layer | Test |
|---|---|---|---|
| **AC1** — every task card, including `5cb4a8fe`, remains within the width of its board column at the affected desktop viewport | Seed a task with the offending content shape (67-char branch token + 58+ char URLs), place it in the Acceptance lane, and assert the card's layout box is contained by the lane's content box at the affected desktop viewport. The seed reproduces the real task's shape, so the test guards the reported case rather than a proxy for it. | E2E (Playwright) | `apps/tasks/test/e2e/card-overflow.spec.js` (new) |
| **AC2** — long titles, URLs, descriptions, acceptance criteria, and workstream content wrap or otherwise stay contained without causing horizontal overflow | The same fixture varies the long content across the five surfaces the AC names — title, description, acceptance criteria, workstream, and a URL — one per case, asserting `scrollWidth <= clientWidth` and lane containment for each. Each surface is exercised separately so a fix applied to only one surface fails the others. | E2E (Playwright) | same spec, parameterised cases |
| **AC3** — the fix applies consistently to normal and expanded/editing card states and does not break existing card interactions | Each containment case is asserted twice: collapsed card, then expanded card (select the task to open the editor in place). Existing interactions stay green via the **existing** e2e suite — `description-edit-targets.spec.js`, `approval-checkboxes.spec.js`, `dependency-ui.spec.js`, `happy-path.spec.js`, and the others — which must all still pass unchanged. | E2E (Playwright) | same spec + the existing suite as a regression gate |
| **AC4** — automated regression coverage verifies card containment/overflow behaviour, including a long-content task, at desktop and narrower responsive widths | The spec runs its containment assertions at **two** viewport widths (affected desktop + narrower responsive). It additionally includes a **negative case** asserting the containment helper detects a deliberately overflowing element, so the suite cannot pass vacuously. | E2E (Playwright) | same spec |

### Unit coverage

The fix is CSS, so the meaningful regression surface is the e2e layer, not the vitest layer. `apps/tasks/src/components/TaskCardSummary.test.jsx` already unit-tests the card summary component's rendering; no new vitest unit test is planned for a CSS containment rule, because a jsdom unit test does not perform layout and would assert nothing about overflow.

**This is a deliberate choice, recorded per the tech-design requirement:** the containment guarantee is only verifiable in a real layout engine, so the test lives in the Playwright e2e suite, and the ACs are covered there. The existing vitest suite still runs as a regression gate.

### Manual verification

The WS1 measurement (viewport, before/after geometry) is recorded in the PR body as evidence, and the prodlike board is re-checked visually on the Acceptance lane with the real task `5cb4a8fe` before merge.

## `.openclaw` boundary notes

- **No writes to `~/.openclaw/` are required.** This is a client-side layout fix in the Tasks app; it needs no config, no credential, no scheduler change, and no OpenClaw routing change.
- **No API or schema change.** The Tasks API and its Prisma schema are untouched — the description is stored and served verbatim, and this fix is entirely in how the browser lays it out.
- **No shared-package change is expected.** `packages/ui/src/react/kit-pulse.css` is a shared primitive with other consumers; per the ownership boundary, the fix stays in `apps/tasks/src/styles/`. If implementation proves the primitive must change, that is an explicit scope decision to raise with Quinn, not a silent edit.
- The Tasks app deploys independently; no other service is affected.

## Open questions and risks

**Open questions**

1. **What exactly is the "affected desktop viewport"?** The report says "prodlike" without a width. The implementation should measure across the plausible desktop range (and the board's own `--visible-columns` variable changes the column count and therefore the column width at different widths) rather than assume one number. *Rowan will record the measured reproduction in the PR body.*
2. **Should the rotation overhang be clipped or neutralised?** WS3 lays out both options; the recommendation is (b) neutralise, because (a) clips the design system's hard shadows. The final choice follows the WS1 measurement. *This is the one genuinely open design decision and it is deliberately deferred to measurement rather than guessed.*
3. **Does the board's `--visible-columns` variable change the column count responsively?** If the column count changes at a breakpoint, the containment fix must hold across both configurations, not just one. *To be confirmed during WS1.*

**Risks**

1. **`min-width: 0` on a chain that has never had it can change existing layouts.** Removing the min-content floor may make some cards *narrower* than they render today, which could reflow existing boards. **Mitigation:** the containment assertions run across the existing e2e suite and against the seeded board at both viewports; a visual diff of the board before and after is captured in the PR body. This is the main risk of the approach and it is why the change is scoped to a single app's stylesheet rather than the shared primitive.
2. **The fixture may not match the real defect.** If the real overflow is driven by a content shape the fixture does not reproduce, the test passes while the bug lives. **Mitigation:** the seed is derived from the *measured* longest tokens of the real task `5cb4a8fe` (67-char branch name, 58+ char URLs), not invented; and the negative case prevents a vacuous pass.
3. **The two contributors may not both need fixing.** WS3 may turn out to be unnecessary if the measurement shows the min-content chain dominates. Fixing an unnecessary layer risks the reflow risk in risk 1 for no gain. **Mitigation:** WS3 is gated on the WS1 measurement — it is not implemented speculatively.
4. **A new e2e spec can be flaky.** Geometry assertions are sensitive to font loading and animation. **Mitigation:** the rotation is a static `transform` (not animated — only the *hover* state animates), so the settled layout is stable; the assertions allow a small epsilon for sub-pixel rounding; and the spec does not assert on hover states.
5. **Acceptance criteria are never ticked in the task description.** AC checkboxes on the task are Tom's gate, applied at `acceptance`. Rowan's evidence belongs in the PR body only — the implementation must not tick or untick them.

## Out of scope

Restated for the PR body, which must **not** carry the AC checklist:

- Redesigning the board, the card aesthetic, or the tilt angles.
- Truncating, shortening, or re-shaping task descriptions, titles, or URLs in the API or in the data.
- Any task-specific rule keyed to `5cb4a8fe` or to any content length threshold.
- Changing the board's intentional horizontal scroll at ≤ 768 px.
- Changing the shared `Card` primitive's behaviour for other consumers.
