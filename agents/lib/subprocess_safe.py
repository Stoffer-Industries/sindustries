"""Bounded-time `subprocess` wrappers for agent scripts.

Task 8a2df49c-791b-4f09-a37a-446fa8c6fd5d: consolidate the systemic pattern surfaced
by `agent-task-queue-gh-api-hang-2026-08-17` onto a single shared helper so the next
script author cannot reintroduce the unguarded-`subprocess.run` class of bug.

Public API:
    DEFAULT_TIMEOUT_SECONDS: float = 30.0
        Module-level default. Long enough to absorb normal GitHub-API tail latency,
        short enough that the heartbeat's stuck state is bounded.

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
            * On timeout, the proc is not auto-killed — `safe_run`'s posture of
              "no swallowing" applies. Callers that want cleanup on timeout wrap
              the call site themselves (kill + re-wait, then raise).
            * Streaming reads on `.stdout` / `.stderr` continue to work. Pair with
              `.wait()` and you'll be bounded at `timeout` seconds for the lifetime
              of the parent read.

        Deliberate non-features (mirror `safe_run`):
            * No entry-print log on every call (would require call-site context the
              helper does not have; the runbook recommends this as a separate chore).
            * No `TimeoutExpired` swallowing (callers own the policy).
            * No default for `timeout` other than `DEFAULT_TIMEOUT_SECONDS`. Pass
              `timeout=None` explicitly to opt out (legacy `subprocess.run` semantics).

See `agents/lib/test_subprocess_safe.py` for the executable contract.
"""

from __future__ import annotations

import subprocess
from typing import Any

DEFAULT_TIMEOUT_SECONDS: float = 30.0


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
        return self._popen.wait(timeout=bound)

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
            after the bound elapses. No cleanup is performed; callers that want to reap
            a stuck child wrap the call site (kill + brief re-wait, then re-raise).
    """
    proc = subprocess.Popen(cmd, **kwargs)
    return _TimeoutAwarePopen(proc, default_timeout=timeout)


__all__ = ["safe_run", "safe_popen", "DEFAULT_TIMEOUT_SECONDS"]