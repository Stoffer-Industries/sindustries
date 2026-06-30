import importlib.util
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "tasks_api_client.py"
SPEC = importlib.util.spec_from_file_location("tasks_api_client", MODULE_PATH)
tasks_api_client = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tasks_api_client)


class TasksApiClientPatchTest(unittest.TestCase):
    def test_patch_depends_on_maps_to_depends_on_ids(self):
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(
            [
                "patch",
                "--id",
                "task-1",
                "--depends-on",
                "dep-1",
                "dep-2",
            ]
        )

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch("builtins.print"):
            args.func(args)

        api_request.assert_called_once_with(
            "PATCH",
            "http://tasks.test/api/v1",
            "/tasks/task-1",
            {"dependsOnIds": ["dep-1", "dep-2"]},
        )

    def test_patch_clear_dependencies_maps_to_empty_depends_on_ids(self):
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(["patch", "--id", "task-1", "--clear-dependencies"])

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch("builtins.print"):
            args.func(args)

        api_request.assert_called_once_with(
            "PATCH",
            "http://tasks.test/api/v1",
            "/tasks/task-1",
            {"dependsOnIds": []},
        )

    def test_patch_rejects_depends_on_with_clear_dependencies(self):
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(
            ["patch", "--id", "task-1", "--depends-on", "dep-1", "--clear-dependencies"]
        )

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"):
            with self.assertRaises(SystemExit):
                args.func(args)

    # ---- patch --description replaces (task 2cee0bcd) ----

    def test_patch_description_replaces_existing(self):
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(
            ["patch", "--id", "task-1", "--description", "new text"]
        )

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch.object(
            tasks_api_client, "get_task"
        ) as get_task, patch("builtins.print"):
            args.func(args)

        api_request.assert_called_once_with(
            "PATCH",
            "http://tasks.test/api/v1",
            "/tasks/task-1",
            {"description": "new text"},
        )
        get_task.assert_not_called()

    def test_patch_description_called_twice_stores_only_second(self):
        parser = tasks_api_client.build_parser()
        captured_payloads = []

        def fake_api_request(method, base, path, payload):
            captured_payloads.append(payload)
            return {"data": {"id": "task-1", "description": payload.get("description")}}

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", side_effect=fake_api_request
        ), patch("builtins.print"):
            args1 = parser.parse_args(
                ["patch", "--id", "task-1", "--description", "first"]
            )
            args1.func(args1)
            args2 = parser.parse_args(
                ["patch", "--id", "task-1", "--description", "second"]
            )
            args2.func(args2)

        self.assertEqual(captured_payloads[0], {"description": "first"})
        self.assertEqual(captured_payloads[1], {"description": "second"})
        self.assertNotIn("first", captured_payloads[1]["description"])

    def test_patch_other_fields_unaffected_by_description(self):
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(
            [
                "patch",
                "--id",
                "task-1",
                "--status",
                "doing",
                "--priority",
                "high",
            ]
        )

        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch("builtins.print"):
            args.func(args)

        api_request.assert_called_once_with(
            "PATCH",
            "http://tasks.test/api/v1",
            "/tasks/task-1",
            {"status": "doing", "priority": "high"},
        )


if __name__ == "__main__":
    unittest.main()

