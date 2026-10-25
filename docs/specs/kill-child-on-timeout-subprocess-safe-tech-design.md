---
status: shipped
task_id: a7b6fc43-51bb-48e7-8859-4766ff50a4a1
product_spec: n/a
shipped_pr: 883
shipped_date: 2026-10-25
---

# Tech Design — Kill the child process group on timeout in `safe_popen`

## Links and scope

- Task: `a7b6fc43-51bb-48e7-8859-4766ff50a4a1` — Kill the child process on timeout in the shared subprocess helper
- Surfaced during: review of PR #882 (rowanstoffer, 2026-10-25, merged) — raising the content/bookmarks runner timeout from 25s to 45s gives a stuck lobster 20 more seconds before the runner dies, and it still dies leaving the child running. Deliberately kept out of #882 because it's unrelated shared-helper semantics, not a per-runner timeout value.
- Predecessor design: `docs/specs/agent-script-subprocess-safe-run-tech-design.md` (introduced `safe_run`/`safe_popen` and the documented "not auto-killed" non-feature this task reverses)
- Repository: `Stoffer-Industries/sindustries`
- Branch: `kill-child-on-timeout-a7b6fc43`
- Worktree: `/Volumes/WD1/worktrees/quinn/kill-child-on-timeout-a7b6fc43`
- Primary surfaces: `agents/lib/subprocess_safe.py`, `agents/lib/test_subprocess_safe.py`

## Product summary

`agents/lib/subprocess_safe.py`'s `_TimeoutAwarePopen.wait()` bounds the wait but does not kill the child when the bound fires — documented as a deliberate non-feature ("callers that want cleanup on timeout wrap the call site themselves"). No call site does. All three lobster-spawning runners (`agents/workflows/feature-task/run.py`, `agents/workflows/content-tasks/run.py`, `agents/workflows/bookmarks/run.py`) call `proc.wait()` directly and let `subprocess.TimeoutExpired` propagate uncaught, so the runner process exits while the `lobster` child (and anything it has itself forked) keeps running, unsupervised, with no runner left to collect its result.

## Ownership boundary check

**Natural source of truth:** the shared helper, `agents/lib/subprocess_safe.py`. This is exactly the AC1 framing — "the helper exposes a documented cleanup path that every call site uses" — and it is also the cheaper shape: fixing `_TimeoutAwarePopen.wait()` once closes the gap at all three current call sites (and any future one) with zero call-site changes, versus three near-identical `try/except TimeoutExpired: kill(); wait(); raise` blocks that the next new call site would have to remember to copy. Per `SOUL.md`, when the durable shared-helper fix is about as easy as the interim per-call-site shim, build the durable shape now — here the helper fix is strictly less code than patching three call sites.

**No service boundary change.** No API, database, queue, or cron changes. Still a private intra-repo Python contract between `agents/lib/` and its three callers.

## `.openclaw` boundary

None. No secrets, no OpenClaw runtime config. Same module, same callers.

## Design

### Problem with today's `_TimeoutAwarePopen.wait()`

```python
def wait(self, timeout: float | None = None) -> int:
    bound = self._default_timeout if timeout is None else timeout
    return self._popen.wait(timeout=bound)
```

`subprocess.Popen.wait(timeout=...)` raises `subprocess.TimeoutExpired` without touching the child. Today's three call sites (`feature-task/run.py:229`, `content-tasks/run.py:91`, `bookmarks/run.py:116`) all do `returncode = proc.wait()` with no surrounding `try/except` — the exception propagates out of `run_workflow()`/`run()` uncaught. The `lobster` child is orphaned. If `lobster` itself has forked a grandchild (e.g. a sub-tool invocation), killing only the direct child via `Popen.kill()` would still leave that grandchild running — a plain `kill()` is not enough; the fix needs to reach the whole process tree the child spawned.

### Fix: process-group kill + re-wait inside `wait()`

1. **`safe_popen` starts the child in its own process group by default.** Add `start_new_session=True` to the `subprocess.Popen(...)` call in `safe_popen`, but only when the caller has not already supplied `start_new_session` or `preexec_fn` in `**kwargs` — an explicit caller choice is preserved. None of the three current call sites pass either kwarg (verified by grep), so all three pick up the new default. `start_new_session=True` makes the child (pid == pgid) the leader of its own process group, so `os.killpg(pid, signal.SIGKILL)` reaches it and every process it has itself forked, not just the direct child.

2. **`_TimeoutAwarePopen.wait()` catches the timeout, kills the group, reaps, and re-raises the original exception:**

```python
def wait(self, timeout: float | None = None) -> int:
    bound = self._default_timeout if timeout is None else timeout
    try:
        return self._popen.wait(timeout=bound)
    except subprocess.TimeoutExpired:
        self._kill_process_group()
        try:
            self._popen.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass  # best-effort reap; SIGKILL should always land, but don't hang here
        raise

def _kill_process_group(self) -> None:
    try:
        os.killpg(self._popen.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # Not a group leader (caller opted out via start_new_session=False /
        # preexec_fn), or it already exited. Fall back to killing the direct
        # child so we still make a best effort.
        try:
            self._popen.kill()
        except ProcessLookupError:
            pass
```

The **re-raise is unchanged behaviour** — every existing caller still sees `subprocess.TimeoutExpired` exactly as before, with the same `.cmd`/`.timeout` attributes. Only the child's fate changes: it is dead (and reaped, so no zombie) by the time the exception reaches the caller, instead of still running. This is why AC2 needs zero changes at the three call sites — the fix is below the API they already call.

### Why not add cleanup at each of the 3 call sites instead

Rejected: it's the same amount of code duplicated three times, it doesn't close the gap for the next workflow that calls `safe_popen` and forgets the wrapper, and it contradicts the module's own stated purpose ("consolidate ... so the next script author cannot reintroduce the ... bug class" — from the predecessor tech design). The helper-level fix is the one that matches that intent.

### Why `start_new_session=True` and not a bare `proc.kill()`

`lobster run --mode tool ...` is a long-running CLI; whether it forks further children for the "tool" it is told to run is not something this runner can assume `false` about, and getting this wrong silently reintroduces exactly the kind of "runner exits, child(ren) survive" bug the task exists to close. `Popen.kill()` sends `SIGKILL` to the one PID the runner holds; `os.killpg` sends it to every process in that PID's process group, which only exists if the child was started as a group leader. The incremental cost of `start_new_session=True` is one kwarg in `safe_popen`'s `Popen(...)` call; the alternative (walking `/proc`-equivalent on macOS to find children) is far more code for a weaker guarantee.

**Behavioural side-effect, named as a risk below:** a process-group leader does not receive signals sent to the *parent's* group (e.g. a Ctrl-C to the runner's terminal session no longer propagates to the child). This is the intended isolation for an unattended agent runner and is already irrelevant for the cron/heartbeat-invoked runners in scope, but it is a real semantic change worth a reviewer's eyes.

## Deliberate non-features (updated)

- Still **no entry-print log on every call** — unchanged, out of scope per the predecessor design.
- Still **no `TimeoutExpired` swallowing** — `wait()` still raises; only the child's liveness changes, not the caller-visible contract.
- **Removed:** "on timeout, the proc is not auto-killed." Replaced with the new contract documented in the module and `wait()` docstrings.

## Implementation plan — file/module scope

1. `agents/lib/subprocess_safe.py`:
   - Add `import os`, `import signal` to the top-level imports.
   - `safe_popen`: default `start_new_session=True` into `kwargs` only if `"start_new_session"` and `"preexec_fn"` are both absent from the caller's `kwargs`.
   - `_TimeoutAwarePopen`: add `_kill_process_group()` and rewrite `wait()` per the Design section.
   - Update the module docstring (the `safe_popen` "Notes" bullet and "Deliberate non-features" list) and the `wait()`/`safe_popen` function docstrings to state the new contract (AC4).
2. `agents/lib/test_subprocess_safe.py`: add the two new `SafePopenTests` cases from the Test plan below. No changes needed to `SafeRunTests` (out of scope — `safe_run` already uses blocking `subprocess.run`, which has no separate "orphan the child" failure mode the way a decoupled `Popen` + `.wait()` does).
3. No changes to `agents/workflows/feature-task/run.py`, `agents/workflows/content-tasks/run.py`, or `agents/workflows/bookmarks/run.py` — this is the point of fixing it in the helper (AC2).
4. Update `agents/lib/__init__.py` docstring module list if it references the "not auto-killed" behaviour — it currently does not (checked), so no change expected there; confirm at implementation time.

### Files NOT touched

- The three runner files (see above — intentional).
- `agents/lib/incident_state.py` and its tests — unrelated surface.
- `safe_run` / `SafeRunTests` — `safe_run` blocks on `subprocess.run`, which already fully owns the child for its whole lifetime; there is no decoupled `Popen` object a caller could leak a reference to after a timeout, so this task's failure mode does not apply there.

## Data model / API contract

None. Same private intra-repo Python contract; only the behaviour of `wait()` on timeout changes (child now guaranteed dead), not its signature or exception type.

## Workflow / cron / skill changes

None. The three runners (feature-task, content-tasks, bookmarks) keep the exact same call shape; their crons are unaffected.

## Test plan — `agents/lib/test_subprocess_safe.py`

New cases added to the existing `SafePopenTests` class (same file, same `unittest` convention as the predecessor design):

| # | Test | What it asserts |
|---|---|---|
| (f) | `test_wait_kills_child_on_timeout` | Spawn `python3 -c "import time; time.sleep(30)"` via `safe_popen(..., timeout=0.3)`; call `proc.wait()`; assert it raises `TimeoutExpired`; then assert the child's pid is actually dead (`os.kill(pid, 0)` raises `ProcessLookupError`) — not just that `.poll()` is non-`None` after the fact, since the point is that the OS process is gone, not just that Python thinks so. |
| (g) | `test_wait_kills_descendant_in_process_group_on_timeout` | Spawn a shell child that itself forks a grandchild and prints the grandchild's pid before blocking (`sh -c 'sleep 30 & echo $!; wait'`), via `safe_popen(..., timeout=0.3, stdout=PIPE, text=True)`. Read the grandchild pid from the first stdout line. Call `proc.wait()`, expect `TimeoutExpired`. Assert the grandchild pid is also dead (`os.kill(grandchild_pid, 0)` raises `ProcessLookupError`) — proves the fix kills the *process group*, not just the direct child, which a bare `proc.kill()` would not do. |

**Negative control (dev-time only, not committed as a test):** before adding the kill logic, run case (f) against the current `wait()` and confirm it fails (child still alive after `TimeoutExpired`); after the fix, confirm it passes. Mirrors the verification approach in PR #882's test plan. Not kept as a permanent "assert the bug" test — (f) and (g) above are the permanent regression coverage.

Existing `SafePopenTests` cases that already do `if proc.poll() is None: proc.kill(); proc.wait(timeout=5)` cleanup in their `finally` blocks are unaffected: after the fix, `.poll()` is already non-`None` by the time `finally` runs (the child is dead), so that cleanup becomes a no-op rather than doing real work — no test changes required there.

## AC-by-AC verification matrix

| AC | What it claims | How it verifies | Failure mode |
|---|---|---|---|
| AC1 | On timeout, `wait()` kills the child (group) and re-waits so the child does not survive the parent | Tests (f) and (g) above | Child/grandchild pid still answers to `os.kill(pid, 0)` after `TimeoutExpired` |
| AC2 | The three lobster-spawning call sites each have a verified cleanup-on-timeout path | Code audit (already performed): `grep -n "safe_popen\|\.wait(\|TimeoutExpired" ` across all three files shows each does a bare `proc.wait()` with no competing `try/except TimeoutExpired`, no `start_new_session`/`preexec_fn` override, so the helper-level fix applies unmodified to every one | A call site that already wraps `TimeoutExpired` differently, or passes `start_new_session=False`, would not get the group-kill cleanup — re-grep at implementation time to confirm no drift since this design was written |
| AC3 | An executable test proves the child is gone after a timeout, including a negative control that fails against current no-kill behaviour | Tests (f)/(g) plus the dev-time negative-control run described in Test plan | Test passes with the kill logic absent, or flakes under load |
| AC4 | The helper docstring's "not auto-killed" note is updated to state the new contract; non-features list stays accurate | `git diff` on the module docstring, `wait()` docstring, and "Deliberate non-features" list | Docstring still says "not auto-killed" after the behaviour changed |

## Open questions and risks

1. **Process-group isolation changes signal propagation.** A group leader no longer receives signals sent to the parent's group (e.g. terminal Ctrl-C). All three current callers are cron/heartbeat-invoked runners, not interactive sessions, so this is low risk, but it's a real behavioural change beyond "kill on timeout" and worth a reviewer's explicit sign-off rather than being buried in the diff.
2. **`os.killpg` targets `self._popen.pid` directly instead of `os.getpgid(pid)`.** This relies on `start_new_session=True` making pid == pgid, which is correct for every call site that doesn't override it. If a caller does pass `start_new_session=False` or a custom `preexec_fn`, `os.killpg` will raise (caught) and the code falls back to `popen.kill()` — a direct-child-only kill, same as the old behaviour, which is an accepted degraded case for an explicit opt-out, not a silent gap for the three in-scope callers.
3. **Grandchildren that double-fork out of the group** (daemonize themselves) would escape `killpg`. Not observed in the current `lobster` CLI's behaviour; flagging as a known limitation rather than attempting a process-tree walk, which is disproportionate for this task's scope.
4. **5s re-wait bound after `SIGKILL`.** Chosen to avoid `wait()` hanging indefinitely in the rare case the child is stuck in an uninterruptible kernel call. If that bound is ever hit, `wait()` still re-raises the original `TimeoutExpired` (not a second exception) — the caller's contract is unchanged, but the child may not be reaped by then (zombie, cheap, reaped eventually by `init`/launchd). Acceptable for this task's scope.

## References

- Predecessor tech design: `docs/specs/agent-script-subprocess-safe-run-tech-design.md`
- Helper under change: `agents/lib/subprocess_safe.py`
- Tests: `agents/lib/test_subprocess_safe.py`
- Call sites (unmodified by this task): `agents/workflows/feature-task/run.py:213-229`, `agents/workflows/content-tasks/run.py:77-91`, `agents/workflows/bookmarks/run.py:93-116`
- Originating PR context: #882 (merged 2026-10-25) — `fix(workflows): pin lobster subprocess timeout in content and bookmarks runners`
- Tech-design skill: `agents/skills/dev/tech-design/SKILL.md`
- Doc conventions: `docs/CONVENTIONS.md`
