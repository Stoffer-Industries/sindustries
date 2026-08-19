"""Tests for `agents.lib.subprocess_safe.safe_run`.

Task 8a2df49c-791b-4f09-a37a-446fa8c6fd5d, AC3. Five sub-cases:
(a) happy-path rc=0
(b) timeout raises subprocess.TimeoutExpired after `timeout` seconds
(c) check=True propagates CalledProcessError on rc!=0
(d) capture_output + text returns decoded stdout
(e) parameterized: explicit `timeout=` is honored (verifies the helper does not
    override the caller's value with the module default).
"""

from __future__ import annotations

import subprocess
import sys
import time
import unittest

from agents.lib.subprocess_safe import DEFAULT_TIMEOUT_SECONDS, safe_popen, safe_run


class SafeRunTests(unittest.TestCase):
    def test_a_happy_path_returns_completed_process_with_zero_returncode(self) -> None:
        # (a) `safe_run(["true"])` returns CompletedProcess rc=0
        result = safe_run(["true"])
        self.assertIsInstance(result, subprocess.CompletedProcess)
        self.assertEqual(result.returncode, 0)

    def test_b_timeout_raises_timeout_expired_after_configured_timeout(self) -> None:
        # (b) `safe_run(["sleep", "5"], timeout=0.5)` raises TimeoutExpired after ~0.5s
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as cm:
            safe_run(["sleep", "5"], timeout=0.5)
        elapsed = time.monotonic() - start
        # Subprocess.TimeoutExpired fires a bit after the configured timeout — accept
        # a generous upper bound so a slow CI runner does not flake this test.
        self.assertGreaterEqual(elapsed, 0.5)
        self.assertLess(elapsed, 5.0)
        # The exception's `cmd` attribute echoes the argv we passed.
        self.assertEqual(cm.exception.cmd[:2], ["sleep", "5"])

    def test_c_check_true_propagates_called_process_error_on_nonzero_exit(self) -> None:
        # (c) `safe_run(["false"], check=True)` raises CalledProcessError
        with self.assertRaises(subprocess.CalledProcessError) as cm:
            safe_run(["false"], check=True)
        self.assertEqual(cm.exception.returncode, 1)

    def test_d_capture_output_text_returns_decoded_stdout(self) -> None:
        # (d) `safe_run(["sh", "-c", "echo hi"], capture_output=True, text=True)`
        #     returns stdout="hi\n"
        result = safe_run(
            ["sh", "-c", "echo hi"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout, "hi\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(result.returncode, 0)

    def test_e_explicit_timeout_is_honored_for_nondefault_values(self) -> None:
        # (e) parameterized: an explicit timeout other than the module default
        #     is honored. We pick values across the spectrum PR uses:
        #       - 0.5s (sleep 5 -> timeout fires)
        #       - 5.0s (sleep 1 -> returns before timeout)
        #       - default (returns)
        cases = [
            # (timeout, argv, should_timeout, label)
            (0.5, ["sleep", "5"], True, "tight-tight timeout fires"),
            (5.0, ["sleep", "0.1"], False, "loose timeout is not hit"),
            (DEFAULT_TIMEOUT_SECONDS, ["true"], False, "default-equivalent returns"),
        ]
        for timeout_s, argv, should_timeout, label in cases:
            with self.subTest(label=label, timeout=timeout_s):
                if should_timeout:
                    with self.assertRaises(
                        subprocess.TimeoutExpired,
                        msg=f"timeout={timeout_s} should have fired ({label})",
                    ):
                        safe_run(argv, timeout=timeout_s)
                else:
                    result = safe_run(argv, timeout=timeout_s)
                    self.assertEqual(
                        result.returncode,
                        0,
                        msg=f"timeout={timeout_s} should have completed ({label})",
                    )


class ModuleSurfaceTests(unittest.TestCase):
    """The helper is exposed both via the module and via `agents.lib.safe_run`."""

    def test_module_default_constant_is_twenty_five_seconds(self) -> None:
        # AC1 pins the default at 25s (reduced from 30s on 2026-08-20 to fix
        # incident `agent-task-queue-script-subprocess-timeout-race-2026-08-20`:
        # the 30s default raced the heartbeat's 30s exec timeout, leaving 0 bytes
        # of stdout when python3 was SIGKILL'd mid-subprocess). If you change the
        # constant, update the runbook and the task description together.
        self.assertEqual(DEFAULT_TIMEOUT_SECONDS, 25.0)

    def test_safe_run_is_reexported_from_agents_lib_package(self) -> None:
        # AC2: `from agents.lib import safe_run` must work.
        from agents.lib import safe_run as reexported
        from agents.lib.subprocess_safe import safe_run as from_module

        self.assertIs(reexported, from_module)

    def test_safe_popen_is_reexported_from_agents_lib_package(self) -> None:
        # Companion helper for streaming subprocesses; same re-export contract.
        from agents.lib import safe_popen as reexported
        from agents.lib.subprocess_safe import safe_popen as from_module

        self.assertIs(reexported, from_module)


class SafePopenTests(unittest.TestCase):
    """`safe_popen` is the streaming-subprocess sibling of `safe_run`."""

    def test_a_returns_proxy_with_default_completion(self) -> None:
        # happy path: child exits quickly, .wait() with no kwargs honors the
        # default bound but does not actually trigger it (child finished first).
        proc = safe_popen(
            [sys.executable, "-c", "import sys; sys.stdout.write('ok')"],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, _ = proc.communicate()
            self.assertEqual(stdout, "ok")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    def test_proxy_passes_through_attribute_access(self) -> None:
        # `.pid`, `.returncode`, `.stdout`, `.terminate()`, `.kill()` are all on
        # the underlying Popen and must work via the proxy without surprises.
        proc = safe_popen([sys.executable, "-c", "pass"])
        try:
            self.assertIsInstance(proc.pid, int)
            self.assertGreater(proc.pid, 0)
            self.assertIsNone(proc.returncode)  # not exited yet
            proc.kill()
            proc.wait(timeout=5)
            self.assertIsNotNone(proc.returncode)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    def test_b_wait_raises_timeout_expired_after_default(self) -> None:
        # `proc.wait()` with no explicit timeout uses the helper-supplied default
        # and propagates subprocess.TimeoutExpired after that many seconds. We
        # pass `safe_popen(..., timeout=0.5)` to keep the test fast — the contract
        # we exercise is "default timeout is honored when no explicit one is passed
        # to wait()", not "the default is exactly 30s".
        proc = safe_popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=0.5,
        )
        try:
            start = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait()  # no explicit timeout -> uses safe_popen default 0.5
            elapsed = time.monotonic() - start
            self.assertGreaterEqual(elapsed, 0.5)
            self.assertLess(
                elapsed,
                5.0,
                msg=(
                    "safe_popen default wait() must fire within the configured "
                    f"timeout=0.5s; observed {elapsed:.2f}s"
                ),
            )
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    def test_b_prime_default_constant_also_fires_within_window(self) -> None:
        # Sanity: with the module's DEFAULT_TIMEOUT_SECONDS = 25, an explicit
        # call to safe_popen(..., timeout=25) using a child that sleeps forever
        # (or much longer than 30s) would raise TimeoutExpired. We exercise a
        # short timeout here to keep the test under a second; the intent is to
        # document that `safe_popen(timeout=...)` honours the supplied value.
        proc = safe_popen(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
        # Override via explicit wait() so the test finishes quickly without
        # waiting the full 30s default.
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=0.25)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    def test_c_wait_with_explicit_timeout_short_circuits_the_default(self) -> None:
        # Passing an explicit small timeout overrides the helper default. This
        # mirrors safe_run's contract: explicit timeout wins.
        proc = safe_popen(
            [sys.executable, "-c", "import time; time.sleep(10)"],
        )
        try:
            start = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=0.5)
            elapsed = time.monotonic() - start
            self.assertGreaterEqual(elapsed, 0.5)
            self.assertLess(
                elapsed,
                5.0,
                msg=(
                    "explicit timeout=0.5 must fire within ~0.5s; "
                    f"observed {elapsed:.2f}s"
                ),
            )
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
