"""Verify every lobster-spawning runner inherits the helper's cleanup-on-timeout path.

Background
----------
Task a7b6fc43: `agents/lib/subprocess_safe.py` bounded `.wait()` but never killed
the child when the bound fired, so a runner that spawned the long-running lobster
CLI died while leaving the lobster (and anything it had forked) running
unsupervised.

The fix landed in the shared helper, not at the call sites: `safe_popen` starts
the child in its own session (`start_new_session=True`) and `wait()` kills the
child's whole process group and reaps it before re-raising `TimeoutExpired`.

That design has one precondition at every call site: the caller must not opt
out of the process-group default, and must let the bounded `wait()` raise
unhandled (or handle it *after* the helper has already cleaned up). A call site
that passes `start_new_session=False` or a custom `preexec_fn` silently falls
back to a direct-child kill — the grandchild-orphan case this task exists to
close would return.

AC2 asks for the three call sites to be *enumerated and each verified*. A prose
grep result goes stale on the next edit, so this test asserts the precondition
mechanically: it fails the moment a runner stops using the helper's cleanup
path. It is a guard on the call sites, not a second implementation of the fix.
"""

import ast
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

# The three lobster-spawning call sites, in scope for AC2.
LOBSTER_RUNNERS = (
    REPO_ROOT / "agents" / "workflows" / "feature-task" / "run.py",
    REPO_ROOT / "agents" / "workflows" / "content-tasks" / "run.py",
    REPO_ROOT / "agents" / "workflows" / "bookmarks" / "run.py",
)

# Kwargs that would opt a call site out of the helper's process-group cleanup.
# `start_new_session=False` keeps the child in the runner's own group, so
# `os.killpg` cannot reach it and the helper degrades to a direct-child kill.
# `preexec_fn` is mutually exclusive with `start_new_session` and likewise
# disables the group-leader guarantee the helper's kill relies on.
CLEANUP_OPT_OUT_KWARGS = ("start_new_session", "preexec_fn")


def _safe_popen_calls(tree: ast.AST) -> list[ast.Call]:
    """Every `safe_popen(...)` call in the module."""
    out: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "safe_popen":
                out.append(node)
    return out


def _kwarg_names(call: ast.Call) -> set[str]:
    """The set of keyword argument names passed to a call."""
    return {kw.arg for kw in call.keywords if kw.arg is not None}


def _has_wait_call(tree: ast.AST) -> bool:
    """True when the module calls `.wait(...)` on the spawned process.

    `proc.wait()` is an attribute call, so this looks for an `ast.Attribute`
    named `wait` rather than a bare function name.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "wait":
                return True
    return False


class RunnerCleanupOnTimeoutTests(unittest.TestCase):
    def test_three_lobster_runners_are_enumerated(self) -> None:
        # AC2: the call-site set is pinned, so adding or dropping a lobster
        # runner is a deliberate edit to this test rather than silent drift.
        self.assertEqual(len(LOBSTER_RUNNERS), 3)
        for run_py in LOBSTER_RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                self.assertTrue(
                    run_py.is_file(),
                    msg=f"enumerated runner {run_py} does not exist",
                )

    def test_each_runner_spawns_the_lobster_via_safe_popen(self) -> None:
        # Every runner in scope must spawn through the shared helper, which is
        # where the cleanup-on-timeout path now lives.
        for run_py in LOBSTER_RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                tree = ast.parse(run_py.read_text())
                calls = _safe_popen_calls(tree)
                self.assertGreater(
                    len(calls),
                    0,
                    msg=(
                        f"{run_py.relative_to(REPO_ROOT)} no longer spawns via "
                        "safe_popen; if the spawn moved, re-verify the "
                        "cleanup-on-timeout path for its new call site"
                    ),
                )

    def test_no_runner_opts_out_of_process_group_cleanup(self) -> None:
        # The helper's group-kill depends on the child being a process-group
        # leader. An explicit `start_new_session=False` or a custom
        # `preexec_fn` breaks that guarantee, so the helper degrades to a
        # direct-child kill and grandchildren survive — the bug this task
        # exists to close.
        for run_py in LOBSTER_RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                tree = ast.parse(run_py.read_text())
                for call in _safe_popen_calls(tree):
                    passed = _kwarg_names(call)
                    for opt_out in CLEANUP_OPT_OUT_KWARGS:
                        self.assertNotIn(
                            opt_out,
                            passed,
                            msg=(
                                f"{run_py.relative_to(REPO_ROOT)} passes "
                                f"{opt_out}= to safe_popen, which opts the call "
                                "site out of the helper's process-group cleanup "
                                "on timeout"
                            ),
                        )

    def test_no_runner_swallows_the_timeout_before_the_helper_cleans_up(self) -> None:
        # The helper cleans up before it re-raises, so a caller may handle the
        # exception — but only *after* the child is dead. A call site that
        # catches TimeoutExpired and returns without ever waiting on the proc
        # would leave the timeout unenforced entirely.
        for run_py in LOBSTER_RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                tree = ast.parse(run_py.read_text())
                self.assertTrue(
                    _has_wait_call(tree),
                    msg=(
                        f"{run_py.relative_to(REPO_ROOT)} never waits on the "
                        "spawned process; the bounded timeout (and therefore "
                        "the cleanup-on-timeout path) is not exercised"
                    ),
                )


if __name__ == "__main__":
    unittest.main()
