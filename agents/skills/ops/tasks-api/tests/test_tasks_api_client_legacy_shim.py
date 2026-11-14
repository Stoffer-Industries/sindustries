"""Contract tests for the deprecated scripts/ location of the Tasks API client.

The client moved to the skill root. Callers that still compose the old
``scripts/tasks_api_client.py`` path used to fail with an opaque
"No such file or directory" (exit 2). The shim must forward argv, stdout and
the exit code to the maintained client, and must say so on stderr.
"""
import os
import pathlib
import subprocess
import sys
import unittest

SKILL_ROOT = pathlib.Path(__file__).resolve().parents[1]
LEGACY = SKILL_ROOT / "scripts" / "tasks_api_client.py"
CANONICAL = SKILL_ROOT / "tasks_api_client.py"


def run(path: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(path), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


class LegacyPathShimTest(unittest.TestCase):
    def test_shim_exists_and_is_executable(self):
        self.assertTrue(LEGACY.is_file(), f"missing shim: {LEGACY}")
        self.assertTrue(os.access(LEGACY, os.X_OK), f"shim not executable: {LEGACY}")

    def test_canonical_client_is_at_the_skill_root(self):
        self.assertTrue(CANONICAL.is_file(), f"missing client: {CANONICAL}")

    def test_shim_forwards_stdout_to_the_canonical_client(self):
        legacy = run(LEGACY, "--help")
        canonical = run(CANONICAL, "--help")
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        self.assertEqual(canonical.returncode, 0, canonical.stderr)
        self.assertEqual(legacy.stdout, canonical.stdout)

    def test_shim_prints_a_deprecation_notice_on_stderr(self):
        result = run(LEGACY, "--help")
        self.assertIn("DEPRECATED", result.stderr)
        self.assertIn(str(CANONICAL), result.stderr)

    def test_shim_forwards_the_exit_code(self):
        # An unknown subcommand exits non-zero; the shim must not turn that
        # into success.
        legacy = run(LEGACY, "definitely-not-a-subcommand")
        canonical = run(CANONICAL, "definitely-not-a-subcommand")
        self.assertNotEqual(legacy.returncode, 0)
        self.assertEqual(legacy.returncode, canonical.returncode)

    def test_shim_does_not_mutate_state_on_a_read_only_call(self):
        before = CANONICAL.stat().st_mtime_ns
        result = run(LEGACY, "list", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(CANONICAL.stat().st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
