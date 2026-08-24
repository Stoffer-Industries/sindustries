---
title: "CTO Craft Candidates Dedup Fix"
slug: cto-craft-candidates-dedup
status: proposed
date: 2026-08-24
task: 402d39fe-04b4-495a-92d1-54ccba8880a1
parent-task: 60971f78-5225-423a-9823-8e72e4064c49
---

# CTO Craft Candidates Dedup Fix

## Context

**Product spec:** not applicable (code task — `taskType: code`, no
`docs/specs/*-product-spec.md` produced for this work).

**Task:** [402d39fe-04b4-495a-92d1-54ccba8880a1](http://localhost:4001/tasks/402d39fe-04b4-495a-92d1-54ccba8880a1)
— Fix cto-craft-tweet-drafts: candidates doubled by operator.add reducer in
collect_candidates node.

**Parent task:** [60971f78-5225-423a-9823-8e72e4064c49](http://localhost:4001/tasks/60971f78-5225-423a-9823-8e72e4064c49)
— Fix cto-craft-tweet-drafts: LangGraph Send objects not JSON-serializable
by PostgresSaver (PR #523 merged 2026-08-24T22:29:12Z, commit
`4e475262d4c726a945cbf973e95f411e43a0b58b`).

**Title (verbatim):** 💻 Fix cto-craft-tweet-drafts: candidates doubled by
operator.add reducer in collect_candidates node

**Repos:** sindustries (canonical Edge-managed checkout, **read-only
reference**).

**Branch:** `task-402d39fe-cto-craft-candidates-dedup`

**Worktree path:**
`/Users/quinnstoffer/.openclaw/workspace/worktrees/task-402d39fe-cto-craft-candidates-dedup`

**Cron / workflow boundary:** the `cto-craft-tweet-drafts` cron lives in
`agents/workflows/cto-craft-tweet-drafts/` and runs against the prodlike
Postgres checkpointer. The bug surfaced **after PR #523** unblocked the
cron (the old `Send` crash killed every run before `collect_candidates`
could fire, so the doubled-state pattern was latent and untested).

## Diagnosis

The `candidates` field on `PipelineState` is declared with the
`Annotated[list[AngleCandidate], operator.add]` reducer
(`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/state.py:134`).
`operator.add` over a list is **list concatenation**, so every node that
returns `{"candidates": ...}` *appends* to the prior value rather than
replacing it.

The graph's actual sequence for one weekly run (after PR #523 collapsed
the parallel fanout into a single node iteration):

1. `fetch_and_score_article` iterates over `state["article_links"]` and
   returns `{"candidates": [c1, c2, c3]}` — the list of scored
   candidates, one per scored article. With a single producer
   (Path B of PR #523 removed the old `Send`-list fanout), this list is
   already deduplicated against the URL space the model was queried on
   *unless two `article_links` resolve to the same canonical URL* (which
   is exactly the case in the existing dedup test
   `test_selection_dedupes_by_canonical_url`, where two article links
   produce candidates with the same `canonical_url`).
2. `collect_candidates` (graph.py:248) reads
   `state["candidates"]`, dedupes by `canonical_url`, and returns
   `{"candidates": cleaned}`. The function does the right dedupe work,
   but…
3. …the `operator.add` reducer appends `cleaned` on top of the
   already-existing list. Net effect: `state["candidates"]` ends up
   holding `raw + cleaned` — the raw scored output AND the deduped
   re-emission. **Length is doubled; every entry appears twice.**

The existing `test_selection_dedupes_by_canonical_url` does not catch
this because it only inspects `final["selected_angles"]`, and
`select_distinct_angles` (graph.py:271) has its own `picked_urls` set
that dedupes again on its way out. The output is correct; only the
intermediate `state["candidates"]` field is bloated.

### Observed shape

For a run with N unique article links and D duplicates (D ≥ 0):

| Node                       | `state["candidates"]` length |
| -------------------------- | ---------------------------- |
| After `fetch_and_score_article` | N                       |
| After `collect_candidates`      | N + (N − D) = 2N − D    |

For the happy-path test (4 article links, 3 unique URLs after
canonical-URL dedup), the doubled state has **7 entries** instead of
**3**. For the cron in production with N=5, D=0 the doubled state is
**10** entries instead of **5**.

### Why this matters even though the final output is correct

1. **Checkpoint bloat.** Every Postgres checkpoint now carries
   ~2× the candidates it should. For a weekly cron this is small in
   absolute terms, but it doubles the JSON payload the saver
   serialises on every checkpoint write — and the saver is the same
   path that just crashed for two days on the Send-serialization bug.
   Adding more bytes to the JSON blob re-expands the surface where
   other latent serialization issues could surface.
2. **Future readers that do not dedupe.** The current downstream
   consumer (`select_distinct_angles`) happens to dedupe internally,
   so the doubled state is invisible. Any future node that reads
   `state["candidates"]` without its own dedupe — e.g., a new
   diagnostic node, an export step, a downstream human-in-the-loop
   review — would see the doubled list and emit duplicated output.
   This is the kind of latent-becomes-real bug the audit pattern
   `audit-prescribed-fix-blocked-by-latent-test-infra` is built to
   surface.
3. **Future parallel producers.** If anyone reintroduces a parallel
   fanout (LangGraph 0.4.x upgrade, Send-serializer fix, or a new
   per-article node), the reducer semantics matter again. Right now
   the contract is "append whatever you return" — but no caller
   expects that. Cleaner to make the contract match the
   actual single-producer reality.

## `.openclaw` boundary

None — all changes live inside
`agents/workflows/cto-craft-tweet-drafts/` in the sindustries repo. No
OpenClaw config, skill, or runtime change.

## Implementation plan

### Preferred path (Path A): route the deduped output to a new field key

Add a non-reducer field `deduped_candidates: list[AngleCandidate]` to
`PipelineState`, change `collect_candidates` to write into that field,
and change `select_distinct_angles` to read from it. Keeps the
existing `candidates` reducer contract intact for any future producer
that may legitimately want to append.

**Why "lowest blast radius":** the reducer semantics for
`state["candidates"]` stay exactly as documented
(`operator.add` over lists). The fix touches one reducer consumer
(`collect_candidates`) and one reader (`select_distinct_angles`). No
existing node that returns `candidates` has its semantics altered.

**Concrete diff:**

1. `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/state.py`:
   - Add `deduped_candidates: list[AngleCandidate]` to `PipelineState`
     (no reducer — plain assignment).
   - Add `deduped_candidates=[]` to `make_initial_state`.
2. `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/graph.py`:
   - `collect_candidates` returns
     `{"deduped_candidates": cleaned, "outcome": "noop"|None}`
     instead of `{"candidates": cleaned, ...}`. The dedupe loop is
     unchanged; only the output field key moves.
   - `select_distinct_angles` reads
     `state.get("deduped_candidates")` instead of
     `state.get("candidates")`. The internal `picked_urls` dedupe
     stays as a defence-in-depth measure but is no longer load-bearing
     for correctness.
   - `fetch_and_score_article` is **unchanged** — it still writes to
     `state["candidates"]` via the reducer. That contract stays
     intact.
3. The `outcome: "noop"` early-return for
   `len(cleaned) < MIN_QUALIFIED_CANDIDATES` is preserved.
4. No `make_initial_state` consumer change beyond adding the new
   field.

### Alternative path (Path B): drop the `operator.add` reducer

Change `candidates: Annotated[list[AngleCandidate], operator.add]` to
`candidates: list[AngleCandidate]` and remove the `Annotated` import
binding if it becomes unused. Single-producer overwrite semantics
match the actual graph (only `fetch_and_score_article` and
`collect_candidates` write to it, both sequential). Removes the
vestigial reducer that PR #523 left behind when it collapsed the
parallel fanout.

**Pros:** smaller code diff (one Annotated wrapper removed), no new
state field, semantically correct (overwrite matches single-producer
reality).

**Cons:** **changes the contract** for any future code that wants to
legitimately append to `candidates` (e.g., a re-introduced parallel
fanout). The reducer was load-bearing for the historical
`Send`-list fanout; removing it forecloses that pattern unless
someone re-adds the wrapper.

**Why Path A is preferred over Path B:** Path A is more conservative
on the contract axis and matches the "lowest blast radius" framing in
the task description. Path B is viable and arguably cleaner if Quinn
is comfortable declaring the reducer vestigial; flag it in the
review and Quinn can pick.

### Out of scope for either path

- Changing the `select_distinct_angles` internal dedupe logic
  (the `picked_urls` set stays as defence-in-depth).
- Changing the `is_valid_candidate_shape` validation or the
  `MIN_QUALIFIED_CANDIDATES = 3` threshold.
- Backporting the dedup pattern to other LangGraph graphs in the
  repo. If a future audit finds more, file a follow-up task.
- Changing the cron schedule, the lock semantics, or the
  Content Scheduler import client.

## Data model / API contract

- **PipelineState schema:** one new field (`deduped_candidates` on
  Path A; no change on Path B). The field is plain
  `list[AngleCandidate]` with no reducer.
- **Internal contract between nodes:** `collect_candidates` writes
  `deduped_candidates`; `select_distinct_angles` reads
  `deduped_candidates`. Both directions are local to the workflow
  module; no external consumer.
- **Persisted checkpoint shape:** `deduped_candidates` is
  JSON-serializable and lands in the PostgresSaver payload. It
  appears as a new top-level field next to `candidates`. On Path A,
  old checkpoints (replays from before this change) will be missing
  the field; the `state.get("deduped_candidates", [])` read in
  `select_distinct_angles` handles the missing-key case cleanly.
- **No public API change.** No Content Scheduler import contract
  change. No cron config change.

## Workflow / cron / skill changes

- `agents/workflows/cto-craft-tweet-drafts/` cron: behaviour
  unchanged from the operator's perspective — final outcome and
  `selected_angles` list are identical, only the intermediate
  `state["candidates"]` shape moves.
- `agents/workflows/cto-craft-tweet-drafts/langgraph.json` Studio
  wiring: unchanged. Studio continues to use `MemorySaver` by
  design.
- No OpenClaw skill change.

## Test plan (AC-by-AC verification matrix)

### AC1 — doubled-length state eliminated

Add a new test
`agents/workflows/cto-craft-tweet-drafts/tests/test_collect_candidates_dedup.py`
that drives the graph end-to-end (same `_build_graph` + `_transport`
plumbing as `test_graph.py`) with **duplicate canonical URLs in the
fixture list** — the same shape as the existing
`test_selection_dedupes_by_canonical_url`. The test asserts:

- `final["deduped_candidates"]` length equals the count of unique
  `canonical_url` values across the fixtures (NOT 2× that count).
- `final["candidates"]` is **not** the source of truth anymore; the
  test only inspects `deduped_candidates`. A second assertion checks
  that no node downstream of `collect_candidates` reads
  `state["candidates"]` (grep + AST sanity, optional but cheap).
- `final["selected_angles"]` has length between 3 and 5 as before,
  with no duplicate `canonical_url` entries (defence-in-depth
  check; `select_distinct_angles`'s `picked_urls` set should still
  pass even without it).

The test does not need a real Postgres checkpointer (Path A does not
change serialization semantics) — the `InMemorySaver` / no-checkpointer
path that `test_graph.py` already uses is sufficient. This is a
deliberate scope reduction vs. PR #523's new
`tests/test_postgres_saver_send_serialization.py`: the doubled-state
bug is a graph-shape bug, not a serializer bug.

### AC2 — regression test that asserts the deduped set length equals the unique-URL count

Covered by the new test in AC1. Same fixture as
`test_selection_dedupes_by_canonical_url` (4 fixtures, 3 unique URLs,
STRONG_URL appears twice) so the doubling case is explicitly
exercised.

### AC3 — existing pytest suite remains green

Run the full existing suite:

```bash
cd agents/workflows/cto-craft-tweet-drafts
uv sync
uv run pytest -q
```

Expected: every test in
`tests/test_graph.py` (including
`test_selection_dedupes_by_canonical_url`),
`tests/test_studio.py`,
`tests/test_durability.py`,
`tests/test_angle_model.py`,
`tests/test_article_extract.py`,
`tests/test_issue_source.py`,
`tests/test_locking.py`,
`tests/test_safe_fetch.py`,
`tests/test_postgres_saver_send_serialization.py` passes unchanged on
Path A. The new
`test_collect_candidates_dedup.py` joins the run.

The CI job `.github/workflows/ci.yml::cto-craft-tweet-drafts-tests`
already has the `services.postgres: image: postgres:16` block from
PR #523, so `test_postgres_saver_send_serialization.py` continues to
run there; the new test runs in the same job without further CI
infra.

### Verification matrix

| AC  | Test / Verification                                                                  | Layer       | Pass criterion                                                |
| --- | ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------- |
| AC1 | `tests/test_collect_candidates_dedup.py::test_deduped_candidates_length_matches_unique_url_count` (new) | unit/integration | `len(final["deduped_candidates"]) == len(unique_canonical_urls)` |
| AC1 | Same test, second assertion                                                          | unit        | `final["candidates"]` not read by `select_distinct_angles` after fix |
| AC2 | Same test (AC1 and AC2 share a fixture)                                              | integration | `selected_angles` deduped, length 3..5, no duplicate URLs    |
| AC3 | `uv run pytest` in `agents/workflows/cto-craft-tweet-drafts/`                         | suite       | All existing tests pass under the dedup-field change          |
| AC3 | `.github/workflows/ci.yml::cto-craft-tweet-drafts-tests`                             | CI          | New test runs in CI; existing `services.postgres` block unchanged |

## Risks and open questions

1. **Path A vs. Path B — Quinn pick.** The task description flags
   "Option 1 is the lowest blast radius" and I agree. Path B (drop
   the reducer) is cleaner code but changes the contract for any
   future parallel producer. **Default to Path A unless Quinn says
   otherwise in the approval comment.**
2. **Old checkpoints.** `select_distinct_angles` reads
   `state.get("deduped_candidates", [])`, so a replay from a
   pre-fix checkpoint would find the new field missing and fall
   through to the empty-list branch (`if not candidates: return
   {"selected_angles": [], "outcome": "noop"}`). That converts
   in-flight replays into a no-op outcome, which is the same
   behaviour the cron would produce for a zero-candidate run.
   Acceptable, but worth flagging in the PR description so the
   on-call operator isn't surprised by a one-time no-op after
   deploy.
3. **Defence-in-depth in `select_distinct_angles`.** The existing
   `picked_urls` dedupe becomes redundant on Path A (the input is
   already deduped). I'm leaving it in place rather than removing
   it — the cost is one set, the value is robustness against future
   readers that bypass `collect_candidates`. Flag for Quinn if
   she'd rather see it removed for clarity.
4. **No AC for the `operator.add` contract itself.** Path A keeps
   the contract; the bug is fixed by routing the deduped output to
   a different field rather than by changing the reducer. If Quinn
   prefers Path B (drop the reducer), the contract change should be
   called out in the PR description so future readers know that
   `state["candidates"]` is now overwrite-only.
5. **Pattern-slug for retro-notes:** `reducer-writeback-collision`
   (extends `audit-prescribed-fix-blocked-by-latent-test-infra`:
   the bug class is "a node writes back to the same reducer field it
   just read from, doubling the result"). Worth a future code-garden
   audit sweep across the other LangGraph graphs in the repo — if
   any have the same `node → return same-key-with-dedup` shape, the
   bug pattern repeats.

## Out of scope

- Refactoring the rest of the graph (`fetch_and_score_article`,
  `select_distinct_angles` internals beyond the field rename) to
  remove the reducer.
- Changing `MIN_QUALIFIED_CANDIDATES`, the dedupe loop in
  `collect_candidates`, or the `is_valid_candidate_shape`
  validation.
- Removing `select_distinct_angles`'s internal `picked_urls` set
  (left as defence-in-depth).
- Backporting the dedup pattern to other LangGraph graphs.
- Adding CI gating for the doubled-state test specifically (the
  existing `cto-craft-tweet-drafts-tests` job picks it up
  automatically).
- Changing the cron schedule, the lock semantics, or the
  Content Scheduler import client.

## Decision needed

Quinn: confirm Path A (new field key) is the chosen fix. If you'd
prefer Path B (drop the `operator.add` reducer), say so in the
approval comment and I'll rewrite the implementation plan in place.
Otherwise the design stands as-is and I'll implement Path A on the
next heartbeat pass after your approval lands.
