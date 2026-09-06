# Tech Design — Fix blocking file read in CTO Craft Studio load_prompts() (task 88eb3ffe)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/88eb3ffe-3f04-422f-9464-79194120e49f (full UUID on Tasks API)
**Branch:** `88eb3ffe-cto-craft-load-prompts` (off `origin/main`, commit `bf399ad`)
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-06

---

## Problem

`load_prompts()` in `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/angle_model.py:316` reads two static prompt files synchronously via `Path.read_text()`:

```python
def load_prompts() -> tuple[str, str]:
    evaluator_path = _PROMPTS_DIR / "angle-evaluator.md"
    worldview_path = _PROMPTS_DIR / "tom-worldview.md"
    ...
    return (evaluator_path.read_text(encoding="utf-8"), worldview_path.read_text(encoding="utf-8"))
```

The two files (`prompts/angle-evaluator.md`, `prompts/tom-worldview.md`) are *static assets shipped with the package*. They never change at runtime.

LangGraph Studio invokes `build_studio_graph()` (`studio.py:329` → `_build_studio_graph()` at `:285`) on every request when inspecting the graph topology (`get_assistant_subgraphs`). That request runs on Studio's async loop, and the synchronous `Path.read_text()` triggers the `blockbuster` blocking-call guard that `langgraph-cli[inmem]==0.3.6` enforces by default in dev mode. The guard raises `BlockingError`, killing the request and producing the user-facing "Failed to fetch" / "Unable to connect to LangGraph server" error in Studio.

Workaround: `langgraph dev --allow-blocking` exists, but it disables the guard for the entire dev session, hiding real blocking bugs. It is not the durable answer.

The same `load_prompts()` function is also called from:
- `cli.py:141` — once at the start of the production CLI run (acceptable, but no point re-reading on every call)
- `cli.py:226, 302, 303` — inside `cli.py`'s per-article iteration (acceptable in production cron, but unnecessary I/O)
- `studio.py:310` — **on the async Studio request path (the bug)**
- `tests/test_durability.py:64`, `tests/test_postgres_saver_send_serialization.py:176`, `tests/test_graph.py:96` — pytest fixtures (acceptable, but tests run faster if the file is read once)

## Goals (and non-goals)

**In scope**
- Replace the per-call `Path.read_text()` in `load_prompts()` with module-level caching. The two prompt strings are loaded once at module import time and exposed via a thin `load_prompts()` wrapper that returns the cached tuple.
- Move the existing "missing prompt file" `RuntimeError` guards into a private helper (`_load_prompt_or_raise`) that runs at import time. The guards preserve the original fail-fast behaviour for broken installs.
- Confirm that all five call-sites (`cli.py:141, 226, 302, 303` and `studio.py:310` plus the three test fixtures) compile and pass without modification.

**Out of scope**
- Introducing `asyncio.to_thread()` wrapping. Considered and rejected — it would still incur I/O on every studio session and add an async-shape dependency for callers. Module-init caching is simpler and matches the prompt files' static nature.
- Switching the prompt source away from in-package markdown files. Out of scope; the prompts ship with the package by design and the studio dep already excludes them from the runtime venv.
- Changing the `OpenClawStructuredAngleModel` runner. The production adapter is already async-friendly (subprocess invocation via `subprocess.run` on the CLI path), but Studio bypasses it and uses `FakeAngleModel`. Out of scope.
- Restructuring the prompt directory. The `prompts/angle-evaluator.md` and `prompts/tom-worldview.md` layout is unchanged.

## Source-of-truth docs

- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/angle_model.py` (the change)
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/studio.py` (call-site: line 310)
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/cli.py` (call-sites: lines 141, 226, 302, 303)
- `agents/workflows/cto-craft-tweet-drafts/tests/test_durability.py:64`, `test_postgres_saver_send_serialization.py:176`, `test_graph.py:96` (test call-sites, must keep working)
- `agents/workflows/cto-craft-tweet-drafts/pyproject.toml` (studio dep pinning — read-only confirmation)
- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/__init__.py` (read-only — confirms `load_prompts` is re-exported)

## Architecture / approach

Module-level caching with a thin wrapper to preserve all five call-sites:

1. **`angle_model.py`** — introduce two module-level constants populated once at import:
   ```python
   def _load_prompt_or_raise(path: Path, label: str) -> str:
       if not path.exists():
           raise RuntimeError(
               f"missing prompt file: {path}. "
               f"The CTO Craft package must ship prompts/{label}.md."
           )
       return path.read_text(encoding="utf-8")

   _ANGLE_EVALUATOR_PROMPT = _load_prompt_or_raise(
       _PROMPTS_DIR / "angle-evaluator.md", "angle-evaluator"
   )
   _TOM_WORLDVIEW_PROFILE = _load_prompt_or_raise(
       _PROMPTS_DIR / "tom-worldview.md", "tom-worldview"
   )


   def load_prompts() -> tuple[str, str]:
       """Return the cached angle-evaluator and Tom-worldview prompts.

       The strings are loaded once at module import time and cached in
       module-level constants, so callers on the LangGraph Studio request
       path (which runs on an async loop) do not trigger the ``blockbuster``
       guard on a synchronous ``Path.read_text()``. The wrapper preserves
       the original tuple signature so existing call-sites do not change.
       """
       return _ANGLE_EVALUATOR_PROMPT, _TOM_WORLDVIEW_PROFILE
   ```

   The `__all__` tuple at line 393 already includes `"load_prompts"`; no change there. The `__init__.py` re-exports list (verified via `grep -rn 'load_prompts' src/cto_craft_workflow/__init__.py`) is unchanged.

2. **No call-site changes.** All five call-sites (`cli.py:141, 226, 302, 303`, `studio.py:310`, and the three test fixtures) keep using `system_prompt, worldview_profile = load_prompts()` exactly as today. The wrapper signature is unchanged.

3. **`__pycache__` invalidation.** The two binary `.pyc` files in `src/cto_craft_workflow/__pycache__/angle_model.cpython-312.pyc` will be regenerated automatically by the next Python invocation. No manual cache invalidation needed; tests will rebuild them.

## Service boundary and data ownership

- **Owner:** `agents/workflows/cto-craft-tweet-drafts` is the only repo affected.
- **No data model changes.** The prompts are still in-package markdown files.
- **No API contract changes.** `load_prompts()` signature is identical.
- **No `.openclaw` boundary implications.** The change is purely internal to the workflow package.
- **No shared package or cross-app contract implications.** `angle_model.py` is the only Python file that owns the prompt-loading concern.

## Milestones

All milestones land on the same PR (the change is too small and too coupled to merit a slice):

- **M1 (this PR):** refactor `load_prompts()` to module-level caching in `angle_model.py`; no other files change. Local pytest suite verifies AC3.

## Risk and mitigations

- **Risk: import-time I/O hides a real bug — if the prompt files are missing, the import fails before tests can assert against it.**
  Mitigation: this is the *same* fail-fast behaviour the existing `load_prompts()` already has, just moved earlier. The original function raises `RuntimeError` on missing files; the new helper raises the same `RuntimeError` at import. Net behaviour is identical for broken installs; pytest fixtures in `tests/conftest.py` ship the prompt files (verified via the existing fixture pattern that calls `load_prompts()` successfully in `test_durability.py:64`, `test_postgres_saver_send_serialization.py:176`, `test_graph.py:96`).

- **Risk: a future operator wants to hot-reload prompt changes without restarting Studio.**
  Mitigation: not a current requirement. If hot-reload becomes a real need, that's a scoped follow-up (e.g. an `invalidate_prompts_cache()` helper). Adding a cache-busting complexity knob now is YAGNI.

- **Risk: `asyncio.to_thread()` is a more idiomatic async-shape fix and we should standardise on it.**
  Mitigation: considered and explicitly rejected (see Out of scope). The prompt files are static assets; module-init caching is simpler, has no async-shape dependency, and matches the prompt files' lifecycle. The standardisation argument would apply if the prompts were dynamic or large.

- **Risk: regression in production CLI (`cli.py`) because the prompt strings are now frozen at import.**
  Mitigation: production cron launches a fresh Python process per run (`uv run --frozen cto-craft-workflow`); the import happens once per run, identical to today's behaviour. The CLI test in `test_graph.py:96` reads the same prompt strings before and after the change.

## Test plan

1. **AC3 (regression):** `cd agents/workflows/cto-craft-tweet-drafts && uv run --frozen --extra dev pytest tests/` — all existing tests must continue to pass. The three call-sites of `load_prompts()` in test files (`test_durability.py:64`, `test_postgres_saver_send_serialization.py:176`, `test_graph.py:96`) keep working because the wrapper signature is unchanged.
2. **AC2 (manual smoke):** `cd agents/workflows/cto-craft-tweet-drafts && uv sync --extra studio && uv run --frozen --extra studio langgraph dev` (default flags, no `--allow-blocking`); open Studio in a browser pointed at the `cto_craft` graph; confirm the graph topology loads without `blockbuster.BlockingError` in the server logs and no "Failed to fetch" / "Unable to connect to LangGraph server" in the Studio UI. This is a manual smoke gated by a daytime window — Quinn or Ash typically runs it.
3. **AC1 (mechanical):** code review confirms `_ANGLE_EVALUATOR_PROMPT` and `_TOM_WORLDVIEW_PROFILE` are populated once at module import; `load_prompts()` returns the cached tuple without further I/O. A simple `assert id(load_prompts()[0]) == id(_ANGLE_EVALUATOR_PROMPT)` test inside `test_angle_model.py` (existing file) makes the caching contract explicit — added as a defensive regression test.

## Open questions

None blocking.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 | Code review: `_ANGLE_EVALUATOR_PROMPT` and `_TOM_WORLDVIEW_PROFILE` are populated once at module import; `load_prompts()` returns the cached tuple. New assertion in `tests/test_angle_model.py` confirms identity-equality between the function return value and the module constant. |
| AC2 | Manual smoke: `uv run --frozen --extra studio langgraph dev` (default flags, no `--allow-blocking`) + open Studio against `cto_craft` graph + grep server log for `BlockingError`. Daytime-window gated. |
| AC3 | Existing pytest suite continues to pass: `uv run --frozen --extra dev pytest tests/`. |