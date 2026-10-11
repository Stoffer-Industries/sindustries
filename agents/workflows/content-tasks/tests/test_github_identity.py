from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402


def test_content_task_github_env_selects_ivy_and_removes_ambient_tokens():
    with patch.dict(
        os.environ,
        {
            "CONTENT_TASKS_GH_CONFIG_DIR": "/tmp/gh-ivy-test",
            "GH_CONFIG_DIR": "/tmp/gh-tom",
            "GH_TOKEN": "wrong-account",
            "GITHUB_TOKEN": "wrong-account",
        },
        clear=False,
    ):
        env = common.github_cli_env()

    assert env["GH_CONFIG_DIR"] == "/tmp/gh-ivy-test"
    assert "GH_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env


def test_content_task_github_env_strips_secret_egress_proxy():
    # `gh` is a Go binary; on macOS it does not honour SSL_CERT_FILE/
    # CURL_CA_BUNDLE/NODE_EXTRA_CA_CERTS. The ambient HTTP_PROXY/HTTPS_PROXY
    # route every outbound call through OpenClaw's local secret-egress
    # proxy, whose TLS certificate `gh` correctly refuses to trust -- an
    # identical x509 failure across every `gh`-invoking code path
    # (feature-task lobster, Tasks-API queue script) found 2026-10-11.
    with patch.dict(
        os.environ,
        {
            "CONTENT_TASKS_GH_CONFIG_DIR": "/tmp/gh-ivy-test",
            "HTTP_PROXY": "http://openclaw:***@127.0.0.1:64554",
            "HTTPS_PROXY": "http://openclaw:***@127.0.0.1:64554",
            "http_proxy": "http://openclaw:***@127.0.0.1:64554",
            "https_proxy": "http://openclaw:***@127.0.0.1:64554",
        },
        clear=False,
    ):
        env = common.github_cli_env()

    for proxy_var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        assert proxy_var not in env
