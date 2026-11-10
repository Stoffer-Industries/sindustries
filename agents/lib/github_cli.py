"""Shared command/env construction and credential resolution for GitHub CLI callers."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from typing import Final

from agents.lib.subprocess_safe import safe_run


_WRAPPER = Path(__file__).with_name("github-cli.sh")
_PROBE_TIMEOUT_SECONDS: Final = 5.0
_TOKEN_REDACTION_RE = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})"
)

CredentialSource = str
CredentialCacheKey = tuple[str, str, str, str]


@dataclass(frozen=True)
class GhCredentials:
    """Resolved GitHub credential selected for one repository-owned caller.

    ``source`` is ``env-token``, ``keyring``, or ``none``. ``token`` is the
    value the caller must inject into the shared wrapper; ``None`` means the
    wrapper should use the credential at ``GH_CONFIG_DIR``. ``login`` is the
    login GitHub reported for the selected credential, when one was resolved.
    ``reason`` explains a fallback or why no credential is available.
    """

    source: CredentialSource
    token: str | None
    login: str | None
    reason: str | None


# Process-local credential resolutions. The key includes a token fingerprint so
# a rotated token is probed again instead of inheriting the old verdict.
_CREDENTIAL_CACHE: dict[CredentialCacheKey, GhCredentials] = {}
_CREDENTIAL_LOCKS: dict[CredentialCacheKey, threading.Lock] = {}
_CREDENTIAL_CACHE_LOCK = threading.Lock()


def gh_command(*args: str) -> list[str]:
    """Return a command that applies the shared GitHub CLI environment policy."""
    return [str(_WRAPPER), *args]


def gh_env(*, config_dir: str | None = None, token: str | None = None) -> dict[str, str]:
    """Prepare caller configuration for ``github-cli.sh``.

    The wrapper owns the security-sensitive cleanup (ambient credentials and
    proxy variables). This helper only passes the caller's selected profile
    and, when explicitly supplied, a token for the wrapper to expose as
    ``GH_TOKEN``.
    """
    env = os.environ.copy()
    if config_dir:
        env["GH_CONFIG_DIR"] = str(Path(config_dir).expanduser())
    # Keep ambient credentials out of the wrapper's input as well as its
    # final child environment. The wrapper remains the authoritative policy
    # boundary for all callers, including Rust and shell callers.
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    if token:
        env["OPENCLAW_GH_TOKEN"] = token
    else:
        env.pop("OPENCLAW_GH_TOKEN", None)
    return env


def _warn(message: str) -> None:
    """Print one operator-facing credential warning to stderr."""
    print(f"[github_cli] WARN: {message}", file=sys.stderr, flush=True)


def _redact(value: str, *, token: str | None = None) -> str:
    """Remove the exact token and token-shaped substrings from a diagnostic."""
    redacted = value or ""
    if token:
        redacted = redacted.replace(token, "***")
    return _TOKEN_REDACTION_RE.sub("***", redacted).strip()


def _token_fingerprint(token: str | None) -> str:
    """Return a stable, non-secret fingerprint for a process credential."""
    if not token:
        return "none"
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _credential_cache_key(
    config_dir: str,
    token_env: str,
    expected_login: str,
    token: str | None,
) -> CredentialCacheKey:
    """Build the cache key for one credential resolution."""
    return (
        str(Path(config_dir).expanduser()),
        token_env,
        expected_login.casefold(),
        _token_fingerprint(token),
    )


def _lock_for_key(key: CredentialCacheKey) -> threading.Lock:
    """Return the stable per-key lock used for double-checked caching."""
    with _CREDENTIAL_CACHE_LOCK:
        return _CREDENTIAL_LOCKS.setdefault(key, threading.Lock())


@dataclass(frozen=True)
class _ProbeResult:
    login: str | None
    failure: str | None
    detail: str


def _probe_login(
    config_dir: str,
    token: str | None,
    *,
    timeout_seconds: float = _PROBE_TIMEOUT_SECONDS,
) -> _ProbeResult:
    """Resolve the active GitHub login for one candidate credential.

    The probe always enters through ``github-cli.sh`` so ambient credentials
    cannot make a keyring-only check succeed for the wrong identity.
    """
    env = gh_env(config_dir=config_dir, token=token)
    try:
        result = safe_run(
            gh_command("api", "user", "--jq", ".login"),
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        return _ProbeResult(None, "probe-error", f"TimeoutExpired: {exc}")
    except subprocess.CalledProcessError as exc:
        # `safe_run` only raises this with check=True, but a caller-supplied
        # runner may raise it for a non-zero exit. Either way the probe's
        # verdict is "this credential does not authenticate" — it must not
        # escape the resolver and abort the caller's queue run.
        return _ProbeResult(None, "probe-error", f"CalledProcessError: {exc}")
    except OSError as exc:
        return _ProbeResult(None, "probe-error", f"{type(exc).__name__}: {exc}")

    if result.returncode == 0:
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        if lines:
            return _ProbeResult(lines[0], None, "")
        return _ProbeResult(None, "probe-error", "probe returned no login")

    stderr_lines = [line.strip() for line in (result.stderr or "").splitlines() if line.strip()]
    stdout_lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    detail = stderr_lines[0] if stderr_lines else (stdout_lines[0] if stdout_lines else "")
    lowered = detail.casefold()
    failure = "stale-token" if ("401" in lowered or "bad credentials" in lowered) else "probe-error"
    return _ProbeResult(None, failure, detail)


def _identity_mismatch(actual_login: str | None, expected_login: str) -> bool:
    """True when a resolved login is not the expected agent identity."""
    if not actual_login or not expected_login:
        return False
    return actual_login.casefold() != expected_login.casefold()


def _resolve_credentials_uncached(
    config_dir: str,
    token_env: str,
    expected_login: str,
    token: str | None,
) -> GhCredentials:
    """Resolve one credential without consulting or updating the cache."""
    token_failure: str | None = None
    if token:
        token_probe = _probe_login(config_dir, token)
        if token_probe.login:
            if _identity_mismatch(token_probe.login, expected_login):
                _warn(
                    f"{token_env} resolved GitHub login {token_probe.login!r}, expected "
                    f"{expected_login!r}; refusing to use the credential"
                )
                return GhCredentials("none", None, token_probe.login, "identity-mismatch")
            return GhCredentials("env-token", token, token_probe.login, None)
        token_failure = token_probe.failure or "probe-error"
        detail = _redact(token_probe.detail, token=token)
        _warn(
            f"{token_env} env token failed the gh auth probe "
            f"({detail or 'no detail'}); falling back to the "
            f"GH_CONFIG_DIR={config_dir} keyring credential"
        )

    keyring_probe = _probe_login(config_dir, None)
    if keyring_probe.login:
        if _identity_mismatch(keyring_probe.login, expected_login):
            _warn(
                f"GH_CONFIG_DIR={config_dir} resolved GitHub login "
                f"{keyring_probe.login!r}, expected {expected_login!r}; refusing "
                f"to use another identity's credential"
            )
            return GhCredentials("none", None, keyring_probe.login, "identity-mismatch")
        reason = None
        if token_failure == "stale-token":
            reason = "stale-token-fallback"
        elif token_failure == "probe-error":
            reason = "probe-error"
        return GhCredentials("keyring", None, keyring_probe.login, reason)

    if keyring_probe.failure == "probe-error":
        reason = "probe-error"
    else:
        reason = "no-valid-credential"
    detail = _redact(keyring_probe.detail)
    _warn(
        f"GH_CONFIG_DIR={config_dir} keyring credential failed the gh auth probe "
        f"({detail or 'no detail'})"
    )
    return GhCredentials("none", None, None, reason)


def resolve_gh_credentials(
    *,
    config_dir: str,
    token_env: str,
    expected_login: str,
) -> GhCredentials:
    """Resolve the GitHub credential for one identity, once per process.

    The result is cached under a key that includes the token fingerprint, so a
    rotated token is re-probed. A per-key lock with double-checked locking
    keeps the threaded PR-hydration fan-out from issuing duplicate probes.
    """
    token = os.environ.get(token_env)
    key = _credential_cache_key(config_dir, token_env, expected_login, token)
    with _CREDENTIAL_CACHE_LOCK:
        cached = _CREDENTIAL_CACHE.get(key)
    if cached is not None:
        return cached

    lock = _lock_for_key(key)
    with lock:
        with _CREDENTIAL_CACHE_LOCK:
            cached = _CREDENTIAL_CACHE.get(key)
        if cached is not None:
            return cached

        resolved = _resolve_credentials_uncached(
            config_dir,
            token_env,
            expected_login,
            token,
        )
        with _CREDENTIAL_CACHE_LOCK:
            _CREDENTIAL_CACHE[key] = resolved
        return resolved


def _reset_credential_cache_for_tests() -> None:
    """Clear credential cache state for deterministic unit tests."""
    with _CREDENTIAL_CACHE_LOCK:
        _CREDENTIAL_CACHE.clear()
        _CREDENTIAL_LOCKS.clear()


__all__ = [
    "GhCredentials",
    "gh_command",
    "gh_env",
    "resolve_gh_credentials",
]
