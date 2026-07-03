import importlib.util
import pathlib
import unittest
from unittest.mock import patch

# Task 2cee0bcd: patch --description now replaces (not appends) the task description.


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

    def test_patch_description_combined_with_other_fields(self):
        # AC3 (task 2cee0bcd): --description must coexist with --status and
        # --priority in a single PATCH. Closes the test gap where the existing
        # `test_patch_other_fields_unaffected_by_description` only exercises
        # status+priority WITHOUT --description, so the cross-field interaction
        # was implicitly trusted rather than asserted.
        parser = tasks_api_client.build_parser()
        args = parser.parse_args(
            [
                "patch",
                "--id",
                "task-1",
                "--description",
                "new text",
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
            {"description": "new text", "status": "doing", "priority": "high"},
        )

    # ---- create --spec / --workstreams helpers (task 8ec03996) ----

    def _build_create_args(self, **overrides):
        """Construct a Namespace mimicking `tasks_api_client.py create` argv."""
        from argparse import Namespace
        defaults = {
            "title": "T",
            "description": "Body.",
            "spec": None,
            "workstreams": None,
            "status": "open",
            "priority": "medium",
            "tags": [],
            "type": None,
        }
        defaults.update(overrides)
        ns = Namespace(**defaults)
        ns.func = tasks_api_client.cmd_create
        return ns

    def test_create_with_spec_prepends_spec_line(self):
        args = self._build_create_args(spec="brain/bookmarks/specs/foo.md")
        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch("builtins.print"):
            args.func(args)
        payload = api_request.call_args.args[3]
        self.assertTrue(
            payload["description"].startswith("**Spec:** brain/bookmarks/specs/foo.md\n\n"),
            f"description did not start with Spec line: {payload['description']!r}",
        )
        self.assertIn("Body.", payload["description"])

    def test_create_with_spec_does_not_double_prepend(self):
        args = self._build_create_args(
            spec="brain/bookmarks/specs/foo.md",
            description="**Spec:** brain/bookmarks/specs/foo.md\n\nBody.",
        )
        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ) as api_request, patch("builtins.print"):
            args.func(args)
        payload = api_request.call_args.args[3]
        # Description must contain the Spec line exactly once.
        self.assertEqual(payload["description"].count("**Spec:**"), 1)
        self.assertIn("Body.", payload["description"])

    def test_create_without_spec_warns_to_stderr(self):
        args = self._build_create_args()  # no spec, no Spec line in description
        import io
        captured_stderr = io.StringIO()
        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ), patch.object(
            tasks_api_client.sys, "stderr", captured_stderr
        ), patch("builtins.print"):
            args.func(args)
        self.assertIn("**Spec:**", captured_stderr.getvalue())
        self.assertIn("lobster will block", captured_stderr.getvalue())

    def test_create_without_spec_no_warning_when_present(self):
        args = self._build_create_args(
            description="**Spec:** brain/bookmarks/specs/foo.md\n\nBody."
        )
        import io
        captured_stderr = io.StringIO()
        with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
            tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
        ), patch.object(
            tasks_api_client.sys, "stderr", captured_stderr
        ), patch("builtins.print"):
            args.func(args)
        self.assertNotIn("**Spec:**", captured_stderr.getvalue())

    def test_create_with_workstreams_appends_section(self, tmp_workstreams=None):
        import tempfile
        import os
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".yaml") as f:
            f.write("- Owner: Rowan\n  Scope: Build it\n")
            ws_path = f.name
        try:
            args = self._build_create_args(workstreams=ws_path)
            with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
                tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
            ) as api_request, patch("builtins.print"):
                args.func(args)
            payload = api_request.call_args.args[3]
            self.assertIn("**Workstreams**", payload["description"])
            self.assertIn("- Owner: Rowan", payload["description"])
            self.assertIn("Scope: Build it", payload["description"])
        finally:
            os.unlink(ws_path)

    def test_create_with_workstreams_idempotent(self):
        import tempfile
        import os
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".yaml") as f:
            f.write("- Owner: Rowan\n")
            ws_path = f.name
        try:
            args = self._build_create_args(
                description="Body.\n\n**Workstreams**\n\n- Owner: Quinn",
                workstreams=ws_path,
            )
            with patch.object(tasks_api_client, "get_base_url", return_value="http://tasks.test/api/v1"), patch.object(
                tasks_api_client, "api_request", return_value={"data": {"id": "task-1"}}
            ) as api_request, patch("builtins.print"):
                args.func(args)
            payload = api_request.call_args.args[3]
            # Workstreams section must appear exactly once.
            self.assertEqual(payload["description"].count("**Workstreams**"), 1)
            self.assertEqual(payload["description"].count("- Owner:"), 1)
        finally:
            os.unlink(ws_path)


if __name__ == "__main__":
    unittest.main()


