"""Regression test for the content-task and bookmarks runners' lobster subprocess timeout.

Background
----------
Cron 3c2fa067 (Task Lobsters) soft-failed on 2026-10-25 with
`subprocess.TimeoutExpired` after 25.0s from
`agents/workflows/content-tasks/run.py`. The 25s bound is
`agents/lib/subprocess_safe.py:DEFAULT_TIMEOUT_SECONDS` (per d52c3ca, with 5s
margin below the heartbeat's 30s exec timeout).

The content lobster needs ~22-24s for a single task, so the inherited default
left only ~2s of headroom. A run that overran the bound raised
`subprocess.TimeoutExpired` inside `run_workflow()`, so `run.py` died with a
traceback and exited 1 *even though the lobster subprocess had already
completed and written a valid `ok: true` envelope* — the wrapper abandoned a
successful run before collecting it. Re-running the same task on the same
commit succeeded (exit 0, 22s), confirming a race rather than a deterministic
fault.

Per-rowan review on PR #660: the shared default stays at 25s (heartbeat/interactive
callers rely on the 5s margin); a runner opts into a longer bound explicitly via
`LOBSTER_SUBPROCESS_TIMEOUT_SECONDS` at its own boundary. The feature-task runner
already does this (45s, for the W37 A3 carve tasks). This test asserts the same
for the content-task and bookmarks runners, so a future revert to the default
(or a typo) is caught before it ships.
"""

import ast
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNERS = (
    REPO_ROOT / "agents" / "workflows" / "content-tasks" / "run.py",
    REPO_ROOT / "agents" / "workflows" / "bookmarks" / "run.py",
)


def _module_constants(path: Path) -> dict[str, object]:
    """Return a dict of module-level constant assignments from a Python source file.

    Handles both `NAME = value` (ast.Assign) and `NAME: type = value` (ast.AnnAssign)
    forms so type-annotated constants are captured too.
    """
    tree = ast.parse(path.read_text())
    constants: dict[str, object] = {}
    for node in tree.body:
        # Plain assignment: NAME = value
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and isinstance(node.value, ast.Constant):
                constants[target.id] = node.value.value
        # Annotated assignment: NAME: type = value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.value is not None and isinstance(node.value, ast.Constant):
                constants[node.target.id] = node.value.value
    return constants


def _safe_popen_calls(tree: ast.AST) -> list:
    out: list = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "safe_popen":
                out.append(node)
    return out


class RunnerLobsterTimeoutTests(unittest.TestCase):
    def test_runner_declares_explicit_lobster_timeout_constant(self) -> None:
        # Each runner boundary must declare an explicit timeout above the 25s default.
        # 45s matches the feature-task runner's agreed value (per rowan review on
        # PR #660): long enough for a slow lobster subprocess, short enough to keep
        # fail-fast on a genuinely stuck one.
        for run_py in RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                constants = _module_constants(run_py)
                self.assertIn(
                    "LOBSTER_SUBPROCESS_TIMEOUT_SECONDS",
                    constants,
                    f"{run_py.name} must declare LOBSTER_SUBPROCESS_TIMEOUT_SECONDS "
                    "explicitly so the lobster subprocess doesn't race the 25s "
                    "DEFAULT_TIMEOUT_SECONDS default. Same defect class as the "
                    "feature-task runner fix (incident "
                    "`task-lobsters-cron-runner-termination-2026-09-13`) and the "
                    "2026-10-25 content-task cron failure.",
                )
                self.assertEqual(
                    constants["LOBSTER_SUBPROCESS_TIMEOUT_SECONDS"],
                    45.0,
                    f"LOBSTER_SUBPROCESS_TIMEOUT_SECONDS must be 45.0s (per rowan "
                    f"review on PR #660); current value in {run_py.name} regresses "
                    "the timeout fix.",
                )

    def test_safe_popen_call_passes_explicit_timeout(self) -> None:
        # The safe_popen call that runs the lobster subprocess must pass timeout=
        # explicitly rather than relying on the DEFAULT_TIMEOUT_SECONDS default.
        # If a future edit drops the kwarg, this catches it before the cron failure
        # recurs.
        for run_py in RUNNERS:
            with self.subTest(runner=str(run_py.relative_to(REPO_ROOT))):
                tree = ast.parse(run_py.read_text())
                calls = _safe_popen_calls(tree)
                self.assertEqual(
                    len(calls),
                    1,
                    f"{run_py.name} must have exactly one safe_popen call to run "
                    f"the lobster subprocess; found {len(calls)}. Per-rowan review "
                    "on PR #663: assert exactly one matching call so the test does "
                    "not pass vacuously.",
                )

                call = calls[0]
                kwargs = {kw.arg: kw.value for kw in call.keywords if kw.arg == "timeout"}
                self.assertIn(
                    "timeout",
                    kwargs,
                    f"{run_py.name} safe_popen call must pass timeout= explicitly. "
                    "See LOBSTER_SUBPROCESS_TIMEOUT_SECONDS comment for rationale.",
                )
                # The value passed must reference the constant, not a literal number,
                # so the timeout stays discoverable and testable.
                self.assertIsInstance(
                    kwargs["timeout"],
                    ast.Name,
                    f"{run_py.name} safe_popen timeout= must reference "
                    "LOBSTER_SUBPROCESS_TIMEOUT_SECONDS (not a literal) so the value "
                    "stays discoverable.",
                )
                self.assertEqual(kwargs["timeout"].id, "LOBSTER_SUBPROCESS_TIMEOUT_SECONDS")

    def test_no_runner_inherits_the_shared_default_for_its_lobster_call(self) -> None:
        # Catch-the-all guard: any runner that spawns the `lobster` CLI through
        # safe_popen must pin its own timeout. This is the check that would have
        # caught the original defect at all three call sites, rather than only the
        # two fixed here — a future runner added without a timeout fails this test.
        lobster_runners = {
            path: path.read_text()
            for path in (REPO_ROOT / "agents" / "workflows").rglob("run.py")
        }
        offenders: list[str] = []
        for path, source in sorted(lobster_runners.items()):
            if '"lobster"' not in source and "'lobster'" not in source:
                continue
            tree = ast.parse(source)
            for call in _safe_popen_calls(tree):
                kwargs = {kw.arg for kw in call.keywords}
                if "timeout" not in kwargs:
                    offenders.append(str(path.relative_to(REPO_ROOT)))
        self.assertEqual(
            offenders,
            [],
            "These runner(s) spawn the lobster CLI via safe_popen without an "
            "explicit timeout=, so they inherit the 25s "
            "DEFAULT_TIMEOUT_SECONDS and can die with subprocess.TimeoutExpired "
            "even on a successful lobster run. Pin "
            "timeout=LOBSTER_SUBPROCESS_TIMEOUT_SECONDS at each call site.",
        )


if __name__ == "__main__":
    unittest.main()
