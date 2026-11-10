"""Unit tests for the shared GitHub credential resolver in `agents/lib/github_cli.py`.

Covers the credential-resolution contract of task `a30b8fe6`:

- AC1 — `resolve_gh_credentials()` returns the credential source, the token to
  inject, the resolved login, and the reason when none is available.
- AC2 — the result is cached per process and the cache key includes a token
  fingerprint, so a rotated token is re-probed instead of inheriting a stale
  verdict.
- AC3 — a fallback credential whose resolved login is not the expected agent
  identity is refused (`source="none"`, reason `identity-mismatch`).
- AC6 — the cache is safe under the queue's threaded PR-hydration fan-out: the
  shipped path issues one probe per identity per process.
- AC7 — valid token, stale token with a valid keyring, stale token with a
  keyring owned by another login, no token with a valid keyring, and no token
  with no keyring.
"""

from __future__ import annotations

import os
import threading
import time
import unittest
from unittest import mock

from agents.lib import github_cli
from agents.lib.github_cli import resolve_gh_credentials


TOKEN_ENV = "ROWAN_TEST_GH_TOKEN"
CONFIG_DIR = "/tmp/gh-profile-credential-test"
EXPECTED_LOGIN = "rowanstoffer"
OTHER_LOGIN = "someone-else"


class _FakeResult:
    """Minimal stand-in for the object `safe_run` returns."""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _ScriptedProbe:
    """Scripted stand-in for the `gh api user` auth probe.

    The probe distinguishes the two candidates by the presence of
    `OPENCLAW_GH_TOKEN` in the environment the resolver builds: the env-token
    candidate carries the token, the keyring candidate does not.

    Every call is recorded so the tests can assert the probe count — the
    property AC6 turns on.
    """

    def __init__(
        self,
        *,
        token_login: str | None = None,
        keyring_login: str | None = None,
        token_error: str | None = None,
        keyring_error: str | None = None,
        delay: float = 0.0,
    ) -> None:
        self.token_login = token_login
        self.keyring_login = keyring_login
        self.token_error = token_error
        self.keyring_error = keyring_error
        self.delay = delay
        self.calls: list[str | None] = []
        self._lock = threading.Lock()

    def __call__(self, cmd, capture_output=False, text=False, env=None, timeout=None):
        env = env or {}
        token = env.get("OPENCLAW_GH_TOKEN")
        with self._lock:
            self.calls.append(token)
        if self.delay:
            time.sleep(self.delay)

        if token:
            if self.token_error:
                return _FakeResult(1, "", self.token_error)
            if self.token_login:
                return _FakeResult(0, f"{self.token_login}\n", "")
            return _FakeResult(1, "", "HTTP 401: Bad credentials")

        if self.keyring_error:
            return _FakeResult(1, "", self.keyring_error)
        if self.keyring_login:
            return _FakeResult(0, f"{self.keyring_login}\n", "")
        return _FakeResult(1, "", "HTTP 401: Bad credentials")


class ResolveGhCredentialsTest(unittest.TestCase):
    """AC1 / AC2 / AC3 / AC6 / AC7 coverage for the shared resolver."""

    def setUp(self) -> None:
        github_cli._reset_credential_cache_for_tests()
        os.environ.pop(TOKEN_ENV, None)
        self._patcher = mock.patch.object(github_cli, "safe_run")
        self.safe_run = self._patcher.start()
        self.addCleanup(self._patcher.stop)
        self.addCleanup(github_cli._reset_credential_cache_for_tests)
        self.addCleanup(os.environ.pop, TOKEN_ENV, None)

    def _resolve(self):
        return resolve_gh_credentials(
            config_dir=CONFIG_DIR,
            token_env=TOKEN_ENV,
            expected_login=EXPECTED_LOGIN,
        )

    # AC7 — valid token.

    def test_valid_token_resolves_the_env_token_source(self) -> None:
        """AC7: a valid env token is used and reported as `env-token`."""
        os.environ[TOKEN_ENV] = "ghp_validtokenvalue123456"
        probe = _ScriptedProbe(token_login=EXPECTED_LOGIN)
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "env-token")
        self.assertEqual(credentials.token, "ghp_validtokenvalue123456")
        self.assertEqual(credentials.login, EXPECTED_LOGIN)
        self.assertIsNone(credentials.reason)
        # The keyring is never probed when the env token authenticates.
        self.assertEqual(probe.calls, ["ghp_validtokenvalue123456"])

    # AC7 — stale token with a valid keyring.

    def test_stale_token_falls_back_to_a_valid_keyring(self) -> None:
        """AC7: a stale env token falls back to the keyring credential."""
        os.environ[TOKEN_ENV] = "ghp_staletokenvalue1234"
        probe = _ScriptedProbe(
            token_error="HTTP 401: Bad credentials",
            keyring_login=EXPECTED_LOGIN,
        )
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "keyring")
        self.assertIsNone(credentials.token)
        self.assertEqual(credentials.login, EXPECTED_LOGIN)
        self.assertEqual(credentials.reason, "stale-token-fallback")
        self.assertEqual(probe.calls, ["ghp_staletokenvalue1234", None])

    # AC7 + AC3 — stale token with a keyring owned by another login.

    def test_stale_token_with_a_keyring_owned_by_another_login_is_refused(self) -> None:
        """AC7 + AC3: another identity's keyring credential is refused."""
        os.environ[TOKEN_ENV] = "ghp_staletokenvalue1234"
        probe = _ScriptedProbe(
            token_error="HTTP 401: Bad credentials",
            keyring_login=OTHER_LOGIN,
        )
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "none")
        self.assertIsNone(credentials.token)
        self.assertEqual(credentials.login, OTHER_LOGIN)
        self.assertEqual(credentials.reason, "identity-mismatch")

    # AC7 — no token with a valid keyring.

    def test_no_token_uses_a_valid_keyring_credential(self) -> None:
        """AC7: with no env token, the keyring credential is used."""
        probe = _ScriptedProbe(keyring_login=EXPECTED_LOGIN)
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "keyring")
        self.assertIsNone(credentials.token)
        self.assertEqual(credentials.login, EXPECTED_LOGIN)
        self.assertIsNone(credentials.reason)
        self.assertEqual(probe.calls, [None])

    # AC7 — no token with no keyring.

    def test_no_token_and_no_keyring_reports_no_valid_credential(self) -> None:
        """AC7: with neither credential available, the reason is explicit."""
        probe = _ScriptedProbe()
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "none")
        self.assertIsNone(credentials.token)
        self.assertIsNone(credentials.login)
        self.assertEqual(credentials.reason, "no-valid-credential")

    # AC3 — the env token itself resolving to the wrong identity.

    def test_env_token_resolving_to_another_identity_is_refused(self) -> None:
        """AC3: a token whose login is not the expected identity is refused."""
        os.environ[TOKEN_ENV] = "ghp_otheridentitytoken12"
        probe = _ScriptedProbe(token_login=OTHER_LOGIN)
        self.safe_run.side_effect = probe

        credentials = self._resolve()

        self.assertEqual(credentials.source, "none")
        self.assertIsNone(credentials.token)
        self.assertEqual(credentials.login, OTHER_LOGIN)
        self.assertEqual(credentials.reason, "identity-mismatch")

    # AC2 — cache key includes the token fingerprint.

    def test_rotated_token_is_reprobed_rather_than_inheriting_a_stale_verdict(self) -> None:
        """AC2: a rotated token gets a new fingerprint, so it is re-probed."""
        os.environ[TOKEN_ENV] = "ghp_firsttokenvalue12345"
        probe = _ScriptedProbe(token_login=EXPECTED_LOGIN)
        self.safe_run.side_effect = probe

        first = self._resolve()
        self.assertEqual(first.source, "env-token")

        # The token rotates to a stale value. The cache key changes with the
        # fingerprint, so the resolver must probe again instead of returning
        # the previous "env-token" verdict.
        os.environ[TOKEN_ENV] = "ghp_rotatedtokenvalue1"
        probe.token_login = None
        probe.keyring_login = EXPECTED_LOGIN

        second = self._resolve()

        self.assertEqual(second.source, "keyring")
        self.assertEqual(second.reason, "stale-token-fallback")
        self.assertEqual(len(probe.calls), 3)

    def test_an_unchanged_token_is_probed_once_per_process(self) -> None:
        """AC2: the same credential is resolved from the cache, not re-probed."""
        os.environ[TOKEN_ENV] = "ghp_cachetesttokenvalue1"
        probe = _ScriptedProbe(token_login=EXPECTED_LOGIN)
        self.safe_run.side_effect = probe

        first = self._resolve()
        second = self._resolve()

        self.assertEqual(first, second)
        self.assertEqual(len(probe.calls), 1)

    # AC6 — threaded fan-out safety.

    def test_threaded_fan_out_issues_one_probe_per_identity(self) -> None:
        """AC6: concurrent resolves issue exactly one probe for the identity.

        The queue hydrates PRs across threads. A per-key lock with
        double-checked locking must collapse those concurrent resolves onto a
        single probe, otherwise the fan-out pays for one `gh api user` call
        per thread.
        """
        os.environ[TOKEN_ENV] = "ghp_threadedtokenvalue12"
        probe = _ScriptedProbe(token_login=EXPECTED_LOGIN, delay=0.02)
        self.safe_run.side_effect = probe

        results: list[object] = []
        errors: list[BaseException] = []
        barrier = threading.Barrier(8)

        def worker() -> None:
            try:
                barrier.wait(timeout=5)
                results.append(self._resolve())
            except BaseException as exc:  # noqa: BLE001 - recorded for assertion
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 8)
        self.assertEqual(len(probe.calls), 1)
        for credentials in results:
            self.assertEqual(credentials.source, "env-token")
            self.assertEqual(credentials.login, EXPECTED_LOGIN)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
