#!/usr/bin/env python3
"""Unit tests for agents/cron/bookmark-triage-report.py (AC5 of 536e04fc).

Covers:
  - select_stale_untyped: filters by status, taskType null/empty, and age
  - format_report: empty + populated cases
  - run: dry-run skips delivery, real delivery fires _send, no-stale path is
    silent, missing chat_id / bot_token when stale exist fails loud
  - main: --json output shape, --dry-run echoes message, exit codes

Loads the hyphenated script via importlib so we don't have to rename the file.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "agents" / "cron" / "bookmark-triage-report.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bookmark_triage_report", str(SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


btr = _load_module()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _task(
    *,
    task_id: str,
    status: str,
    task_type,
    created_at: datetime,
    title: str = "T",
    description: str = "",
    tags: list[str] | None = None,
) -> dict:
    return {
        "id": task_id,
        "title": title,
        "description": description,
        "status": status,
        "taskType": task_type,
        "createdAt": _iso(created_at),
        "tags": list(tags) if tags is not None else [
            "source:bookmark-review-pipeline",
            f"bookmark:{task_id}",
        ],
    }


NOW = datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc)
EIGHT_DAYS_AGO = NOW - timedelta(days=8)
SIX_DAYS_AGO = NOW - timedelta(days=6)
ONE_DAY_AGO = NOW - timedelta(days=1)


class SelectStaleUntypedTests(unittest.TestCase):
    def test_filters_out_typed_tasks(self):
        tasks = [
            _task(task_id="a", status="open", task_type="code", created_at=EIGHT_DAYS_AGO),
            _task(task_id="b", status="open", task_type="feature", created_at=EIGHT_DAYS_AGO),
            _task(task_id="c", status="open", task_type="research", created_at=EIGHT_DAYS_AGO),
        ]
        stale = btr.select_stale_untyped(tasks, now=NOW)
        self.assertEqual(stale, [])

    def test_filters_out_recent_untyped(self):
        tasks = [
            _task(task_id="a", status="open", task_type=None, created_at=ONE_DAY_AGO),
        ]
        self.assertEqual(btr.select_stale_untyped(tasks, now=NOW), [])

    def test_filters_out_non_open_status(self):
        tasks = [
            _task(task_id="a", status="doing", task_type=None, created_at=EIGHT_DAYS_AGO),
            _task(task_id="b", status="ready", task_type=None, created_at=EIGHT_DAYS_AGO),
            _task(task_id="c", status="done", task_type=None, created_at=EIGHT_DAYS_AGO),
            _task(task_id="d", status="acceptance", task_type=None, created_at=EIGHT_DAYS_AGO),
        ]
        self.assertEqual(btr.select_stale_untyped(tasks, now=NOW), [])

    def test_keeps_open_untyped_older_than_threshold(self):
        tasks = [
            _task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO),
        ]
        stale = btr.select_stale_untyped(tasks, now=NOW)
        self.assertEqual([t["id"] for t in stale], ["a"])

    def test_keeps_open_untyped_with_empty_string_task_type(self):
        # The Tasks API serialises a never-set type as None today, but an empty
        # string would have the same meaning. Defensive against schema drift.
        tasks = [
            _task(task_id="a", status="open", task_type="", created_at=EIGHT_DAYS_AGO),
        ]
        stale = btr.select_stale_untyped(tasks, now=NOW)
        self.assertEqual([t["id"] for t in stale], ["a"])

    def test_excludes_tasks_without_parseable_created_at(self):
        tasks = [
            {"id": "a", "status": "open", "taskType": None, "createdAt": "not-a-date"},
            {"id": "b", "status": "open", "taskType": None},
        ]
        self.assertEqual(btr.select_stale_untyped(tasks, now=NOW), [])

    def test_custom_stale_after_days(self):
        # With stale_after_days=5, an 8-day-old task qualifies AND a 6-day-old
        # task also qualifies; a 1-day-old task does not.
        tasks = [
            _task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO),
            _task(task_id="b", status="open", task_type=None, created_at=SIX_DAYS_AGO),
            _task(task_id="c", status="open", task_type=None, created_at=ONE_DAY_AGO),
        ]
        stale = btr.select_stale_untyped(tasks, now=NOW, stale_after_days=5)
        self.assertEqual([t["id"] for t in stale], ["a", "b"])

    def test_results_sorted_oldest_first(self):
        tasks = [
            _task(task_id="newer", status="open", task_type=None, created_at=EIGHT_DAYS_AGO),
            _task(task_id="older", status="open", task_type=None, created_at=NOW - timedelta(days=20)),
        ]
        stale = btr.select_stale_untyped(tasks, now=NOW)
        self.assertEqual([t["id"] for t in stale], ["older", "newer"])

    def test_empty_input(self):
        self.assertEqual(btr.select_stale_untyped([], now=NOW), [])

    def test_excludes_tasks_without_bookmark_origin_tag(self):
        # The API-side tag filter is an exact match, but a payload that carries
        # tags and none of the bookmark markers is not a bookmark-origin task.
        tasks = [
            _task(
                task_id="a",
                status="open",
                task_type=None,
                created_at=EIGHT_DAYS_AGO,
                tags=["topic:brain", "spec-task:xyz"],
            ),
        ]
        self.assertEqual(btr.select_stale_untyped(tasks, now=NOW), [])

    def test_keeps_tasks_tagged_with_bookmark_id_marker(self):
        tasks = [
            _task(
                task_id="a",
                status="open",
                task_type=None,
                created_at=EIGHT_DAYS_AGO,
                tags=["bookmark:abc123"],
            ),
        ]
        self.assertEqual([t["id"] for t in btr.select_stale_untyped(tasks, now=NOW)], ["a"])

    def test_keeps_tasks_without_any_tag_information(self):
        # No tags at all → not filtered out (defensive against payload drift).
        task = _task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)
        task["tags"] = []
        self.assertEqual([t["id"] for t in btr.select_stale_untyped([task], now=NOW)], ["a"])


class TagAndProxyDefaultsTests(unittest.TestCase):
    def test_default_tag_is_the_pipeline_source_tag(self):
        # `tag=bookmarks` matched nothing — the Tasks API tag filter is an
        # exact match and the pipeline stamps `source:bookmark-review-pipeline`.
        self.assertEqual(btr.DEFAULT_TAG, "source:bookmark-review-pipeline")

    def test_direct_opener_does_not_use_environment_proxies(self):
        with patch.object(
            btr.urllib.request, "build_opener", wraps=btr.urllib.request.build_opener
        ) as build_opener:
            btr._direct_opener()
        proxy_handlers = [
            c for c in build_opener.call_args[0]
            if isinstance(c, btr.urllib.request.ProxyHandler)
        ]
        self.assertTrue(proxy_handlers, "expected an explicit ProxyHandler")
        for handler in proxy_handlers:
            self.assertEqual(handler.proxies, {})


class FormatReportTests(unittest.TestCase):
    def test_empty_report(self):
        msg = btr.format_report([], now=NOW, stale_after_days=7)
        self.assertIn("0 untyped", msg)
        self.assertIn("No action needed", msg)

    def test_populated_report_includes_ids_ages_and_snippet(self):
        tasks = [
            _task(
                task_id="abc-123",
                status="open",
                task_type=None,
                created_at=EIGHT_DAYS_AGO,
                title="Triage stale bookmark fix",
                description="Fix untyped bookmark tasks that have been sitting in open for over a week without being classified",
            ),
        ]
        msg = btr.format_report(tasks, now=NOW, stale_after_days=7)
        self.assertIn("1 untyped", msg)
        self.assertIn("older than 7 days", msg)
        self.assertIn("Triage stale bookmark fix", msg)
        self.assertIn("age 8d", msg)
        self.assertIn("abc-123", msg)
        self.assertIn("Action:", msg)

    def test_snippet_truncates_long_descriptions(self):
        long_desc = "x" * 500
        tasks = [
            _task(
                task_id="abc-123",
                status="open",
                task_type=None,
                created_at=EIGHT_DAYS_AGO,
                title="Long",
                description=long_desc,
            ),
        ]
        msg = btr.format_report(tasks, now=NOW)
        # Snippet is truncated to ~120 chars + ellipsis. The body should
        # contain the ellipsis marker.
        self.assertIn("…", msg)
        # And the 500-char body should NOT appear verbatim.
        self.assertNotIn(long_desc, msg)


class RunTests(unittest.TestCase):
    def test_dry_run_skips_delivery_when_stale_present(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

        send_calls = []

        def fake_send(message, **kwargs):
            send_calls.append((message, kwargs))
            return {"ok": True, "result": {"message_id": 1}}

        result = btr.run(
            dry_run=True,
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 1)
        self.assertEqual(send_calls, [])
        self.assertTrue(result["dryRun"])
        self.assertFalse(result["delivered"])
        self.assertIsNone(result["deliveryError"])

    def test_real_delivery_fires_send_when_stale_present(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

        send_calls = []

        def fake_send(message, **kwargs):
            send_calls.append((message, kwargs))
            return {"ok": True, "result": {"message_id": 42}}

        result = btr.run(
            chat_id="12345",
            bot_token="tok",
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 1)
        self.assertTrue(result["delivered"])
        self.assertEqual(len(send_calls), 1)
        self.assertEqual(send_calls[0][1], {"chat_id": "12345", "bot_token": "tok"})

    def test_no_delivery_when_nothing_stale(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type="code", created_at=EIGHT_DAYS_AGO)]

        send_calls = []

        def fake_send(message, **kwargs):
            send_calls.append((message, kwargs))
            return {"ok": True}

        result = btr.run(
            chat_id="12345",
            bot_token="tok",
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 0)
        self.assertFalse(result["delivered"])
        self.assertEqual(send_calls, [])

    def test_missing_chat_id_when_stale_exists_reports_error(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

        send_calls = []

        def fake_send(message, **kwargs):
            send_calls.append((message, kwargs))
            return {"ok": True}

        result = btr.run(
            chat_id="",
            bot_token="tok",
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 1)
        self.assertFalse(result["delivered"])
        self.assertIn("BOOKMARK_TRIAGE_CHAT_ID", result["deliveryError"])
        self.assertEqual(send_calls, [])

    def test_missing_bot_token_when_stale_exists_reports_error(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

        send_calls = []

        def fake_send(message, **kwargs):
            send_calls.append((message, kwargs))
            return {"ok": True}

        result = btr.run(
            chat_id="12345",
            bot_token="",
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 1)
        self.assertFalse(result["delivered"])
        self.assertIn("TELEGRAM_BOT_TOKEN", result["deliveryError"])
        self.assertEqual(send_calls, [])

    def test_send_failure_surfaces_in_delivery_error(self):
        def fake_fetch(**_):
            return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

        def fake_send(message, **kwargs):
            raise RuntimeError("telegram api http 401: unauthorised")

        result = btr.run(
            chat_id="12345",
            bot_token="tok",
            now=NOW,
            _fetch=fake_fetch,
            _send=fake_send,
        )
        self.assertEqual(result["staleCount"], 1)
        self.assertFalse(result["delivered"])
        self.assertIn("http 401", result["deliveryError"])


class MainCliTests(unittest.TestCase):
    def _run_main(self, argv):
        buf_out, buf_err = io.StringIO(), io.StringIO()
        with redirect_stdout(buf_out), redirect_stderr(buf_err):
            rc = btr.main(argv)
        return rc, buf_out.getvalue(), buf_err.getvalue()

    def test_json_mode_emits_structured_report(self):
        # No TASKS_API_BASE_URL → the validator raises SystemExit → main
        # prints the message to stderr and returns 2. So set the env first.
        env = {
            "TASKS_API_BASE_URL": "http://example.test/api/v1",
            "TASKS_API_APPROVAL_TOKEN": "tok",
        }
        with patch.dict(os.environ, env, clear=False):
            def fake_fetch(**_):
                return []

            with patch.object(btr, "fetch_bookmark_tasks", side_effect=fake_fetch):
                rc, out, err = self._run_main(["--json", "--dry-run"])
        self.assertEqual(rc, 0, msg=err)
        payload = json.loads(out)
        self.assertEqual(payload["staleCount"], 0)
        self.assertTrue(payload["dryRun"])

    def test_dry_run_prints_message(self):
        env = {
            "TASKS_API_BASE_URL": "http://example.test/api/v1",
            "TASKS_API_APPROVAL_TOKEN": "tok",
        }
        with patch.dict(os.environ, env, clear=False):
            def fake_fetch(**_):
                return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

            with patch.object(btr, "fetch_bookmark_tasks", side_effect=fake_fetch):
                rc, out, err = self._run_main(["--dry-run"])
        self.assertEqual(rc, 0, msg=err)
        self.assertIn("1 untyped", out)
        self.assertIn("Action:", out)

    def test_missing_api_base_returns_2(self):
        env = {k: v for k, v in os.environ.items() if k != "TASKS_API_BASE_URL"}
        with patch.dict(os.environ, env, clear=True):
            rc, out, err = self._run_main(["--dry-run"])
        self.assertEqual(rc, 2)
        self.assertIn("TASKS_API_BASE_URL", err)

    def test_delivery_failure_returns_1(self):
        env = {
            "TASKS_API_BASE_URL": "http://example.test/api/v1",
            "TASKS_API_APPROVAL_TOKEN": "tok",
            "BOOKMARK_TRIAGE_CHAT_ID": "12345",
            "TELEGRAM_BOT_TOKEN": "tok",
        }
        with patch.dict(os.environ, env, clear=False):
            def fake_fetch(**_):
                return [_task(task_id="a", status="open", task_type=None, created_at=EIGHT_DAYS_AGO)]

            def fake_send(message, **kwargs):
                raise RuntimeError("boom")

            with patch.object(btr, "fetch_bookmark_tasks", side_effect=fake_fetch), \
                 patch.object(btr, "send_telegram", side_effect=fake_send):
                rc, out, err = self._run_main(["--json"])
        self.assertEqual(rc, 1, msg=err)
        self.assertIn("boom", err)
        payload = json.loads(out)
        self.assertFalse(payload["delivered"])
        self.assertEqual(payload["deliveryError"], "boom")


class SendTelegramContractTests(unittest.TestCase):
    """Hit the live Telegram HTTP endpoint with httpretty-style patching so we
    confirm the request body shape and the ok-response path."""

    def test_send_telegram_posts_expected_payload(self):
        captured = {}

        class _FakeResp:
            def __init__(self, payload):
                self._payload = payload

            def read(self):
                return json.dumps(self._payload).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        def fake_urlopen(req, timeout=20):
            captured["url"] = req.full_url
            captured["data"] = json.loads(req.data.decode("utf-8"))
            captured["timeout"] = timeout
            return _FakeResp({"ok": True, "result": {"message_id": 7}})

        class _FakeOpener:
            def open(self, req, timeout=20):
                return fake_urlopen(req, timeout=timeout)

        with patch.object(btr, "_direct_opener", return_value=_FakeOpener()):
            result = btr.send_telegram("hello", chat_id="42", bot_token="abc")

        self.assertIn("/botabc/sendMessage", captured["url"])
        self.assertEqual(captured["data"], {"chat_id": "42", "text": "hello"})
        self.assertEqual(result["result"]["message_id"], 7)

    def test_send_telegram_raises_on_api_not_ok(self):
        class _FakeResp:
            def read(self):
                return json.dumps({"ok": False, "description": "bad chat"}).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        class _FakeOpener:
            def open(self, req, timeout=20):
                return _FakeResp()

        with patch.object(btr, "_direct_opener", return_value=_FakeOpener()):
            with self.assertRaises(RuntimeError) as ctx:
                btr.send_telegram("hello", chat_id="42", bot_token="abc")
        self.assertIn("not-ok", str(ctx.exception))

    def test_send_telegram_requires_token(self):
        with self.assertRaises(RuntimeError):
            btr.send_telegram("hello", chat_id="42", bot_token="")

    def test_send_telegram_requires_chat_id(self):
        with self.assertRaises(RuntimeError):
            btr.send_telegram("hello", chat_id="", bot_token="abc")


if __name__ == "__main__":
    unittest.main()
