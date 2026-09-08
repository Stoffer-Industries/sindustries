---
status: draft
task_id: 3d80fd5a-a94a-4bd2-bd8d-e0021b75a6ef
product_spec: brain/tasks/specs/in-progress/cto-craft-tweet-pipeline.md
shipped_pr: null
shipped_date: null
---

# Tech Design — CTO Craft: paced daily scheduling, source links, and disagreement reasoning (task 3d80fd5a)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/3d80fd5a-a94a-4bd2-bd8d-e0021b75a6ef (full UUID on Tasks API)
**Branch:** `3d80fd5a-cto-craft-pacing-sources-disagreement` (off `origin/main`, commit `a09b796`)
**Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/3d80fd5a-cto-craft-pacing-sources-disagreement`
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-08

---

## Problem

Tom reviewed the first batch of CTO Craft drafts and asked for three related changes to the same import/prompt path:

1. **Pacing** — when a cron run imports a batch of eligible drafts into Content Scheduler, they should be spaced 1/day (staggered `scheduledFor` dates) instead of all landing on the same day/time. Currently every imported draft is created with `scheduledFor: null` and `status: 'draft'` (`services/content-scheduler-api/src/routes/contentSchedulerService.ts:176`), and Tom schedules them by hand in Mission Control.
2. **Per-article link decision** — the angle model should decide per-article whether the tweet earns a link to the source article (not a blanket "no links" rule). When it includes a link, the pipeline enforces the 280-character limit around the URL. Currently `prompts/angle-evaluator.md` says "no links" as a hard rule.
3. **Disagreement reasoning** — when a linked tweet is disagreeing with or pushing back on the article's take, the tweet copy itself must state the reasoning for the disagreement — not just an opinion placed next to a bare link.

All three changes are constrained to the CTO Craft import/prompt path. Existing non-linked, non-disagreement tweet generation must continue to work unchanged (AC4).

## Goals (and non-goals)

**In scope**
- AC1: extend `services/content-scheduler-api` to accept an optional `scheduledFor` per import item (`POST /content-scheduler/imports/cto-craft`), and have the CTO Craft workflow assign staggered dates in NZST (Pacific/Auckland) before posting to the import endpoint.
- AC2: amend `prompts/angle-evaluator.md` so the model can decide per-article whether a link to the source article earns its place in the tweet, and (when it does) the tweet respects the 280-character limit around the URL. Workflow enforces the 280-char budget as a safety net after generation.
- AC3: amend `prompts/angle-evaluator.md` so when the angle is a disagreement / pushback, the tweet copy itself states the reasoning for the disagreement.
- AC4: existing tests and existing FakeAngleModel fixtures continue to pass; the prompt changes are additive (new sections), not a rewrite of existing rules.

**Out of scope**
- A new `include_link: bool` schema field on `AngleOutput`. URL presence/absence in `tweet_body` is the existing schema and is the cleanest audit signal — the workflow and reviewer both detect it from the tweet body directly. Adding a boolean duplicates information that is already derivable.
- Changing the auto-post scheduling or auto-post job path (`contentSchedulerJobs.*`, `autoPostWorker.*`). These operate on `scheduledFor` after it is set; the import-time scheduling is upstream of them.
- Changing the import endpoint auth (`x-content-ingest-secret`) or idempotency model (partial unique index on `(source, sourceRef)`).
- Changing the cron prompt at `agents/crons/prompts/cto-craft-tweet-drafts.md`. The cron is read-only against the implementation branch by design; behaviour changes land via PR on the workflow code.
- A general "scheduling policy" framework that other Content Scheduler sources can opt into. The pacing rule is CTO Craft–specific for now; if a second consumer (e.g. `ops_notes`) needs staggered scheduling, that's a scoped follow-up.
- Removing the `revoked_at` consent check or any agent-consent flow. Out of scope — the only change is to the import/prompt path.

## Source-of-truth docs

- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/angle_model.py` — `AngleOutput` schema, `FakeAngleModel` test fixtures, `_build_openclaw_message` (where the prompt + user message are composed).
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/graph.py:335` — `import_drafts` node (constructs `items` list from `selected_angles`, calls `import_fn`).
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/cli.py:106` — `_build_import_fn` (wires `ImportClient`).
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py` — `ImportClient.import_drafts` (HTTP layer).
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/settings.py` — timezone / date-time configuration surface (verify `zoneinfo` import is already in use).
- `agents/workflows/cto-craft-tweet-drafts/prompts/angle-evaluator.md` — the prompt itself; new sections are added here.
- `agents/workflows/cto-craft-tweet-drafts/prompts/tom-worldview.md` — unchanged.
- `agents/workflows/cto-craft-tweet-drafts/tests/test_angle_model.py`, `tests/test_graph.py`, `tests/test_durability.py` — must continue to pass.
- `services/content-scheduler-api/src/routes/contentSchedulerValidation.ts` — `validateImportItem` / `validateImportItems`.
- `services/content-scheduler-api/src/routes/contentSchedulerService.ts:166-180` — `contentSchedulerServiceRouter.post('/content-scheduler/imports/cto-craft', …)`; the `rows.map(...)` block that hardcodes `scheduledFor: null`.
- `services/content-scheduler-api/test/contentSchedulerAutoPost.test.ts` — import path test coverage; a new test for `scheduledFor` passthrough is added.
- `docs/systems/content-scheduler.md:142` — the "Always creates `source=cto_craft, status=draft, scheduledFor=null, position=0`" line that needs to reflect the optional `scheduledFor`.

## Architecture / approach

### AC1 — Pacing

**Workflow side (CTO Craft) computes the staggered dates.** The Content Scheduler API does not know about CTO Craft batches or pacing rules; it just accepts an optional `scheduledFor` per item, which preserves the existing semantics for any other consumer and keeps the API contract additive.

1. **API extension** (`services/content-scheduler-api`):
   - `contentSchedulerValidation.ts` — `validateImportItem` accepts an optional `scheduledFor` field. When present, it must be a valid ISO 8601 datetime string; otherwise reject with the same `INVALID_SCHEDULED_FOR` shape used by `contentScheduler.ts:165` (consistency, not a new error code). New helper `parseScheduledFor(value: unknown): Date | null | 'INVALID'` follows the existing `parseDate` precedent at `contentScheduler.ts:163`.
   - `contentSchedulerService.ts:176` — replace the hardcoded `scheduledFor: null` with `scheduledFor: schedParsed ?? null` (where `schedParsed` comes from the new helper). Backward compatible: items that omit the field still get `null`.
   - New `services/content-scheduler-api/test/contentSchedulerImport.test.ts` (or extend `contentSchedulerAutoPost.test.ts`): at minimum three cases — `scheduledFor` absent → row has `scheduledFor: null`; valid ISO → row has parsed `Date`; invalid string → `400 INVALID_SCHEDULED_FOR`.
2. **Workflow side** (`agents/workflows/cto-craft-tweet-drafts`):
   - New module `src/cto_craft_workflow/pacing.py` with one pure function:
     ```python
     def stagger_scheduled_for(
         items: list[dict],
         *,
         now: datetime,                     # injected for test determinism
         tz: ZoneInfo = ZoneInfo("Pacific/Auckland"),
         anchor_hour: int = 9,
     ) -> list[dict]:
         """Return items with `scheduledFor` set, staggered 1 day per item.

         The first item lands on the next NZST date at `anchor_hour:00`
         (default 09:00 — Tom's morning window). Each subsequent item
         is offset by +1 calendar day in the same timezone. Weekends
         are not skipped (Tom can reschedule via Mission Control if he
         wants a weekday-only cadence).
         """
     ```
   - `graph.py:343-352` — extend the `items` list construction to call `stagger_scheduled_for` before `deps.import_fn(items)`. The function operates on the dict list directly (no Pydantic round-trip needed) and returns the same dicts with one new key.
   - `tests/test_pacing.py` (new) — covers: 1-item batch, 5-item batch, NZST→UTC conversion around DST boundary (April / September), anchor-hour correctness, idempotency of `stagger_scheduled_for` (calling twice with the same `now` gives identical output).
   - The `FakeAngleModel` fixtures continue producing no-scheduledFor angles; the workflow's `stagger_scheduled_for` adds the field before posting. AC4 holds because no test fixture needs to change.

The pacing rule itself:

- Anchor: **next** NZST calendar day at **09:00 NZST**. Concretely: `today_nzst = now_in_nzst.date()`; `base_date = today_nzst + timedelta(days=1)`; `item[i].scheduledFor = base_date + timedelta(days=i)` at 09:00 NZST, converted to UTC ISO before posting.
- Why "next day": drafts are intended for Tom's editorial review first, so same-day scheduling would race the cron run.
- Why 09:00 NZST: Tom's content-factory cadence lives in NZST morning; this matches `getAucklandTodayParts` (already used in `contentSchedulerPublish.ts`).
- Why no weekend skip: Tom can override via Mission Control. Adding a weekday filter is a separate concern.

### AC2 — Per-article link decision

**Prompt-only change**, plus a post-generation 280-char safety net in the workflow.

1. **`prompts/angle-evaluator.md`** — add a new section "Link policy" between the existing "Style" and "Profile" sections. The new section says (paraphrased in the doc):
   - The model decides per-article whether the tweet earns a link to the source article. A link earns its place when the article is the load-bearing reference (rare data point, specific framework, named failure mode the reader should read to verify the tweet's claim).
   - When a link is included, the URL appears in `tweet_body` and counts as 23 characters for the 280-character budget (X's `t.co` shortener behaviour). The remaining 257 characters are the tweet copy.
   - When a link is not earned, `tweet_body` has no URL (existing behaviour; the section explicitly preserves the no-link default).
   - The schema does not need a new field — URL presence in `tweet_body` is the audit signal.
2. **`graph.py`** — extend the `import_drafts` node to compute the same URL-length-23 accounting before validation. If `tweet_body` length exceeds 280 **and** contains a URL, the node trims to 257 chars + space + the URL (preserving the URL tail) and emits a diagnostic (`code: "TWEET_TRUNCATED_FOR_LINK_BUDGET"`, `message: "<original length>, kept link tail"`). This is a safety net for model overshoot; the prompt's 23-char rule is the primary guard.
3. **`tests/test_angle_model.py`** — new unit test for `import_drafts` node with a 320-char fixture: confirms the URL tail is preserved and the diagnostic is emitted. Existing fixtures (<280 chars, no URL) continue to pass unchanged.

### AC3 — Disagreement reasoning

**Prompt-only change.**

1. **`prompts/angle-evaluator.md`** — add a new section "Disagreement copy" immediately after "Link policy". The new section says (paraphrased in the doc):
   - When the angle is a disagreement with or pushback on the article's take, the tweet copy itself states the reasoning for the disagreement — not just an opinion placed next to a bare link.
   - "States the reasoning" means: the tweet asserts the contrary position **and** the specific reason (data, framework, named failure mode) that supports the contrary view.
   - The reason should be specific enough that the tweet can stand alone without the article — the link is corroboration, not the argument.
2. **Workflow side:** no code change. The model's `tweet_body` is the audit signal.
3. **Tests:** `tests/test_angle_model.py` — existing FakeAngleModel fixtures continue producing non-disagreement tweets; the prompt change is a section addition (AC4 holds). A new optional fixture for a disagreement angle can be added but is not required for AC3 coverage.

### AC4 — Additive preservation

- Prompt change is additive (new "Link policy" + "Disagreement copy" sections; existing "Style" and "Hard rules" sections unchanged).
- API change is additive (`scheduledFor` is optional; items that omit it get `null`, identical to today's behaviour).
- Workflow change is additive (`stagger_scheduled_for` adds one key to each dict; existing fields unchanged).
- Existing test fixtures (which produce no-link standalone tweets with `tweet_body` ≤ 280 chars) continue to satisfy the new prompt sections by producing no-link, non-disagreement, short tweets — the model's "no link earned" + "no disagreement" default path is exercised.

## Service boundary and data ownership

- **Workflow owner:** `agents/workflows/cto-craft-tweet-drafts` — pacing computation + prompt update.
- **API owner:** `services/content-scheduler-api` — accepts optional `scheduledFor` per import item.
- **No data model migration.** `ContentSchedulerItem.scheduledFor` is already a nullable `DateTime?` (`docs/systems/content-scheduler.md:69`).
- **No new shared package.** `pacing.py` lives inside the workflow; the API extension is local to the import route.
- **No `.openclaw` boundary implications.** All changes are in-repo.
- **Direct consumers of the API change:** the CTO Craft workflow (only path that posts to `/imports/cto-craft`). Existing `apps/mission-control` PATCH path is unaffected (`contentScheduler.ts:248-280` already accepts `scheduledFor`).
- **Why this is not a workflow-only shim:** the API contract extension is small and additive, and any future importer (`ops_notes`, `manual` automation, etc.) benefits from the same optional field without a second round of API work. The pacing policy itself stays in the workflow because it is CTO Craft–specific.

## Milestones

All milestones land on the same PR — the prompt change, workflow code, and API extension are tightly coupled and reviewable together:

- **M1 (this PR):**
  1. `services/content-scheduler-api` — extend `validateImportItem` and import route to accept optional `scheduledFor`. New tests in `contentSchedulerImport.test.ts`.
  2. `agents/workflows/cto-craft-tweet-drafts` — new `pacing.py`, wire into `graph.py:343-352`, new `tests/test_pacing.py`.
  3. `agents/workflows/cto-craft-tweet-drafts` — add "Link policy" and "Disagreement copy" sections to `prompts/angle-evaluator.md`.
  4. `agents/workflows/cto-craft-tweet-drafts/graph.py` — add 280-char URL-aware safety net to `import_drafts`; new `tests/test_graph.py` case.
  5. `docs/systems/content-scheduler.md` — line 142 update: `scheduledFor=<staggered-date or null>` instead of `scheduledFor=null`.

## Risk and mitigations

- **Risk: DST transition produces a duplicate or out-of-range `scheduledFor` (e.g. NZST → NZDT skipping 02:00–04:00 on the September spring-forward).**
  Mitigation: `stagger_scheduled_for` uses `zoneinfo.ZoneInfo("Pacific/Auckland")` and constructs datetimes via `datetime.combine(date, time(anchor_hour), tzinfo=tz)`. `zoneinfo` raises `NonExistentTimeError` / `AmbiguousTimeError` for the spring/autumn transitions; the helper catches both and advances by one hour in the same direction, then re-validates. The test `tests/test_pacing.py` includes a fixture covering both the 2026-04-05 NZDT start and 2026-09-27 NZST end.

- **Risk: 23-char URL budgeting is wrong if X changes t.co shortener behaviour.**
  Mitigation: this matches X's documented t.co behaviour as of 2026-09. If X changes it, that's an upstream change requiring a new spec; the doc explicitly calls out the 23-char assumption under "Open questions" below so the next maintainer can spot it.

- **Risk: prompt change accidentally changes existing no-link behaviour for the production OpenClaw adapter.**
  Mitigation: AC4 verification (existing pytest + manual Studio smoke with the real `OpenClawStructuredAngleModel` against a representative article) confirms non-linked standalone generation is unaffected. The "Link policy" section explicitly preserves the no-link default and frames it as "decide per-article whether a link is earned — most articles will not earn a link."

- **Risk: model overshoots 280 chars with a URL embedded, and the truncation safety net chops mid-word.**
  Mitigation: truncation preserves the URL tail and trims the leading copy to 257 chars + space + URL (always ending with the URL). The diagnostic `TWEET_TRUNCATED_FOR_LINK_BUDGET` makes the overshoot visible so Ash can flag it on the next QA pass. A future improvement could reject-and-skip instead of truncate; current behaviour is "ship something readable + signal the issue", which matches the existing diagnostic-on-import pattern.

- **Risk: disagreement-reasoning prompt change causes the model to fabricate reasons to disagree.**
  Mitigation: "Disagreement copy" section frames the rule as "only when the angle is a disagreement" — most articles will not produce a disagreement angle, and FakeAngleModel fixtures continue producing non-disagreement tweets. Existing FakeAngleModel test coverage is the regression net.

- **Risk: API extension to accept `scheduledFor` could be misused by other importers to bypass the Mission Control review path.**
  Mitigation: the field is optional and additive. Other importers (`ops_notes`, `manual`) already pass `null` for `scheduledFor`; they don't have a reason to start pre-scheduling without an explicit consumer need. The CTO Craft pacing policy is workflow-side, not API-side, so any other importer must consciously add a pacing policy of its own.

## Test plan

1. **AC1 (API passthrough)** — `cd services/content-scheduler-api && pnpm test -- contentSchedulerImport.test.ts` (new file). Three cases: omit → null; valid ISO → Date; invalid string → 400. Existing `contentSchedulerAutoPost.test.ts` continues to pass.
2. **AC1 (pacing helper)** — `cd agents/workflows/cto-craft-tweet-drafts && uv run --frozen --extra dev pytest tests/test_pacing.py` (new file). Cases: 1-item, 5-item, NZST→UTC conversion, idempotency under fixed `now`, DST spring-forward / fall-back fixtures. Existing `tests/test_graph.py` continues to pass with no fixture edits.
3. **AC2 (prompt + safety net)** — `cd agents/workflows/cto-craft-tweet-drafts && uv run --frozen --extra dev pytest tests/`. Existing `test_angle_model.py` and `test_graph.py` continue to pass (FakeAngleModel fixtures are non-link, ≤280 chars). New unit test in `test_graph.py` covers the URL-overshoot truncation safety net.
4. **AC3 (prompt)** — same pytest run; no new test required. The FakeAngleModel fixtures continue producing non-disagreement tweets, exercising the model's default non-disagreement path. Optional new fixture for a disagreement angle can be added but is not required for AC3 coverage (the model behaviour is verified at the prompt-text level via code review; a runtime disagreement test would need a live OpenClaw call, which is out of scope for the test layer).
5. **AC4 (regression)** — `pnpm content-scheduler-api:test` + `pytest tests/` + `pytest tests/test_durability.py` + `pytest tests/test_postgres_saver_send_serialization.py` all green. Existing FakeAngleModel fixtures produce non-link, non-disagreement, ≤280-char tweets; they continue to satisfy the prompt.
6. **E2E (manual smoke, daytime window)** — Quinn or Ash runs the cron once against the deployed dev environment and confirms (a) imported items have non-null `scheduledFor` spanning consecutive days in NZST, (b) at least one imported tweet has a URL (link-earned path exercised), (c) at least one imported tweet has reasoning for a contrary view (disagreement path exercised). Out of scope for the implementation pass; documented in the PR body as a follow-up QA step.

## Open questions

- **23-char URL budgeting vs raw URL length in `tweet_body`.** I have adopted the 23-char convention (matches X's `t.co` shortener). If a future reviewer prefers raw-URL accounting for code-review ergonomics, the safety-net truncation in `import_drafts` would need to switch from "≤280" to "≤280 minus 23 + len(url)" (i.e. raw URL counted). Flagging here so the assumption is explicit; happy to revise in the PR if Quinn prefers the other direction.

- **Should the `stagger_scheduled_for` helper live in the workflow or in a shared `agents/lib` module?** I have it workflow-local because the pacing rule is CTO Craft–specific for now. If a second consumer (e.g. `ops_notes`) needs staggered scheduling within this PR or the next, the helper should move to `agents/lib` and the pacing rule (anchor date, skip-weekends, anchor-hour) becomes a per-consumer config. Flagging the extraction path so it's not YAGNI'd in if the second consumer materialises.

- **Should disagreement reasoning require a citation in `evidence_excerpt`?** The existing schema already includes `evidence_excerpt`, and FakeAngleModel fixtures always populate it. The "Disagreement copy" prompt change does not explicitly tie the reason to `evidence_excerpt`; should I tighten the prompt to say "the reasoning must reference the article's specific claim (or a known counter-example) and may quote the article via `evidence_excerpt`"? Lean: yes — this makes `evidence_excerpt` the audit trail for the disagreement reason. Flagging to confirm before Quinn approves.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 | (a) New `services/content-scheduler-api` test `contentSchedulerImport.test.ts` covers optional `scheduledFor` passthrough; (b) new `agents/workflows/cto-craft-tweet-drafts/tests/test_pacing.py` covers 1-/5-item batching, NZST→UTC conversion, idempotency, and DST transitions; (c) `graph.py:343-352` calls `stagger_scheduled_for` before `import_fn(items)`; (d) PR body lists every imported item's staggered `scheduledFor` from a representative `FakeAngleModel` run as evidence. |
| AC2 | (a) `prompts/angle-evaluator.md` has a new "Link policy" section between "Style" and "Profile"; (b) `graph.py` `import_drafts` node enforces 280-char URL-aware truncation safety net with `TWEET_TRUNCATED_FOR_LINK_BUDGET` diagnostic; (c) new unit test in `tests/test_graph.py` covers a 320-char URL-bearing fixture and confirms the URL tail is preserved. |
| AC3 | (a) `prompts/angle-evaluator.md` has a new "Disagreement copy" section immediately after "Link policy"; (b) no code change required; (c) prompt text review confirms the section explicitly requires the tweet body to state the reasoning (not just an opinion next to a link). |
| AC4 | (a) Existing `tests/test_angle_model.py`, `tests/test_graph.py`, `tests/test_durability.py`, `tests/test_postgres_saver_send_serialization.py` continue to pass without fixture edits; (b) existing `services/content-scheduler-api/test/contentSchedulerAutoPost.test.ts` continues to pass; (c) FakeAngleModel fixtures produce non-link, non-disagreement, ≤280-char tweets that exercise the new prompt sections' default (no-link, non-disagreement) paths. |
