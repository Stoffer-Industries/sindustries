import importlib.util
import pathlib
import sys
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("capacity_transition", SCRIPTS / "capacity_transition.py")
capacity_transition = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(capacity_transition)


def content_task(task_id, attention_owners=None):
    return {
        "id": task_id,
        "assignee": "Ivy",
        "taskType": "content",
        "blocked": False,
        "dependencyBlocked": False,
        "attentionOwners": attention_owners or [],
    }


def test_capacity_ignores_assigned_tasks_actioned_by_other_top_owners():
    doing = [
        content_task("one", ["Quinn", "Tom"]),
        content_task("two", ["Ash", "Ivy"]),
    ]
    with patch.object(capacity_transition, "list_tasks", return_value=doing):
        allowed, failures = capacity_transition.check_capacity(content_task("current"), 1)
    assert allowed is True
    assert failures == []


def test_capacity_counts_task_when_assignee_is_repeated_top_owner():
    doing = [content_task("one", ["Ivy", "Ash", "Ivy", "Tom"])]
    with patch.object(capacity_transition, "list_tasks", return_value=doing):
        allowed, failures = capacity_transition.check_capacity(content_task("current"), 1)
    assert allowed is False
    assert "capacity limit is 1" in failures[0]
