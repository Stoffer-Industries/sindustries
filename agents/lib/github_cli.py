"""Shared command/env construction for repository-owned GitHub CLI callers."""

from __future__ import annotations

import os
from pathlib import Path


_WRAPPER = Path(__file__).with_name("github-cli.sh")


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
