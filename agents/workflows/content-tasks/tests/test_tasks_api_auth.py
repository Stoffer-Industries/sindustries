from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402


def test_content_mutations_use_shared_tasks_api_credential_resolver():
    # The content workflow must not pin a content-only credential. The shared
    # resolver selects the current agent's Tasks API token and preserves the
    # authenticated actor on comments and mutations.
    with patch.object(common, "api_request", return_value={}) as api_request:
        common.patch_task("task-1", {"status": "ready"}, base_url="http://tasks.test/api/v1")
        common.add_comment("task-1", "workflow advanced", base_url="http://tasks.test/api/v1")

    assert api_request.call_args_list[0].kwargs == {}
    assert api_request.call_args_list[1].kwargs == {}
