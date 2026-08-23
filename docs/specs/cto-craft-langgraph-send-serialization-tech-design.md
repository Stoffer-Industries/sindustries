---
title: "CTO Craft LangGraph Send Serialization Fix"
slug: cto-craft-langgraph-send-serialization
status: proposed
date: 2026-08-24
task: 60971f78-5225-423a-9823-8e72e4064c49
---

# CTO Craft LangGraph Send Serialization Fix

## Context

**Product spec:** not applicable (code task — `taskType: code`, no
`docs/specs/*-product-spec.md` produced for this work).

**Task:** [60971f78-5225-423a-9823-8e72e4064c49](http://localhost:4001/tasks/60971f78-5225-423a-9823-8e72e4064c49)
— Fix cto-craft-tweet-drafts: LangGraph Send objects not JSON-serializable by PostgresSaver.

**Title (verbatim):** 💻 Fix cto-craft-tweet-drafts: LangGraph Send objects not JSON-serializable by PostgresSaver

**Repos:** sindustries (canonical Edge-managed checkout, **read-only reference**).

**Branch:** `task-60971f78-cto-craft-langgraph-send-fix`

**Worktree path:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-60971f78-cto-craft-langgraph-send-fix`

**Cron / workflow boundary:** the `cto-craft-tweet-drafts` cron lives in
`agents/workflows/cto-craft-tweet-drafts/` and runs against the prodlike
Postgres checkpointer. The LangGraph Studio entrypoint
(`build_studio_graph`) is intentionally backed by an in-memory
checkpointer and is unaffected by this bug.

## Diagnosis (Lox, incident `cto-craft-tweet-drafts-send-not-json-serializable-2026-08-24`)

The conditional edge
`_route_after_extract_with_fanout` in
`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/graph.py:461`
returns `list[Send]`, which LangGraph then attempts to checkpoint via
`PostgresSaver`. LangGraph 0.3.x's `PostgresSaver` JSON-serializes the
channel writes via the stdlib `json` module, which has no registered
serializer for `langgraph.types.Send`, so the very first run after
`extract_public_links` raises `TypeError: Object of type Send is not JSON
serializable` before any model call.

Locked dependency matrix at HEAD `ac21606`:

| package                       | resolved version |
| ----------------------------- | ---------------- |
| `langgraph`                   | `0.3.34`         |
| `langgraph-checkpoint-postgres`| `2.0.25`       |
| `langgraph-cli[inmem]`        | (studio extra, pinned `>=0.3.6,<0.4.0`) |

The pyproject pin `langgraph>=0.3.21,<0.4.0` is the affected range. The
fix is upstream in 0.4.x where `Send` is given a registered serializer
on the Postgres saver path.

## `.openclaw` boundary

None — all changes live inside `agents/workflows/cto-craft-tweet-drafts/`
in the sindustries repo. No OpenClaw config, skill, or runtime change.

## Implementation plan

### Approach: pin bump, with Annotated-reducer fallback pre-staged

The Lox incident notes three candidate fixes; this design adopts the
preferred path (smallest diff) and pre-stages the fallback so the
implementation can pivot without re-designing if 0.4's runtime API
breaks the existing fanout.

**Path A (preferred): bump the langgraph pin to 0.4.x.**

1. `agents/workflows/cto-craft-tweet-drafts/pyproject.toml`:
   - `langgraph>=0.3.21,<0.4.0` → `langgraph>=0.4.0,<0.5.0`
   - `langgraph-cli[inmem]>=0.3.6,<0.4.0` → `langgraph-cli[inmem]>=0.4.0,<0.5.0`
     (the studio extra is the same version family and the original
     comment in `pyproject.toml` already documents that CLI pinning must
     track the runtime floor to avoid the historical `USE_RUNTIME_CONTEXT_API`
     crash — see `tests/test_studio.py::test_studio_runtime_context_api_compatible`).
2. `agents/workflows/cto-craft-tweet-drafts/uv.lock`: refresh via
   `uv lock --upgrade-package langgraph --upgrade-package langgraph-cli`
   so the lockfile re-resolves transitive deps (langchain-core,
   langgraph-checkpoint, etc.) against the new floor.
3. No production code change to `_route_after_extract_with_fanout` —
   the upstream serializer fix handles the channel-write path.
4. Run `uv run pytest` in the workflow directory to confirm the
   existing suite still passes (AC2).

**Path B (fallback, only if Path A breaks the graph): refactor fanout to
use an `Annotated` reducer on a list field and a plain conditional-edge
return.**

Concretely:

1. Add `article_links` field typed as
   `Annotated[list[_ArticleFetchJob], operator.add]` to `PipelineState`,
   with `_ArticleFetchJob` already implicitly in scope (the function
   already returns `{"_article_link": link}` per item).
2. Replace `_route_after_extract_with_fanout` with a single-node pattern:
   - A new `fanout_articles` node writes `article_links` into state.
   - The conditional edge from `extract_public_links` returns the
     *literal string* `"fanout_articles"` (or `COMPLETE_NOOP`), not a
     `list[Send]`.
   - `fetch_and_score_article` reads `article_links` and writes
     `fetched_articles: Annotated[list[...], operator.add]` so the
     existing fanout semantics are preserved without ever putting a
     `Send` into a checkpoint.
3. This is the same diff shape Lox would have written had the upstream
   fix not existed. It is the documented fallback; only execute if
   `uv run pytest` after Path A surfaces a real regression.

**Path C (last resort, ruled out): custom `PostgresSaver` serde.**

This would mask the underlying bug, keep the dep matrix in the affected
range forever, and require a `serde` registration on every operator that
constructs a `Send`. **Do not pursue unless both Path A and Path B are
infeasible.** Per Rowan SOUL: "challenge interim shims when they
introduce duplicated metadata or a second source of truth and the final
API/db/shared-package solution would be similarly easy."

### Why Path A is durable, not an interim shim

Bumping the langgraph pin to a release where `Send` has a registered
serializer is the *upstream-supported* fix. The bug is fixed in the
library itself, so every Postgres-backed LangGraph graph in the
codebase benefits without any per-graph workaround. The "interim shim"
comparison that matters here is "custom serde registration now vs.
upstream-supported fix at the next release" — Path A is the smaller
diff and the more durable shape.

## Data model / API contract

No data-model or API contract change. The fanout function's signature
`state: PipelineState -> str | list[Send]` is preserved on Path A.
The function's return type is part of the LangGraph public API, not
our own.

## Workflow / cron / skill changes

- `agents/workflows/cto-craft-tweet-drafts/` cron: no behavior change
  beyond unblocking the failed runs.
- `agents/workflows/cto-craft-tweet-drafts/langgraph.json` Studio wiring:
  unchanged. Studio continues to use `MemorySaver` by design (see the
  studio invariants enumerated in
  `src/cto_craft_workflow/studio.py`).
- No OpenClaw skill change.

## Test plan (AC-by-AC verification matrix)

### AC1 — cron runs end-to-end against the real PostgresSaver checkpointer

The current test suite never instantiates `PostgresSaver` (Studio uses
`MemorySaver`, durability tests use `InMemorySaver`, graph tests use no
checkpointer). That gap is exactly what allowed this bug to ship. Path
A closes it by adding **one new test** that exercises the actual
Postgres-backed checkpoint path with a real `Send`-returning
conditional edge.

**New test:** `agents/workflows/cto-craft-tweet-drafts/tests/test_postgres_saver_send_serialization.py`

- Connects to the prodlike Postgres checkpointer (via the existing
  `CTO_CRAFT_CHECKPOINT_DSN` env var — same DSN the cron uses; tests
  point it at a temp schema created/dropped per test).
- Builds the production graph via `build_graph(deps,
  checkpointer=PostgresSaver.from_conn_string(DSN))`.
- Registers canned HTTP fixtures (same `FakeTransport` style as
  `tests/conftest.py`) so no network is needed.
- Drives the graph with a fake angle model that returns ≥3
  `AngleOutput` rows so the `extract_public_links → fanout →
  fetch_and_score_article` path is exercised end-to-end.
- Asserts `final["outcome"] == "created"` and that no
  `TypeError` is raised — directly verifying the Send serialization
  regression is gone.
- Drops the temp schema in a fixture teardown.

**CI integration:** extend the existing
`.github/workflows/ci.yml::cto-craft-tweet-drafts-tests` job to spin
up a Postgres service container (`postgres:16-alpine`) and run the new
test alongside the existing ones. The studio, graph, and durability
tests are unaffected.

**Manual verification (acceptable per AC1 wording):** if CI Postgres is
not available in this pass, the PR description must include a
`uv run pytest tests/test_postgres_saver_send_serialization.py`
invocation run against the prodlike Postgres (DSN from
`~/.openclaw/.env`), with the command output pasted into the PR
description or a linked gist.

### AC2 — existing tests still pass after the langgraph version change

Run the full existing suite under the new pin:

```bash
cd agents/workflows/cto-craft-tweet-drafts
uv sync
uv run pytest -q
```

Expected: `test_studio.py`, `test_graph.py`, `test_durability.py`,
`test_angle_model.py`, `test_article_extract.py`,
`test_issue_source.py`, `test_locking.py`, `test_safe_fetch.py` all
pass unchanged on Path A. If any fail, pivot to Path B (fallback
refactor) and re-run.

The specific test that guards the dep matrix compatibility,
`test_studio_runtime_context_api_compatible`, must remain green — it
imports `langgraph` and checks the `USE_RUNTIME_CONTEXT_API` flag is
not set, which is the same compatibility probe we rely on for the
bump.

### Verification matrix

| AC  | Test / Verification                                                                                                       | Layer           | Pass criterion                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| AC1 | `tests/test_postgres_saver_send_serialization.py::test_postgres_saver_round_trip_send_fanout` (new)                     | integration     | `final["outcome"] == "created"`; no `TypeError`; Send-in-checkpoint round-trips |
| AC1 | `.github/workflows/ci.yml` Postgres service container spins up for the cto-craft-tweet-drafts-tests job                  | CI              | New test runs in CI without `postgres: connection refused`                  |
| AC1 | (fallback) Manual `uv run pytest tests/test_postgres_saver_send_serialization.py` against prodlike Postgres              | manual          | PR description includes command output                                       |
| AC2 | `uv run pytest` in `agents/workflows/cto-craft-tweet-drafts/`                                                            | suite           | All existing tests pass under `langgraph>=0.4.0,<0.5.0`                      |
| AC2 | `tests/test_studio.py::test_studio_runtime_context_api_compatible`                                                        | suite           | Imports succeed under new pin; `USE_RUNTIME_CONTEXT_API` not set             |

If Path B is taken instead (Path A breaks the graph), the matrix still
holds but AC1's new test additionally asserts that no `Send` instance
ever appears in a checkpoint dump (verified by reading back the
checkpoint and checking `next` / `tasks` for `Send` references).

## Risks and open questions

1. **langgraph 0.4.x runtime API drift.** The Lox incident note flags
   this: "If 0.4's API changes break the graph, fall back to Path B."
   Mitigation: Path A is implemented first, tests run immediately; if
   `uv run pytest` fails on a non-Send-related reason (e.g., signature
   change in `add_conditional_edges` or `StateGraph.compile`), pivot to
   Path B without re-opening this design.

2. **`langgraph-checkpoint-postgres` compatibility.** Currently at
   `2.0.25`; LangGraph 0.4.x may require a newer major. The `uv lock
   --upgrade-package` step will surface the conflict; if it does,
   bump the `langgraph-checkpoint-postgres` pin in the same PR and
   call it out in the PR description.

3. **`langgraph-cli[inmem]` major bump.** The studio extra is pinned
   `>=0.3.6,<0.4.0`. Path A bumps it to `>=0.4.0,<0.5.0`; if the CLI's
   0.4.x release changes its API in a way that breaks `langgraph
   dev`, the studio workflow is unaffected (the cron does not install
   the studio extra) but the local `langgraph dev` operator UX
   changes. Document the change in the PR description so Tom knows
   `uv sync --extra studio` may need re-pulling.

4. **Postgres test infra in CI.** The new AC1 test needs a Postgres
   service. The existing cto-craft-tweet-drafts-tests job does not
   declare one. The PR must add a `services.postgres` block to the
   job; if that conflicts with the other ci.yml jobs (e.g., shared
   checkout caching), the new test can be gated behind a job-level
   env var and only run on a dedicated matrix entry. Default plan:
   add `services.postgres` to the existing job — it's the cleanest.

5. **No external product spec.** Code tasks don't require one. The
   task description (Lox incident + preferred fix path) is the
   authoritative scope. No `apps/<app>/SPEC.md` change is needed —
   this is a runtime dep bump + test-infra repair, not a behavior
   change visible to operators or end users.

## Out of scope

- Refactoring the rest of the graph (e.g., `collect_candidates`,
  `select_distinct_angles`, etc.) to use `Annotated` reducers. Only the
  fanout edge is touched if Path B is taken.
- Upgrading langgraph beyond 0.4.x or migrating to langgraph v1 / v2
  APIs.
- Changing the cron schedule, the lock semantics, or the
  Content Scheduler import client.
- Backporting the Send serialization fix to other LangGraph graphs in
  the repo. The incident is specific to cto-craft-tweet-drafts because
  it is the only graph that returns `list[Send]` from a conditional
  edge. If a future audit finds more, file a follow-up task.

## Decision needed

Quinn: confirm Path A is the chosen fix before I commit the pin bump.
If you prefer I skip straight to Path B (Annotated reducer, no dep
bump), say so in the approval comment and I'll rewrite the
implementation plan in place. Otherwise the design stands as-is.
