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
