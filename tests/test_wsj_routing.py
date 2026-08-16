#!/usr/bin/env python3
"""Task 536e04fc WS3 — classification routing in `lobster_request_spec_approval`.

The WS3 routing layer decides whether an `implement` item needs Tom's
approval (any spec is `feature`), can go straight to a `code`/`research`
task (every spec is code or research), or should be surfaced for manual
triage (any spec is `ambiguous` or its classification is missing/unknown).

Tests pin the routing contract:
- `_resolve_route` returns ROUTE_FEATURE when any spec is feature
- `_resolve_route` returns ROUTE_DIRECT only when every spec is code/research
- `_resolve_route` returns ROUTE_AMBIGUOUS when any spec is ambiguous OR
  missing OR has a classificationError OR carries an unknown enum
- `_resolve_route` falls back to ROUTE_FEATURE when no classifications
  exist (preserves the pre-WS3 flow)
- State shape `classifications` takes precedence over input shape
  `classifications`; passing both is undefined — state wins
- `_build_direct_create_item` only emits `code`/`research` tasks
- `_append_triage_events` appends to the queue and creates the file on
  first write

Runs under the same discover command as the rest of the sindustries
test suite (which uses `unittest discover`, not pytest):
    python3 -m unittest tests.test_wsj_routing
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


# Make sure the scripts root is importable for the lobster_request_spec_approval
# module under test.
SCRIPTS_ROOT = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks" / "scripts"
WORKFLOW_DIR = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks"
for _p in (SCRIPTS_ROOT, WORKFLOW_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def _load_routing():
    """Import the script as a module. Skip the whole class if absent."""
    try:
        return importlib.import_module("lobster_request_spec_approval")
    except Exception as exc:  # noqa: BLE001
        raise unittest.SkipTest(
            f"lobster_request_spec_approval not importable in this checkout: {exc}"
        )


def _spec(spec_doc, classification, *, rationale=None, error=None):
    return {
        "specDoc": spec_doc,
        "classification": classification,
        "classification_rationale": rationale or "",
        "classificationError": error,
    }


class TestRoutePriority(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def test_ambiguous_wins_over_feature(self):
        classify = [
            _spec("brain/bookmarks/specs/a.md", "feature", rationale="r"),
            _spec("brain/bookmarks/specs/b.md", "ambiguous"),
        ]
        state = {"items": {"abc": {"classifications": classify}}}
        route, per_spec = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_AMBIGUOUS)
        self.assertEqual(len(per_spec), 2)

    def test_feature_wins_over_direct(self):
        """If any spec is feature, the item must go through approval even
        when other specs are code/research. Mixed items are feature, full
        stop."""
        classify = [
            _spec("brain/bookmarks/specs/a.md", "code", rationale="r"),
            _spec("brain/bookmarks/specs/b.md", "feature", rationale="r"),
            _spec("brain/bookmarks/specs/c.md", "research", rationale="r"),
        ]
        state = {"items": {"abc": {"classifications": classify}}}
        route, _per_spec = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_FEATURE)

    def test_all_code_research_is_direct(self):
        classify = [
            _spec("brain/bookmarks/specs/a.md", "code", rationale="r"),
            _spec("brain/bookmarks/specs/b.md", "research", rationale="r"),
        ]
        state = {"items": {"abc": {"classifications": classify}}}
        route, per_spec = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_DIRECT)
        self.assertEqual(len(per_spec), 2)


class TestRouteAmbiguityTriggers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def test_missing_classification_is_ambiguous(self):
        classify = [_spec("brain/bookmarks/specs/a.md", None, rationale="r")]
        state = {"items": {"abc": {"classifications": classify}}}
        route, _ = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_AMBIGUOUS)

    def test_classification_error_is_ambiguous(self):
        classify = [
            _spec("brain/bookmarks/specs/a.md", "code", error="LLM parse failed"),
        ]
        state = {"items": {"abc": {"classifications": classify}}}
        route, _ = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_AMBIGUOUS)

    def test_unknown_enum_value_is_ambiguous(self):
        """Pipeline must never silently coerce unknown enum values to a
        route. Treat as ambiguous so the WS4 triage queue catches it."""
        classify = [
            _spec("brain/bookmarks/specs/a.md", "bugfix", rationale="r"),
        ]
        state = {"items": {"abc": {"classifications": classify}}}
        route, _ = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_AMBIGUOUS)


class TestRouteFallback(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def test_no_classifications_falls_back_to_feature(self):
        """Pre-WS3 state has no `classifications` field. The routing layer
        must default to feature so today's flow keeps working until the
        Ivy prompt + validator are fully live."""
        state = {"items": {"abc": {"reviewStatus": "spec_requested"}}}
        route, per_spec = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_FEATURE)
        self.assertEqual(per_spec, [])

    def test_empty_classifications_array_falls_back_to_feature(self):
        state = {"items": {"abc": {"classifications": []}}}
        route, per_spec = self.routing._resolve_route(state["items"]["abc"], {})
        self.assertEqual(route, self.routing.ROUTE_FEATURE)
        self.assertEqual(per_spec, [])

    def test_state_classifications_take_precedence_over_input(self):
        """When state and input both carry classifications, state wins —
        the LLM has run, state was persisted, and the input payload is
        a stale draft."""
        state_classify = [_spec("brain/bookmarks/specs/a.md", "code", rationale="state")]
        input_classify = [_spec("brain/bookmarks/specs/a.md", "feature", rationale="input")]
        state = {"items": {"abc": {"classifications": state_classify}}}
        route, per_spec = self.routing._resolve_route(
            state["items"]["abc"], {"classifications": input_classify}
        )
        self.assertEqual(route, self.routing.ROUTE_DIRECT)
        self.assertEqual(per_spec[0]["classification_rationale"], "state")


class TestBuildDirectCreateItem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def test_only_code_research_specs_become_tasks(self):
        item = {
            "bookmarkKey": "abc",
            "topic": "t",
            "title": "Bookmark",
            "specProposals": [
                {"specDoc": "brain/bookmarks/specs/a.md", "title": "Spec A"},
                {"specDoc": "brain/bookmarks/specs/b.md", "title": "Spec B"},
            ],
        }
        per_spec = [
            _spec("brain/bookmarks/specs/a.md", "code", rationale="r1"),
            _spec("brain/bookmarks/specs/b.md", "feature", rationale="r2"),
        ]
        out = self.routing._build_direct_create_item(item, per_spec)
        self.assertEqual(len(out["tasks"]), 1)
        self.assertEqual(out["tasks"][0]["type"], "code")
        self.assertEqual(out["tasks"][0]["title"], "Spec A")
        self.assertEqual(out["tasks"][0]["specDoc"], "brain/bookmarks/specs/a.md")
        # specDocs is the *full* per_spec list (so audit trails can see what
        # was filtered, not just what got created). Verify the contract.
        self.assertEqual(out["specDocs"], ["brain/bookmarks/specs/a.md", "brain/bookmarks/specs/b.md"])

    def test_missing_spec_title_falls_back_to_path_stem(self):
        item = {"bookmarkKey": "abc", "specProposals": []}
        per_spec = [_spec("brain/bookmarks/specs/foo-bar.md", "research", rationale="r")]
        out = self.routing._build_direct_create_item(item, per_spec)
        self.assertEqual(out["tasks"][0]["title"], "foo-bar")


class TestAppendTriageEvents(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_creates_file_on_first_write(self):
        path = self.tmp_path / "brain" / "state" / "bookmark-triage-queue.json"
        size = self.routing._append_triage_events([{"bookmarkKey": "abc"}], path=path)
        self.assertEqual(size, 1)
        self.assertTrue(path.exists())
        body = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(body, [{"bookmarkKey": "abc"}])

    def test_appends_to_existing_file(self):
        path = self.tmp_path / "queue.json"
        path.write_text(json.dumps([{"bookmarkKey": "first"}]), encoding="utf-8")
        size = self.routing._append_triage_events([{"bookmarkKey": "second"}], path=path)
        self.assertEqual(size, 2)
        body = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([e["bookmarkKey"] for e in body], ["first", "second"])

    def test_recovers_from_corrupt_file(self):
        path = self.tmp_path / "queue.json"
        path.write_text("{not valid json", encoding="utf-8")
        size = self.routing._append_triage_events([{"bookmarkKey": "fresh"}], path=path)
        self.assertEqual(size, 1)
        body = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(body, [{"bookmarkKey": "fresh"}])

    def test_recovers_from_non_list_file(self):
        path = self.tmp_path / "queue.json"
        path.write_text(json.dumps({"oops": "not a list"}), encoding="utf-8")
        size = self.routing._append_triage_events([{"bookmarkKey": "x"}], path=path)
        self.assertEqual(size, 1)


class TestMainRoutingIntegration(unittest.TestCase):
    """End-to-end test that `main()` produces the expected buckets in stdout."""

    @classmethod
    def setUpClass(cls):
        cls.routing = _load_routing()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        # Build a minimal state file so the routing layer can read it.
        self.state_path = self.tmp_path / "state.json"
        self.classify_path = self.tmp_path / "classify-record.json"
        # Create empty spec files so the Phase 4 disk-existence check passes.
        for spec_rel in ("a.md", "b.md", "c.md"):
            spec = self.tmp_path / "brain" / "bookmarks" / "specs" / spec_rel
            spec.parent.mkdir(parents=True, exist_ok=True)
            spec.write_text("# Spec — Test\n", encoding="utf-8")
        # Patch STATE_PATH effectively by stubbing load_state via env override
        # of the module's free constants. The script imports STATE_PATH from
        # common.py at import time so we monkey-patch the module attribute.
        self._state_path_patcher = mock.patch.object(
            self.routing, "STATE_PATH", self.state_path
        )
        self._state_path_patcher.start()
        self._triage_path_patcher = mock.patch.object(
            self.routing, "TRIAGE_QUEUE_PATH", self.tmp_path / "triage.json"
        )
        self._triage_path_patcher.start()
        self._workspace_patcher = mock.patch.object(
            self.routing, "WORKSPACE", self.tmp_path
        )
        self._workspace_patcher.start()

    def tearDown(self):
        self._state_path_patcher.stop()
        self._triage_path_patcher.stop()
        self._workspace_patcher.stop()
        self._tmp.cleanup()

    def _seed_state(self, items):
        # Save state in the same shape common.load_state expects.
        import io
        buf = io.StringIO()
        json.dump({"items": items}, buf)
        self.state_path.write_text(buf.getvalue(), encoding="utf-8")

    def test_main_emits_direct_ambiguous_feature_buckets(self):
        self._seed_state({
            "ABC": {"classifications": [_spec("brain/bookmarks/specs/a.md", "code", rationale="r")]},
            "DEF": {"classifications": [_spec("brain/bookmarks/specs/b.md", "ambiguous")]},
            "GHI": {"classifications": [_spec("brain/bookmarks/specs/c.md", "feature", rationale="r")]},
        })
        implement_payload = [
            {"bookmarkKey": "ABC", "title": "T1", "topic": "t", "specDocs": ["brain/bookmarks/specs/a.md"]},
            {"bookmarkKey": "DEF", "title": "T2", "topic": "t", "specDocs": ["brain/bookmarks/specs/b.md"]},
            {"bookmarkKey": "GHI", "title": "T3", "topic": "t", "specDocs": ["brain/bookmarks/specs/c.md"]},
        ]
        stdin_payload = json.dumps({"implement": implement_payload, "reviewed": [], "monitoring": []})

        with mock.patch.object(sys, "stdin", new=io.StringIO(stdin_payload)), \
             mock.patch.object(sys, "stdout", new=io.StringIO()) as out, \
             mock.patch.object(sys, "argv", ["lobster_request_spec_approval"]):
            rc = self.routing.main()
            self.assertEqual(rc, 0)
            result = json.loads(out.getvalue())

        # ABC = code → directCreateItems
        self.assertEqual(len(result["directCreateItems"]), 1)
        self.assertEqual(result["directCreateItems"][0]["bookmarkKey"], "ABC")
        self.assertEqual(result["directCreateItems"][0]["tasks"][0]["type"], "code")

        # DEF = ambiguous → triageEvents
        self.assertEqual(len(result["triageEvents"]), 1)
        self.assertEqual(result["triageEvents"][0]["bookmarkKey"], "DEF")

        # GHI = feature → readyPackages (no pending approval so it goes through)
        self.assertEqual(len(result["readyPackages"]), 1)
        self.assertEqual(result["readyPackages"][0]["items"][0]["bookmarkKey"], "GHI")

        # Triage queue file was written
        self.assertTrue((self.tmp_path / "triage.json").exists())


# Late imports for the integration test (moved out of setUpClass so other
# tests don't fail on missing io module).
import io  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(
        unittest.main(module="tests.test_wsj_routing", argv=["_"], exit=False, verbosity=2)
        or 0
    )
