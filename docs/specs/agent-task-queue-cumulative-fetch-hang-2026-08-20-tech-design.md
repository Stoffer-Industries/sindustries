---
status: draft
task_id: 4f046565-06cd-4078-922f-4039472a5ca1
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Parallelize `agent_task_queue.py` PR fetches to fit heartbeat slot

## Links and scope

- Task: `4f046565-06cd-4078-922f-4039472a5ca1` — 💻 Parallelize agent_task_queue.py PR fetches to fit heartbeat slot
- Originating incident: `agent-task-queue-script-subprocess-timeout-race-2026-08-20` (status=escalated, Lox at 08:04 NZST 2026-08-20)
- Originating diagnostic escalation: Lox → Rowan at 08:04 NZST 2026-08-20, confirmed 3-of-4 hangs since 07:00 NZST (07:33 ✗, 07:57 ✗, 08:03 ✗, only 07:00 ✓)
- Predecessor tasks / PRs:
  - PR #464 (merged 2026-08-17T00:57:42Z, merge commit `3981c94b`) — added `timeout=30` to the lone `_gh_api` call site at that time
  - Task `8a2df49c` / PR #485 (merged 2026-08-18, commit `d20fd65`) — consolidated `safe_run` helper at 25s default
  - Both bounded **individual** call sites; neither bounded **cumulative** runtime
- Repository: `Stoffer-Industries/sindustries`
- Branch: `fix-agent-task-queue-hang-cumulative`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/fix-agent-task-queue-hang-cumulative`
- Primary surfaces: `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`, `agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py`

## Why this exists (not bundled with PR #464 or PR #485)

PR #464 was correctly minimal: bound a single `_gh_api` call that was missing a `timeout=`. PR #485 generalized that bound into a shared helper. Both were right-shaped for the bug class they closed — *unguarded `subprocess.run`*. This incident is a **different bug class**: the cumulative runtime of N×K sequential `_gh_api` calls exceeds the heartbeat slot even when every individual call is properly bounded. The right fix is concurrency, not another timeout-tightening. Per `SOUL.md`, when the durable solution (parallelism) is about as easy as another interim shim (yet another `timeout=` kwarg), build the durable boundary now.

## Product summary

Make `agent_task_queue.py --assignee <Rowan|Ivy|Quinn> --json` complete inside the heartbeat slot (≤30s) on the current production workload by:

1. **Per-call `timeout=10` + graceful `TimeoutExpired` handling** — tighten per-call bound from 25s to 10s, and treat a timeout on an individual call as "data unavailable" so the script continues instead of aborting.
2. **Parallelize per-URL PR fetches** — `fetch_linked_delivery_prs` currently does 3 sequential `gh api` calls per linked delivery URL (PR detail, reviews, check-runs). Replace with a `concurrent.futures.ThreadPoolExecutor` fan-out so total wall time is bounded by `max(per_url_latency)` rather than `sum(per_url_latency)`.
3. **Add `--verbose` instrumentation** — per-`fetch_*` wall-time + cumulative `_gh_api` call count to stderr, gated behind a flag so production runs stay quiet.
4. **Tests** — parallel fan-out bounded by max-not-sum + `TimeoutExpired` tolerance produces empty data.

Cross-agent impact: same script is used by Ivy and Quinn. They will hit the same hang on their next heartbeat cycles if not fixed.

## Ownership boundary check

**Natural source of truth:** the `agent_task_queue.py` script itself. This is a single-script performance/correctness change; the boundary is "fix the script + add the tests". No shared library change — `safe_run` and `subprocess_safe.py` are not touched (they already enforce per-call timeouts correctly; the bug is upstream in caller concurrency).

**Why no new shared helper:** the parallelism pattern is specific to one function (`fetch_linked_delivery_prs`) and isn't reused elsewhere yet. Premature abstraction would be wrong here. If a second script later needs the same fan-out, that refactor is a separate task.

**`.openclaw` boundary:** none. No secrets, no OpenClaw runtime config, no cron entries, no env vars. The change is local to Python agent scripts in `agents/skills/ops/tasks-api/scripts/`.

## Root cause (with evidence)

Confirmed by direct invocation against the live tasks-api + sindustries GitHub repo at 08:00 NZST 2026-08-20:

```
$ python3 -u -c "
from agent_task_queue import fetch_agent_tasks, _delivery_urls, _comment_texts
tasks = fetch_agent_tasks('Rowan')
urls = set()
for t in tasks:
    urls.update(_delivery_urls(_comment_texts(t)))
print(f'{len(tasks)} active tasks, {len(urls)} linked delivery URLs')
"
26 active tasks, 12 linked delivery URLs
```

`fetch_linked_delivery_prs` then does **3 `_gh_api` calls per URL** (PR detail, reviews, check-runs), sequentially:

```
for url in sorted(linked_urls):
    ...
    detail = _fetch_github_pr_detail(...)        # 1 gh api call
    detail["reviews"] = _fetch_reviews_tolerant(...) # 1 gh api call
    checks = _gh_api(...check-runs)              # 1 gh api call
```

For Rowan: 12 URLs × 3 calls = **36 sequential `gh api` calls**. At observed ~4-5s per call (git: 2026-08-19 gh API median p50 ~3.2s from local bench), cumulative runtime is ~144s — well past the 30s heartbeat slot. The `safe_run` 25s default bounds individual stuck calls but does not bound cumulative runtime.

The hang manifests as zero stdout/stderr output because:

- `main()` does not print anything until the final `print(json.dumps(...))` at the end
- Python's stdout is block-buffered when not connected to a TTY (heartbeat polls run from a non-interactive shell), so intermediate prints (if any) do not flush
- The 25s `safe_run` per-call bound does not fire because individual calls are completing normally, just slowly
- The watchdog's SIGKILL/SIGTERM hits the process mid-fetch, before the final print, so JSON output never appears

## Proposed fix — design

### Surface 1: `_gh_api` timeout tightening (WS1, AC1)

Current signature:

```python
def _gh_api(config_dir: str, token_env: str, endpoint: str) -> Any:
    ...
    result = safe_run(
        ["gh", "api", endpoint],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return json.loads(result.stdout)
```

Change to:

```python
DEFAULT_GH_API_TIMEOUT_SECONDS: float = 10.0


def _gh_api(config_dir: str, token_env: str, endpoint: str) -> Any:
    ...
    try:
        result = safe_run(
            ["gh", "api", endpoint],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=DEFAULT_GH_API_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise GhApiTimeout(endpoint) from None
    return json.loads(result.stdout)
```

`GhApiTimeout` is a new module-local exception (subclass of `Exception`, not `subprocess.TimeoutExpired`) so callers can distinguish a `gh api`-specific timeout from other `safe_run` timeouts. The caller's `except` clause is `except GhApiTimeout` rather than the bare `subprocess.TimeoutExpired`.

### Surface 2: caller-side timeout tolerance (WS1, AC2)

Current `_fetch_reviews_tolerant`:

```python
try:
    return _gh_api(config_dir, token_env, endpoint)
except subprocess.CalledProcessError as exc:
    stderr = (exc.stderr or "") + (exc.stdout or "")
    if "Could not resolve to a node" in stderr:
        print(...WARN..., file=sys.stderr)
        return []
    raise
```

Change to also catch `GhApiTimeout` and return `[]` with a WARN line, mirroring the existing 404-tolerance pattern. The function is named `_tolerant`; timeout is a similar degradation path.

`fetch_linked_delivery_prs` and `fetch_github_prs` need analogous tolerance — wrap each per-URL `_gh_api` call in `try/except GhApiTimeout` and treat the call as "no data". The output cache (`prs_by_url`) gets the URL key absent, which is the existing behavior for "PR not found" already.

### Surface 3: parallelize `fetch_linked_delivery_prs` (WS2, AC3)

Replace the sequential loop with a `ThreadPoolExecutor` fan-out. Rough shape:

```python
def fetch_linked_delivery_prs(
    agent: str,
    tasks: list[dict[str, Any]],
    github_prs: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    _, config_dir, token_env = GITHUB_IDENTITIES[agent.lower()]
    prs_by_url = {
        str(pr.get("html_url")): pr for pr in (github_prs or []) if pr.get("html_url")
    }
    linked_urls = sorted({
        url
        for task in tasks
        for url in _delivery_urls(_comment_texts(task))
    })
    to_fetch = [url for url in linked_urls if url not in prs_by_url]
    if not to_fetch:
        return prs_by_url

    # Fan out: each URL triggers 3 gh api calls (detail, reviews, check-runs).
    # _gh_api_threadsafe is a thin wrapper that returns (url, payload_or_None)
    # so we can safely accumulate into prs_by_url from multiple threads.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_hydrate_one_pr, config_dir, token_env, url) for url in to_fetch]
        for fut in concurrent.futures.as_completed(futures):
            url, detail = fut.result()
            if detail is not None and detail.get("html_url"):
                prs_by_url[str(detail["html_url"])] = detail
    return prs_by_url
```

`_hydrate_one_pr` is a new helper:

```python
def _hydrate_one_pr(
    config_dir: str, token_env: str, url: str
) -> tuple[str, dict[str, Any] | None]:
    """Fetch PR detail + reviews + check-runs for one delivery URL.

    Returns (url, detail) where detail is None if the PR could not be hydrated
    (timeout, 404, missing). Tolerates GhApiTimeout and CalledProcessError.
    """
    pr_number = _pull_number_from_url(url)
    if pr_number is None:
        return url, None
    try:
        detail = _fetch_github_pr_detail(config_dir, token_env, pr_number)
    except (GhApiTimeout, subprocess.CalledProcessError):
        return url, None
    try:
        detail["reviews"] = _fetch_reviews_tolerant(config_dir, token_env, pr_number)
    except (GhApiTimeout, subprocess.CalledProcessError):
        detail["reviews"] = []
    try:
        checks = _gh_api(
            config_dir,
            token_env,
            f"repos/{REPO}/commits/{detail['head']['sha']}/check-runs?per_page=100",
        )
        detail["check_runs"] = checks.get("check_runs") or []
    except (GhApiTimeout, subprocess.CalledProcessError):
        detail["check_runs"] = []
    return url, detail
```

**Why `max_workers=8`:** GitHub's primary REST rate limit is 5000 req/h per PAT (effectively ~1.4 req/s sustained). With 12 URLs and 3 calls each, parallel = 12×3 = 36 calls. At `max_workers=8`, the steady-state is ~8 in-flight; with ~4s latency per call, that's 8 req / 4s = 2 req/s, well within the limit. Even at 12 concurrent (if all 12 URLs started simultaneously), that's 12 / 4s = 3 req/s — still within the 5 req/s burst limit. 8 is a conservative middle ground.

**Thread safety:** `_gh_api` reads env (immutable per call) and calls `safe_run` which forks a child process. `safe_run` itself is stateless. The shared state we write to (`prs_by_url`, `detail["reviews"]`, `detail["check_runs"]`) is updated via `pool.submit(...).result()` accumulation in the main thread. `_hydrate_one_pr` mutates only its local `detail` dict before returning — no cross-thread mutation. `dict.set` on `prs_by_url[str(detail["html_url"])] = detail` happens in the main thread after `as_completed` yields each future. **Safe.**

### Surface 4: `--verbose` instrumentation (WS3, AC4)

Add a module-level counter and an argparse flag:

```python
_GH_API_CALL_COUNT: int = 0
_VERBOSE: bool = False


def _record_gh_api_call(endpoint: str, latency_s: float) -> None:
    global _GH_API_CALL_COUNT
    _GH_API_CALL_COUNT += 1
    if _VERBOSE:
        print(f"[gh api #{_GH_API_CALL_COUNT}] {latency_s:.2f}s {endpoint}", file=sys.stderr, flush=True)
```

Wrap `_gh_api` to record latency, and add wall-time prints at `fetch_*` function entry/exit when `_VERBOSE` is set. `argparse` gets `--verbose` (default off, store_true). The `--verbose` flag must NOT appear in production heartbeat cron invocations (so production stays quiet).

### Surface 5: tests (WS4, AC5)

Two new test cases in `test_agent_task_queue.py`:

```python
def test_fetch_linked_delivery_prs_runs_urls_in_parallel(self):
    """fetch_linked_delivery_prs total time ≈ max(per_url_latency), not sum."""
    config_dir = "/fake"; token_env = "TOKEN"
    urls = [f"https://github.com/acme/repo/pull/{n}" for n in range(12)]
    tasks = [task(comments=[{"text": f"[implementer-prs] {u}"}]) for u in urls]
    call_latencies = {"detail": 0.5, "reviews": 0.5, "checks": 0.5}

    def fake_gh_api(config_dir, token_env, endpoint):
        kind = next((k for k in call_latencies if k in endpoint), "detail")
        time.sleep(call_latencies[kind])
        return {"check_runs": []}

    with patch.object(agent_task_queue, "_gh_api", side_effect=fake_gh_api):
        with patch.object(agent_task_queue, "_fetch_reviews_tolerant", return_value=[]):
            with patch.object(agent_task_queue, "_fetch_github_pr_detail", return_value={
                "html_url": "https://github.com/acme/repo/pull/0",
                "head": {"sha": "deadbeef"},
                "mergeable": True,
            }):
                t0 = time.monotonic()
                result = agent_task_queue.fetch_linked_delivery_prs(
                    "rowan", tasks, github_prs=[]
                )
                elapsed = time.monotonic() - t0

    # Sequential would be 12 URLs × 1.5s = 18s. Parallel should be ~1.5-2s.
    self.assertLess(elapsed, 5.0, f"expected parallel, got {elapsed:.2f}s")

def test_gh_api_timeout_returns_empty_data_in_caller(self):
    """_fetch_reviews_tolerant catches GhApiTimeout and returns []."""
    config_dir = "/fake"; token_env = "TOKEN"
    with patch.object(
        agent_task_queue,
        "_gh_api",
        side_effect=agent_task_queue.GhApiTimeout("test"),
    ):
        result = agent_task_queue._fetch_reviews_tolerant(config_dir, token_env, 42)
    self.assertEqual(result, [])
```

## What stays the same

- The shape of the JSON output (`build_work_queue`, `build_unified_queue`, `print_human`) — no changes
- `fetch_agent_tasks` — no changes (urllib calls are sub-second each)
- `fetch_github_prs` — no changes to its API; only `fetch_linked_delivery_prs` is parallelized because it's the hot path (12 URLs vs typically 0-3 open PRs)
- `safe_run` / `subprocess_safe.py` — no changes (already correct)
- The `--json` and `--assignee` argparse args — unchanged

## Deliberate non-features

- **No GraphQL batched query.** GitHub's GraphQL API can fetch PR + reviews + check-runs in one call, but that requires a different auth flow (PAT-scoped GraphQL token, GraphQL schema knowledge) and is a much larger change. ThreadPoolExecutor is the right-sized fix.
- **No persistent cache.** Could cache PR data across heartbeats to a local JSON file, but that adds invalidation complexity. The cumulative-runtime fix removes the need.
- **No global deadline watchdog.** Could wrap the whole `main()` in a 25s total deadline, but that complicates exception handling and the parallelism fix should keep us well under slot without it.

## Rollout

1. Land this PR with WS1-WS4 atomic (one commit or a small stack).
2. Quinn reviews + merges.
3. Post-merge: Rowan observes next 3 consecutive heartbeat cycles at 07:00/07:30/08:00 NZST and confirms `agent_task_queue.py --assignee Rowan --json` completes in <15s wall time on the live workload.
4. Lox flips `agent-task-queue-script-subprocess-timeout-race-2026-08-20` to `status=resolved`.

## Acceptance Criteria

- **AC1** `_gh_api` in `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` passes `timeout=10` explicitly and raises a module-local `GhApiTimeout` (subclass of `Exception`) on `subprocess.TimeoutExpired` rather than re-raising the underlying exception.
- **AC2** `_fetch_reviews_tolerant` and `_hydrate_one_pr` catch `GhApiTimeout` and return empty data (`[]` for reviews, `[]` for `check_runs`) with a WARN line to stderr, mirroring the existing 404-tolerance pattern. The script does not abort on a single per-URL timeout.
- **AC3** `fetch_linked_delivery_prs` uses `concurrent.futures.ThreadPoolExecutor(max_workers=8)` to fan out per-URL `_fetch_github_pr_detail` + reviews + check-runs fetches. New helper `_hydrate_one_pr` performs the three calls for one URL and returns `(url, detail_or_None)`. The function's wall time is bounded by the slowest URL's max(3 calls), not the sum across URLs.
- **AC4** The script accepts `--verbose` (default off). When on, each `_gh_api` call prints `[gh api #N] <latency>s <endpoint>` to stderr and `main()` prints per-`fetch_*` wall-time + total `_gh_api` call count at exit. When off, no extra output beyond the existing JSON / human-readable format.
- **AC5** `test_agent_task_queue.py` has two new tests: (a) `test_fetch_linked_delivery_prs_runs_urls_in_parallel` — mocks `_gh_api` with 0.5s latency, runs with 12 linked URLs, asserts total wall time < 5.0s (sequential would be ~18s); (b) `test_gh_api_timeout_returns_empty_data_in_caller` — mocks `_gh_api` to raise `GhApiTimeout`, asserts `_fetch_reviews_tolerant` returns `[]` and `_hydrate_one_pr` returns `(url, None)` rather than propagating.
- **AC6** Post-merge: `agent_task_queue.py --assignee Rowan --json` completes in <15s wall time on the production workload (12+ linked URLs across 26 active tasks) for at least 3 consecutive heartbeat cycles. Quinn validates via `--verbose` log capture during review.