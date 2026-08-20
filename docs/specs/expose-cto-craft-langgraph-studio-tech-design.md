---
status: draft
task_id: 782d778e-20db-4266-9622-bdbb44e9baf0
product_spec: brain/tasks/specs/in-progress/cto-craft-tweet-pipeline.md
shipped_pr: null
shipped_date: null
---

# Expose CTO Craft LangGraph in Studio for local inspection — tech design

## Delivery metadata

- **Task:** `782d778e-20db-4266-9622-bdbb44e9baf0` — Expose CTO Craft LangGraph in Studio for local inspection
- **Parent task (production workflow):** `9dfe56e4-13c4-4bb4-b53f-de7c77afd0d2` — CTO Craft recurring tweet-draft pipeline
- **Parent tech design:** [`docs/specs/cto-craft-tweet-pipeline-tech-design.md`](./cto-craft-tweet-pipeline-tech-design.md)
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-782d778e-expose-cto-craft-studio`
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-782d778e-expose-cto-craft-studio`
- **Package:** `agents/workflows/cto-craft-tweet-drafts/`
- **Design intent:** give Tom (and other operators) a reliable local LangGraph Studio entrypoint so they can inspect the real CTO Craft graph topology and execution traces without invoking the production cron or creating Content Scheduler drafts.

## Product intent summary

Today the CTO Craft graph is exercised only through the production cron path. Inspecting topology requires reading `graph.py`, reading test fixtures, or running the real cron — none of which lets an operator walk the graph interactively. LangGraph Studio is the natural tool for this, but a Studio entrypoint does not exist and the current local environment crashes on `USE_RUNTIME_CONTEXT_API` because the locked dependency matrix is inconsistent.

This task adds a Studio-safe entrypoint so that:

1. `langgraph dev` (or an equivalent documented command) starts a Studio server against the real `build_graph` factory.
2. The graph that Studio exposes has the real `discover_latest_issue → extract_public_links → fanout_articles → collect_candidates → select_distinct_angles → import_drafts → format_notification → complete_noop` topology, including fan-out (`Send` per article link) and the no-op branch.
3. Every side-effect boundary is replaced by a deterministic stub that cannot reach production. The Content Scheduler import is gated to refuse any call. The OpenClaw model is replaced by the existing `FakeAngleModel`. The fetcher is replaced by a stub that returns canned responses.
4. The local runtime starts cleanly under the current Studio CLI by resolving the `USE_RUNTIME_CONTEXT_API` dependency mismatch.
5. Documentation covers start / inspect / sample-invocation / shutdown, and an automated test verifies the graph loads and that the no-side-effects boundary holds.

## Goals

- Make the CTO Craft graph topology inspectable in Studio with zero risk of side effects.
- Make `langgraph dev` start reliably on a fresh clone of the repo with the documented commands.
- Pin a known-compatible LangGraph + LangGraph CLI version pair so the locked dev environment stops crashing on `USE_RUNTIME_CONTEXT_API`.
- Cover the boundary with an automated test: building the Studio graph must not import or instantiate any production side-effect adapter.

## Non-goals

- Adding a general LangGraph hosting platform (Agent Server, LangSmith Deployment, Redis, Kubernetes, multi-tenant Studio).
- Changing the production `cli.py` `run` / `replay` paths or the cron prompt. Studio is a developer tool, not a runtime concern.
- Modifying the live Content Scheduler import path. The existing import is preserved verbatim; Studio never calls it.
- Approving, scheduling, or publishing tweets from Studio.
- Replacing `FakeAngleModel` with a different fake. The existing fake already satisfies the Studio determinism requirement.
- Touching any other LangGraph workflow. The same pattern can be reapplied later, but this task is bounded to CTO Craft.

## Source-of-truth / ownership boundary check

| Concern | Owner | Notes |
|---|---|---|
| Graph topology and node semantics | `cto_craft_workflow.graph.build_graph` (existing) | Studio reuses the factory verbatim; no graph shape changes. |
| Graph state schema | `cto_craft_workflow.state.PipelineState` (existing) | Unchanged. |
| Production side-effect adapters | `cto_craft_workflow.content_scheduler.ImportClient`, `cto_craft_workflow.angle_model.OpenClawStructuredAngleModel` | Studio swaps these for stubs. Production code is unchanged. |
| Studio entrypoint + stub dependencies | New `cto_craft_workflow.studio` module | New boundary. Replaces every external dep with a deterministic stub. |
| Studio config (`langgraph.json`) | New file at `agents/workflows/cto-craft-tweet-drafts/langgraph.json` | New. Points to `cto_craft_workflow.studio:build_studio_graph`. |
| Dependency pins | `agents/workflows/cto-craft-tweet-drafts/pyproject.toml` | Add a `studio` extra; pin compatible versions. |
| Documentation | `agents/workflows/cto-craft-tweet-drafts/README.md` | Add a "Local Studio" section. |

### Why this shape

- The natural source of truth for the Studio graph is the existing `build_graph` factory; the Studio wrapper is a thin adapter that supplies deterministic dependencies. We do **not** introduce a parallel graph definition.
- The natural source of truth for the no-side-effects boundary is the Studio factory itself: it never imports `ImportClient`, never instantiates `OpenClawStructuredAngleModel`, never connects to a Postgres checkpointer, and never constructs an `httpx.Client` pointed at the production Content Scheduler URL. A test will assert this.
- Pinning the dependency matrix is the simplest durable fix for `USE_RUNTIME_CONTEXT_API`. Adding a compatibility shim or a custom runtime patch is not justified for a bounded developer tool.

## Implementation plan

### File / module scope

All changes live under `agents/workflows/cto-craft-tweet-drafts/`.

**New files**

1. `src/cto_craft_workflow/studio.py` — exports `build_studio_graph()` and `build_studio_graph_factory()`. The factory wraps `build_graph` with deterministic stubs (see "Studio-safe dependencies" below).
2. `langgraph.json` — Studio config. Declares `graphs.cto_craft` pointing at `cto_craft_workflow.studio:build_studio_graph_factory`, plus `env: ".env"` (optional, for Studio-side env overrides).
3. `tests/test_studio.py` — automated verification (see "Test plan").
4. `tests/fixtures/studio_archive.html` and `tests/fixtures/studio_issue.html` — canned fetch responses used by the Studio fetcher stub.
5. `tests/fixtures/studio_articles/*.html` — canned article responses (one per fixture URL).

**Modified files**

1. `pyproject.toml`:
   - Pin the runtime dependency pair: `langgraph==0.3.21` (or the newest 0.3.x that pairs cleanly with LangGraph CLI 0.4.x at the time of implementation) and `langgraph-cli[inmem]==0.4.0` (newest compatible). Final pins decided at implementation time after confirming the CLI reports no `USE_RUNTIME_CONTEXT_API` crash.
   - Add a `[project.optional-dependencies.studio]` group that bundles `langgraph-cli[inmem]` so `uv sync --extra studio` provisions a Studio-capable environment without polluting the production runtime venv.
   - Keep the existing `dev` extra unchanged so CI / production cron do not pull the CLI.
2. `README.md`:
   - Add a "Local Studio" section after "Tests" describing: prerequisites, the `uv sync --extra studio` step, the `langgraph dev` command, the URL to open, how to inspect the graph topology, how to run a safe sample invocation (use the existing `--dry-run` path), and how to shut down. Reference the `docs/specs/...-tech-design.md` URL.
3. `.gitignore` at the package root (new, small): ignore `.langgraph_api/`, `.studio_state/`, and `*.pckl` so local Studio state never gets committed.

### Studio-safe dependencies

`build_studio_graph_factory()` builds a closure that the Studio server calls once per session to obtain a compiled graph. The factory supplies:

- **Fetcher:** a `StubSafeFetcher` (new, in `studio.py`) that returns canned `FetchedResource` for known URLs (the local archive, the latest issue, and one fixture article) and raises a `FetchError` with code `STUDIO_NO_FIXTURE` for unknown URLs. This matches `SafeFetcher`'s surface (`fetcher.fetch(url, kind=...)`) so `build_graph` accepts it without modification. The stub never opens a socket.
- **Model:** the existing `FakeAngleModel` keyed off the canned article URLs. Returns the matching `AngleOutput` for the canonical URL of each stub article, `None` for everything else. Studio will exercise the full graph including the "no qualified candidates → no-op" path naturally because the stub fixture list is small.
- **Import function:** a `StudioImportFn` that raises `ImportError("STUDIO_IMPORT_FORBIDDEN", "Studio is read-only; do not invoke import_drafts from Studio")` on the first call and otherwise returns `noop`. The error is caught by the existing graph error handling and emitted as a diagnostic; the graph terminates in the `failed` outcome. **No HTTP call to Content Scheduler is ever made.** A test asserts this by calling the import function directly and by inspecting the stub's call counter.
- **Prompts:** loaded via the existing `load_prompts()` so the Studio graph uses the real prompts. This is important: Studio should display the real `system_prompt` and worldview profile so inspection is faithful.
- **Checkpointer:** `langgraph.checkpoint.memory.MemorySaver` (the in-memory checkpointer) — explicitly **not** `PostgresSaver`. The Studio graph never reads or writes the production checkpointer database. A test asserts the studio factory imports `MemorySaver` and never instantiates `PostgresSaver`.
- **Threading / config:** the factory returns a fresh compiled graph per call so the in-memory checkpointer state is clean across server restarts.

### `langgraph.json` shape

```json
{
  "graphs": {
    "cto_craft": "./src/cto_craft_workflow/studio.py:build_studio_graph_factory"
  },
  "env": "./.env.studio.example"
}
```

`./.env.studio.example` (new, in the package root) is committed with safe defaults (`CTO_CRAFT_FETCH_TIMEOUT_SECONDS=15`, `CTO_CRAFT_MIN_RESONANCE_SCORE=0.55`) and clearly commented to say "Studio uses stub dependencies; no real API keys needed". The `.env.studio` file (real, not committed) is gitignored.

### Dependency resolution: `USE_RUNTIME_CONTEXT_API` crash

`USE_RUNTIME_CONTEXT_API` is the runtime context API flag that distinguishes the old LangGraph runtime from the new (>= 0.3) one. The CLI 0.4.x expects the new API; CLI 0.3.x expects the old. The current `pyproject.toml` allows `langgraph>=0.2.50,<0.4.0` and `langgraph-cli[inmem]>=0.3.6` — the lock resolves to whatever pair uv picks, and recent resolutions land on incompatible versions.

The fix is to pin both ends:

- Pin `langgraph` to a specific 0.3.x release in the runtime dependencies (kept loose enough to receive patches: `>=0.3.21,<0.4.0`).
- Pin `langgraph-cli[inmem]` to the matching 0.4.x release in the `studio` extra.

If at implementation time the chosen pair still crashes, fall back to a known-good pair (e.g., `langgraph==0.3.21` + `langgraph-cli[inmem]==0.3.6`) and document the choice in the PR. The compatibility matrix is small and well-documented upstream; this is the lowest-risk fix.

### `.openclaw` boundary

This task is entirely contained in the `sindustries` repo. No `.openclaw` workspace changes are required. The heartbeat for Rowan continues to be the trigger for the design / implementation cycle.

### Data model / API contract changes

None. The graph, the `PipelineState` schema, and the import endpoint contract are unchanged.

### Workflow / cron / skill changes

None. Studio is a developer tool. The production cron prompt (`agents/workflows/cto-craft-tweet-drafts/.venv`-managed) does not invoke Studio.

## Test plan — AC-by-AC verification matrix

### AC1 — A documented local command starts the graph in Studio and the UI loads

- **Layer:** manual smoke test, plus a launch smoke check in CI.
- **Procedure:** Run `uv sync --extra studio` then `langgraph dev` from the package root. Open `http://localhost:8123` in Studio. Verify the graph is listed and selectable.
- **Automated coverage:** `tests/test_studio.py::test_studio_graph_compiles` calls `build_studio_graph_factory()` and asserts the returned graph compiles (i.e., `graph.get_graph()` returns a populated graph with the expected nodes). This is the closest unit-level proxy for "the Studio CLI can start the server".
- **Fallback if automated is impossible:** record the manual procedure in the PR description and README. Skip if the Studio CLI is unavailable in the local runner.

### AC2 — Studio exposes real topology with deterministic/mocked deps, no production side effects

- **Layer:** automated unit test, plus a topology assertion.
- **Procedure:** `tests/test_studio.py::test_studio_graph_has_real_topology` calls `graph.get_graph()` and asserts the node list contains the real production node names (`discover_latest_issue`, `extract_public_links`, `fetch_and_score_article`, `collect_candidates`, `select_distinct_angles`, `import_drafts`, `format_notification`, `complete_noop`), the fan-out edge from `extract_public_links` is present, and the `complete_noop` END edge exists.
- **No-side-effects coverage:** `tests/test_studio.py::test_studio_factory_imports_no_production_adapters` inspects `studio.build_studio_graph_factory()` and asserts:
  - `ImportClient` was never instantiated (call counter is 0 after factory build).
  - `OpenClawStructuredAngleModel` was never instantiated.
  - `PostgresSaver` was never instantiated.
  - No `httpx.Client` was constructed against the production `content_scheduler_base_url`.
  - The graph's `import_fn` rejects the first call with the `STUDIO_IMPORT_FORBIDDEN` error.
- **Determinism coverage:** `tests/test_studio.py::test_studio_graph_runs_end_to_end_offline` runs the graph to completion against the canned fixtures. Asserts the outcome is one of `created` / `noop` (not `failed`) and that the notification field matches the real graph's notification format.

### AC3 — Compatible LangGraph CLI/API/in-memory versions, no `USE_RUNTIME_CONTEXT_API` crash

- **Layer:** automated test + lockfile inspection.
- **Procedure:** `tests/test_studio.py::test_studio_runtime_context_api_compatible` imports `langgraph` and `langgraph_api` (or the installed CLI module) and asserts the resolved versions satisfy the pinned matrix. If the test is environment-sensitive (depends on `uv sync --extra studio` having been run), gate it behind `pytest.importorskip("langgraph_cli")`.
- **Smoke test:** the CI job that runs `uv sync --extra studio` and `langgraph dev --help` exits cleanly. If the CLI crashes with `USE_RUNTIME_CONTEXT_API` on import, the smoke fails. Capture the version pair in the PR description.

### AC4 — Documentation + automated verification

- **Layer:** docs review + automated test count.
- **Procedure:** README contains a "Local Studio" section that walks through start, inspect, sample invocation, and shutdown. The PR description links to the section. `tests/test_studio.py` exists and `pytest tests/test_studio.py -v` is green.
- **Automated coverage:** the test file itself, counted as AC4 evidence in the implementation PR.

### Test layer fallback policy

Per the tech-design skill, E2E Studio UI testing is not automated here — LangGraph Studio is a developer tool with no CI-friendly automation layer. The unit tests above are the canonical automated coverage. Manual smoke (AC1) is documented and required for sign-off but does not block CI.

## Open questions and risks

- **LangGraph CLI version churn.** The CLI 0.4.x line moves quickly; pinning is brittle. Mitigation: pin a minor version (`==0.4.x`), document the chosen pair in the PR, and add a short note in the README that bumps require re-verifying the matrix.
- **Studio port allocation.** `langgraph dev` defaults to port 8123. If a developer runs it against the existing dev stack, port collisions are possible. Mitigation: README documents `LANGGRAPH_DEV_PORT` override.
- **Local `.langgraph_api/` state.** Earlier development left `.langgraph_api/*.pckl` files in the package root. These are now ignored to prevent accidental commits and to keep a fresh `langgraph dev` start clean.
- **Studio server lifecycle in CI.** The Studio CLI's HTTP server is not exercised by CI in this design. If we later want full Studio-start coverage, the simplest path is a containerised Playwright run; defer until a real need arises.
- **`FakeAngleModel` coverage.** The Studio graph relies on the canned fixture URLs matching the canonical URLs in `FakeAngleModel`. If a fixture URL drifts, Studio runs end-to-end into the no-op branch. This is the desired behavior — but the test (`test_studio_graph_runs_end_to_end_offline`) should assert the outcome is `created` so a drift triggers a clear failure.

## Documentation updates

1. `agents/workflows/cto-craft-tweet-drafts/README.md` — add "Local Studio" section with prerequisites, start command, inspect procedure, sample invocation, shutdown.
2. `agents/workflows/cto-craft-tweet-drafts/.env.studio.example` — committed safe-default template.
3. `agents/workflows/cto-craft-tweet-drafts/.gitignore` (new) — ignore `.langgraph_api/`, `.studio_state/`, `.env.studio`, `*.pckl`.

## Reviewer notes

- The implementation is bounded to one package plus the README. It does not touch the production cron path, the import endpoint, or the angle model production adapter.
- The dependency pin is the load-bearing change. Reviewers should sanity-check the chosen CLI/library version pair against the upstream LangGraph release notes before approving.
- The no-side-effects test is the strongest signal that Studio cannot accidentally reach production. If that test passes, AC2 is satisfied regardless of any manual procedure.