"""Regression test for the feature-task runner's lobster subprocess timeout.

Background
----------
Cron 3c2fa067 (Task Lobsters) soft-failed on task 9b10c65a-0eb3-4ff2-92ca-d262e12c2e10
twice within 24h with `subprocess.TimeoutExpired` after 25.0s. The 25s bound is
`agents/lib/subprocess_safe.py:DEFAULT_TIMEOUT_SECONDS` (per d52c3ca, with 5s
margin below the heartbeat's 30s exec timeout).

Per-rowan review on PR #660: the shared default stays at 25s (heartbeat/interactive
callers rely on the 5s margin); the feature-task runner opts into a longer bound
explicitly via `LOBSTER_SUBPROCESS_TIMEOUT_SECONDS` because the W37 A3 main.rs
carve task genuinely needs more than 25s.

This test asserts the constant is set at the runner boundary so a future revert
to the default (or a typo) is caught before it ships.
"""

import ast
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUN_PY = REPO_ROOT / "agents" / "workflows" / "feature-task" / "run.py"


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


class LobsterTimeoutConstantTests(unittest.TestCase):
    def test_lobster_subprocess_timeout_constant_is_45_seconds(self) -> None:
        # The runner boundary must declare an explicit timeout above the 25s default.
        # 45s is the agreed value per rowan review (PR #660 review thread):
        # long enough for W37 A3 carve tasks (10+ PRs, large comment history),
        # short enough to keep fail-fast on genuinely stuck subprocesses.
        constants = _module_constants(RUN_PY)
        self.assertIn(
            "LOBSTER_SUBPROCESS_TIMEOUT_SECONDS",
            constants,
            f"{RUN_PY.name} must declare LOBSTER_SUBPROCESS_TIMEOUT_SECONDS "
            "explicitly so the W37 A3 carve tasks don't race the 25s default. "
            "Tracked in agents/lox/state/lox-incident-state.json slug "
            "`task-lobsters-cron-runner-termination-2026-09-13`.",
        )
        self.assertEqual(
            constants["LOBSTER_SUBPROCESS_TIMEOUT_SECONDS"],
            45.0,
            f"LOBSTER_SUBPROCESS_TIMEOUT_SECONDS must be 45.0s (per rowan review "
            "on PR #660); current value regresses the W37 A3 carve fix.",
        )

    def test_safe_popen_lobster_call_passes_explicit_timeout(self) -> None:
        # The safe_popen call must pass timeout= explicitly (not rely on the
        # DEFAULT_TIMEOUT_SECONDS default). If a future edit drops the kwarg, this
        # catches it before the cron failure recurs.
        tree = ast.parse(RUN_PY.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Name) and func.id == "safe_popen"):
                continue
            kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg == "timeout"}
            self.assertIn(
                "timeout",
                kwargs,
                "feature-task/run.py safe_popen call must pass timeout= explicitly. "
                "See LOBSTER_SUBPROCESS_TIMEOUT_SECONDS comment for rationale.",
            )
            # The value passed must reference the constant, not a literal number,
            # so the timeout stays discoverable and testable.
            self.assertIsInstance(
                kwargs["timeout"],
                ast.Name,
                "safe_popen timeout= must reference LOBSTER_SUBPROCESS_TIMEOUT_SECONDS "
                "(not a literal) so the value stays discoverable.",
            )
            self.assertEqual(kwargs["timeout"].id, "LOBSTER_SUBPROCESS_TIMEOUT_SECONDS")


if __name__ == "__main__":
    unittest.main()
