"""Bounded-time `subprocess` wrappers for agent scripts.

Task 8a2df49c-791b-4f09-a37a-446fa8c6fd5d: consolidate the systemic pattern surfaced
by `agent-task-queue-gh-api-hang-2026-08-17` onto a single shared helper so the next
script author cannot reintroduce the unguarded-`subprocess.run` class of bug.

Public API:
    DEFAULT_TIMEOUT_SECONDS: float = 25.0
        Module-level default. Set 5s below the heartbeat's 30s exec timeout so that
        `subprocess.TimeoutExpired` raises (and python3 flushes stdout) before the
        parent exec timeout fires — incident `agent-task-queue-script-subprocess-timeout-race-2026-08-20`.
        Long enough for normal GitHub-API tail latency, short enough that the
        heartbeat's stuck state is bounded.

    safe_run(cmd, *, timeout=DEFAULT_TIMEOUT_SECONDS, **kwargs) -> subprocess.CompletedProcess
        `subprocess.run` with a default timeout. **kwargs forwards verbatim, so
        `check=`, `capture_output=`, `text=`, `env=`, `cwd=`, `input=`, `shell=`,
        and other `subprocess.run` kwargs work as before. **kwargs cannot include
        `timeout=` — that's the only named kwarg captured by `safe_run`.

        Raises:
            subprocess.TimeoutExpired — after `timeout` seconds if the child has not
                exited. Callers own the policy (raise, retry, or record-and-skip).
            subprocess.CalledProcessError — only when `check=True` and the child
                exits non-zero.

    safe_popen(cmd, *, timeout=DEFAULT_TIMEOUT_SECONDS, **kwargs) -> _TimeoutAwarePopen
        `subprocess.Popen` whose `.wait()` is bounded by a default timeout. The
        returned object proxies the underlying Popen so attributes like `.stdout`,
        `.stdin`, `.stderr`, `.pid`, `.terminate()`, and `.kill()` work as before.
        Only `.wait()` is intercepted to apply the default timeout when called
        without an explicit value. **kwargs forwards verbatim (the constructor
        itself accepts no `timeout=`).

        Notes:
            * `subprocess.Popen` does not accept `timeout=` at construction. The
              bound is enforced on `.wait()`, which is the only blocking call.
            * The child is started in its own session/process group by default
              (`start_new_session=True`), so a timeout can kill the whole group the
              child spawned — not just the direct child. An explicit caller
              `start_new_session=` or `preexec_fn=` is preserved and opts out of
              that default (the timeout then degrades to a direct-child kill).
            * On timeout, the child process group is killed and reaped before
              `subprocess.TimeoutExpired` propagates — the child does not survive
              the parent's exit. `safe_run`'s posture of "no swallowing" still
              applies: the exception type and attributes are unchanged.
            * Streaming reads on `.stdout` / `.stderr` continue to work. Pair with
              `.wait()` and you'll be bounded at `timeout` seconds for the lifetime
              of the parent read.

        Deliberate non-features (mirror `safe_run`):
            * No entry-print log on every call (would require call-site context the
              helper does not have; the runbook recommends this as a separate chore).
            * No `TimeoutExpired` swallowing (callers own the policy). The timeout
              still raises; only the child's fate changed (dead instead of orphaned).
            * No process-tree walk beyond the child's own process group. A
              grandchild that double-forks out of the group escapes the kill.
            * No default for `timeout` other than `DEFAULT_TIMEOUT_SECONDS`. Pass
              `timeout=None` explicitly to opt out (legacy `subprocess.run` semantics).

See `agents/lib/test_subprocess_safe.py` for the executable contract.
"""

from __future__ import annotations

import os
import signal
import subprocess
from typing import Any

DEFAULT_TIMEOUT_SECONDS: float = 25.0

# Bound on the post-kill re-wait. SIGKILL should always land, but we never hang
# here: if the bound is hit we re-raise the original TimeoutExpired anyway and
# the (now unreaped) child is left for init/launchd to collect.
POST_KILL_REWAIT_SECONDS: float = 5.0


def safe_run(
    cmd: list[str],
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """subprocess.run with a default timeout. **kwargs forwards verbatim.

    Raises:
        subprocess.TimeoutExpired — after `timeout` seconds if the child has not exited.
            Callers own the policy (raise, retry, or record-and-skip).
        subprocess.CalledProcessError — only when `check=True` and the child exits non-zero.

    No swallowing. No entry-print log. No default for `timeout` other than the module constant.
    """
    return subprocess.run(cmd, timeout=timeout, **kwargs)


class _TimeoutAwarePopen:
    """subprocess.Popen proxy that bounds the default `wait()` timeout.

    Attribute access is delegated to the underlying Popen so call sites that use
    `.stdout`, `.stdin`, `.stderr`, `.pid`, `.terminate()`, `.kill()`, etc. work
    transparently. Only `.wait()` is intercepted to apply the default timeout when
    no explicit timeout is given.
    """

    __slots__ = ("_popen", "_default_timeout")

    def __init__(self, popen: subprocess.Popen, default_timeout: float) -> None:
        self._popen = popen
        self._default_timeout = default_timeout

    def wait(self, timeout: float | None = None) -> int:
        bound = self._default_timeout if timeout is None else timeout
        try:
            return self._popen.wait(timeout=bound)
        except subprocess.TimeoutExpired:
            self._kill_process_group()
            try:
                self._popen.wait(timeout=POST_KILL_REWAIT_SECONDS)
            except subprocess.TimeoutExpired:
                # Best-effort reap only. The child's contract (TimeoutExpired
                # propagates unchanged) wins over a guaranteed reaped child.
                pass
            raise

    def _kill_process_group(self) -> None:
        """Kill the child (and everything it spawned) on timeout.

        Prefers a process-group kill, which reaches grandchildren the child
        forked — a bare `Popen.kill()` would leave those running. Falls back to
        a direct-child kill when the caller opted out of `start_new_session`
        (or a custom `preexec_fn`), where the child is not a group leader.
        """
        pid = self._popen.pid
        try:
            pgid = os.getpgid(pid)
        except (ProcessLookupError, PermissionError):
            pgid = None
        if pgid is not None and pgid == pid:
            try:
                os.killpg(pgid, signal.SIGKILL)
                return
            except (ProcessLookupError, PermissionError):
                pass
        try:
            self._popen.kill()
        except (ProcessLookupError, PermissionError):
            pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._popen, name)

    def __repr__(self) -> str:
        return (
            f"_TimeoutAwarePopen({self._popen!r}, "
            f"default_timeout={self._default_timeout})"
        )


def safe_popen(
    cmd: list[str],
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    **kwargs: Any,
) -> _TimeoutAwarePopen:
    """subprocess.Popen whose `.wait()` defaults to a bounded timeout.

    The returned object proxies the underlying subprocess.Popen so all attributes
    (`.stdout`, `.stdin`, `.stderr`, `.pid`, `.terminate()`, `.kill()`, etc.) work
    as before. Only `.wait()` is intercepted to apply `timeout` (default
    `DEFAULT_TIMEOUT_SECONDS`) when no explicit timeout is given. Pass an explicit
    `timeout=` to `.wait()` to override.

    Raises:
        subprocess.TimeoutExpired — propagated from the underlying `.wait(timeout=...)`
            after the bound elapses. The child's process group is killed and reaped
            first, so the child does not survive the parent's exit; the exception
            type and attributes are unchanged.
    """
    if "start_new_session" not in kwargs and "preexec_fn" not in kwargs:
        # Own session => the child is its own process-group leader, so a timeout
        # can kill the whole tree it spawned, not just the direct child.
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **kwargs)
    return _TimeoutAwarePopen(proc, default_timeout=timeout)


__all__ = ["safe_run", "safe_popen", "DEFAULT_TIMEOUT_SECONDS"]