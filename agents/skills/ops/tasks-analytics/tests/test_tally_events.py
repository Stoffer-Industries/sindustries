"""Tests for the bounded analytics pagination contract in `tally_events.py`.

Task 75032fad: the per-task analytics events endpoint is bounded, so
`tally_events.py` has to follow `pagination.nextCursor` and concatenate the
pages. These tests pin three properties:

  1. a multi-page server yields the same tally as a single-page server with
     the same events (no silent truncation),
  2. a pre-pagination server (no `pagination` object) still works,
  3. a broken pagination envelope fails loudly instead of looping forever
     or reporting a partial tally.
"""

import contextlib
import datetime
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

SPEC = importlib.util.spec_from_file_location(
    "tally_events", SCRIPTS_DIR / "tally_events.py"
)
tally_events = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tally_events)

TASK_ID = "task-1"


def _event(gate, cause, message, minutes_ago=0):
    occurred = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        minutes=minutes_ago
    )
    return {
        "eventType": "gate_failure",
        "gate": gate,
        "cause": cause,
        "message": message,
        "occurredAt": occurred.isoformat().replace("+00:00", "Z"),
    }


def _page(events, has_more=False, next_cursor=None):
    return {
        "data": events,
        "pagination": {
            "limit": 500,
            "returned": len(events),
            "hasMore": has_more,
            "nextCursor": next_cursor,
        },
    }


class PagedEventsFetcher:
    """Fake `fetch` that serves a canned list of responses per path."""

    def __init__(self, events_responses, task_list=None):
        self.events_responses = list(events_responses)
        self.task_list = (
            task_list
            if task_list is not None
            else [{"id": TASK_ID, "taskType": "feature", "status": "doing"}]
        )
        self.paths = []

    def __call__(self, path, base_url=None):
        self.paths.append(path)
        if path.startswith("/tasks?"):
            return {"data": list(self.task_list)}
        if path.startswith("/feature-task-analytics/tasks/"):
            index = len(
                [p for p in self.paths if p.startswith("/feature-task-analytics/tasks/")]
            ) - 1
            index = min(index, len(self.events_responses) - 1)
            return self.events_responses[index]
        raise AssertionError(f"unexpected path {path}")


class FetchTaskEventsTest(unittest.TestCase):
    def test_follows_every_page_in_order(self):
        first = _page([_event("ready_checks", "quality", "missing spec")], True, "cursor-1")
        second = _page(
            [_event("spec_check", "capacity", "blocked")], True, "cursor-2"
        )
        third = _page([_event("verify_delivery", "quality", "not merged")])
        fetcher = PagedEventsFetcher([first, second, third])

        with patch.object(tally_events, "fetch", fetcher):
            events = tally_events.fetch_task_events(TASK_ID)

        self.assertEqual(
            [e["gate"] for e in events],
            ["ready_checks", "spec_check", "verify_delivery"],
        )
        self.assertEqual(
            fetcher.paths,
            [
                f"/feature-task-analytics/tasks/{TASK_ID}/events",
                f"/feature-task-analytics/tasks/{TASK_ID}/events?cursor=cursor-1",
                f"/feature-task-analytics/tasks/{TASK_ID}/events?cursor=cursor-2",
            ],
        )

    def test_accepts_legacy_single_page_response(self):
        legacy = {"data": [_event("ready_checks", "quality", "missing spec")]}
        fetcher = PagedEventsFetcher([legacy])

        with patch.object(tally_events, "fetch", fetcher):
            events = tally_events.fetch_task_events(TASK_ID)

        self.assertEqual(len(events), 1)
        self.assertEqual(len(fetcher.paths), 1)

    def test_repeated_cursor_raises_instead_of_looping(self):
        looping = _page([_event("ready_checks", "quality", "missing spec")], True, "cursor-1")
        fetcher = PagedEventsFetcher([looping])

        with patch.object(tally_events, "fetch", fetcher):
            with self.assertRaises(tally_events.PaginationError) as ctx:
                tally_events.fetch_task_events(TASK_ID)

        self.assertIn("repeated cursor", str(ctx.exception))
        # Two requests: the first page and the page that repeats the cursor.
        self.assertEqual(len(fetcher.paths), 2)

    def test_missing_next_cursor_raises(self):
        broken = _page([_event("ready_checks", "quality", "missing spec")], True, None)
        fetcher = PagedEventsFetcher([broken])

        with patch.object(tally_events, "fetch", fetcher):
            with self.assertRaises(tally_events.PaginationError):
                tally_events.fetch_task_events(TASK_ID)

    def test_cursor_is_url_encoded(self):
        paged = _page([_event("ready_checks", "quality", "missing spec")], True, "a+b/c=")
        fetcher = PagedEventsFetcher([paged, _page([])])

        with patch.object(tally_events, "fetch", fetcher):
            tally_events.fetch_task_events(TASK_ID)

        self.assertIn("cursor=a%2Bb%2Fc%3D", fetcher.paths[1])


class TallyOutputTest(unittest.TestCase):
    """The tally must be identical pre/post pagination on the same events."""

    EVENTS = [
        _event("ready_checks", "quality", "Missing task comment `[tech-design]`."),
        _event("ready_checks", "quality", "Missing task comment `[tech-design]`."),
        _event("spec_check", "capacity", "Implementer already busy."),
    ]

    def _run_main(self, fetcher):
        stdout = io.StringIO()
        with patch.object(tally_events, "fetch", fetcher), patch.object(
            tally_events, "fetch_terminal_tasks", return_value=[]
        ), patch.object(
            sys, "argv", ["tally_events.py"]
        ), contextlib.redirect_stdout(stdout):
            tally_events.main()
        return json.loads(stdout.getvalue())

    def test_multi_page_tally_matches_single_page_tally(self):
        single = PagedEventsFetcher([_page(list(self.EVENTS))])
        paged = PagedEventsFetcher(
            [
                _page(self.EVENTS[:2], True, "cursor-1"),
                _page(self.EVENTS[2:], False, None),
            ]
        )

        single_result = self._run_main(single)
        paged_result = self._run_main(paged)

        self.assertEqual(single_result, paged_result)
        self.assertEqual(paged_result["total"], 3)
        self.assertEqual(paged_result["byGate"], [["ready_checks", 2], ["spec_check", 1]])
        self.assertEqual(paged_result["byCause"], [["quality", 2], ["capacity", 1]])
        self.assertEqual(
            paged_result["byMessage"],
            [
                ["Missing task comment `[tech-design]`.", 2],
                ["Implementer already busy.", 1],
            ],
        )

    def test_broken_pagination_fails_the_script(self):
        looping = _page([_event("ready_checks", "quality", "boom")], True, "cursor-1")
        fetcher = PagedEventsFetcher([looping])

        stderr = io.StringIO()
        with patch.object(tally_events, "fetch", fetcher), patch.object(
            tally_events, "fetch_terminal_tasks", return_value=[]
        ), patch.object(
            sys, "argv", ["tally_events.py"]
        ), contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as ctx:
            tally_events.main()

        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("repeated cursor", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
