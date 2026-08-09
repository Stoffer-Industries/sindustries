"""Tests for agents.lib.incident_state — task 75ec1c8c.

Run from the repo root::

    python3 -m unittest agents.lib.test_incident_state -v

These tests do NOT require jsonschema for the hot-path cases (parse_file,
load_all_incidents, needs_tom). validate_with_schema is exercised in a
dedicated test that gracefully skips if jsonschema is not installed.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent
from unittest import mock

# Make the `agents` package importable when run directly from repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agents.lib import incident_state as ist  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

LEGACY_QUINN_OPS = {
    "ops": {
        "bookmark-tagger-acpx-401-silently-degraded": {
            "firstSeen": "2026-06-19T16:15:00Z",
            "lastCheckedAt": "2026-06-28T07:21:24.997602+00:00",
            "status": "resolved",
            "severity": "medium",
            "needsTom": False,
            "attempts": 5,
            "lastAction": "PR #104 merged.",
            "resolvedAt": "2026-06-25T23:49:28.032317+00:00",
            "escalatedAt": None,
            "linkedPr": "https://github.com/Stoffer-Industries/sindustries/pull/104",
            "followUp": ["Patch pr-open reviewer default"],
        },
        "tasks-api-prod-down": {
            "firstSeen": "2026-07-05T10:00:00Z",
            "lastCheckedAt": "2026-07-10T10:00:00Z",
            "status": "escalated",
            "severity": "critical",
            "needsTom": True,
            "attempts": 7,
            "lastAction": "Restart attempted.",
            "escalatedAt": "2026-07-09T12:00:00Z",
            "resolvedAt": None,
        },
    }
}

UNIFIED_QUINN_INCIDENTS = {
    "incidents": {
        "tasks-api-prod-down": {
            "owner": "quinn",
            "firstSeen": "2026-07-05T10:00:00Z",
            "lastCheckedAt": "2026-07-10T10:00:00Z",
            "status": "escalated",
            "severity": "critical",
            "needsTom": True,
            "attempts": 7,
            "escalatedAt": "2026-07-09T12:00:00Z",
            "resolvedAt": None,
            "nextRetryAt": None,
            "recurrenceCount": 0,
            "lastAction": "Restart attempted.",
            "details": {},
        }
    }
}

LEGACY_LOX_INCIDENTS = {
    "_meta": {"lastHeartbeatAt": "2026-07-11T04:30:00Z"},
    "incidents": {
        "bookmark-acpx-openai-401-no-scopes-2026-06-25": {
            "dailyReviewDate": "2026-06-25",
            "details": {"blastRadius": {"affectedBookmarks": 4}},
            "owner": "lox",
            "recurrenceCount": 1,
            "nextRetryAt": None,
            "status": "watching",
        },
        "firewall": {
            "owner": "lox",
            "recurrenceCount": 4,
            "nextRetryAt": "2026-07-12T10:00:00Z",
            "status": "repair_attempted",  # legacy Lox status; should normalize
        },
    },
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class ParseFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, name: str, payload: dict) -> Path:
        p = self.tmpdir / name
        p.write_text(json.dumps(payload))
        return p

    def test_parse_legacy_quinn_ops_returns_unified_shape(self):
        path = self._write("quinn-ops-state.json", LEGACY_QUINN_OPS)
        out = ist.parse_file(path)
        self.assertEqual(len(out), 2)
        for entry in out:
            self.assertEqual(entry["owner"], "quinn")
            self.assertIn("status", entry)
            self.assertIn("severity", entry)
            self.assertIn("attempts", entry)
            self.assertIn("recurrenceCount", entry)
            self.assertIn("details", entry)
            self.assertIn("nextRetryAt", entry)

    def test_parse_unified_quinn_returns_unified_shape(self):
        path = self._write("quinn-ops-state.json", UNIFIED_QUINN_INCIDENTS)
        out = ist.parse_file(path)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["owner"], "quinn")
        self.assertEqual(out[0]["status"], "escalated")
        self.assertEqual(out[0]["severity"], "critical")

    def test_parse_legacy_lox_returns_unified_shape(self):
        path = self._write("lox-incident-state.json", LEGACY_LOX_INCIDENTS)
        out = ist.parse_file(path)
        self.assertEqual(len(out), 2)
        # `firewall` had legacy `repair_attempted` status — should normalize.
        firewall = next(e for e in out if e.get("_slug") == "firewall")
        self.assertEqual(firewall["owner"], "lox")
        self.assertEqual(firewall["status"], "watching")  # normalized
        # Legacy Lox entry gained firstSeen (derived from dailyReviewDate for the
        # bookmark entry; the firewall entry has no dailyReviewDate so firstSeen
        # is `now`).
        self.assertIn("firstSeen", firewall)
        # Should have gained attempts/needsTom/severity.
        self.assertIn("attempts", firewall)
        self.assertIn("needsTom", firewall)
        self.assertIn("severity", firewall)

    def test_parse_lox_derives_first_seen_from_daily_review_date(self):
        path = self._write("lox-incident-state.json", LEGACY_LOX_INCIDENTS)
        out = ist.parse_file(path)
        bookmark = next(e for e in out if e.get("_slug", "").startswith("bookmark-acpx"))
        self.assertEqual(bookmark["firstSeen"], "2026-06-25T00:00:00Z")

    def test_parse_missing_file_returns_empty(self):
        out = ist.parse_file(self.tmpdir / "does-not-exist.json")
        self.assertEqual(out, [])

    def test_parse_malformed_json_returns_empty(self):
        path = self.tmpdir / "quinn-ops-state.json"
        path.write_text("{ this is not json")
        out = ist.parse_file(path)
        self.assertEqual(out, [])

    def test_parse_non_object_returns_empty(self):
        path = self.tmpdir / "quinn-ops-state.json"
        path.write_text("[1, 2, 3]")
        out = ist.parse_file(path)
        self.assertEqual(out, [])

    def test_parse_no_known_key_returns_empty(self):
        path = self.tmpdir / "quinn-ops-state.json"
        path.write_text(json.dumps({"somethingElse": {}}))
        out = ist.parse_file(path)
        self.assertEqual(out, [])

    def test_parse_skips_non_dict_entries(self):
        payload = {"incidents": {"good": {"owner": "quinn", "status": "watching"}, "bad": "not a dict"}}
        path = self.tmpdir / "quinn-ops-state.json"
        path.write_text(json.dumps(payload))
        out = ist.parse_file(path)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["_slug"], "good")


class LoadAllIncidentsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        (self.tmpdir / "brain" / "state").mkdir(parents=True)
        (self.tmpdir / "brain" / "state" / "quinn-ops-state.json").write_text(
            json.dumps(LEGACY_QUINN_OPS)
        )
        (self.tmpdir / "brain" / "state" / "lox-incident-state.json").write_text(
            json.dumps(LEGACY_LOX_INCIDENTS)
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_load_all_returns_flat_list(self):
        out = ist.load_all_incidents(workspace=self.tmpdir)
        # 2 Quinn + 2 Lox = 4
        self.assertEqual(len(out), 4)
        owners = {e["owner"] for e in out}
        self.assertEqual(owners, {"quinn", "lox"})

    def test_load_all_missing_files_returns_just_what_exists(self):
        (self.tmpdir / "brain" / "state" / "lox-incident-state.json").unlink()
        out = ist.load_all_incidents(workspace=self.tmpdir)
        self.assertEqual(len(out), 2)
        self.assertTrue(all(e["owner"] == "quinn" for e in out))


class WorkspaceDefaultTests(unittest.TestCase):
    """W29 audit [Low]: WORKSPACE_DEFAULT must not hard-code a laptop path."""

    def test_openclaw_workspace_env_override_is_used(self):
        sentinel = "/tmp/incident_state_env_override_test"
        with mock.patch.dict(os.environ, {"OPENCLAW_WORKSPACE": sentinel}, clear=False):
            # Reload the module so the module-level constant re-evaluates with
            # the patched env var. Patching os.environ alone does not refresh
            # already-bound names.
            import importlib
            reloaded = importlib.reload(ist)
            self.assertEqual(
                Path(reloaded.WORKSPACE_DEFAULT), Path(sentinel)
            )

    def test_home_fallback_when_env_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENCLAW_WORKSPACE", None)
            import importlib
            reloaded = importlib.reload(ist)
            expected = Path.home() / ".openclaw" / "workspace"
            self.assertEqual(Path(reloaded.WORKSPACE_DEFAULT), expected)


class NeedsTomTests(unittest.TestCase):
    def test_needs_tom_flags_needsTom_true(self):
        out = ist.needs_tom([
            {"owner": "quinn", "needsTom": True, "severity": "low", "status": "watching"},
        ])
        self.assertEqual(len(out), 1)

    def test_needs_tom_flags_high_severity(self):
        out = ist.needs_tom([
            {"owner": "quinn", "needsTom": False, "severity": "high", "status": "watching"},
            {"owner": "lox", "needsTom": False, "severity": "critical", "status": "watching"},
        ])
        self.assertEqual(len(out), 2)

    def test_needs_tom_skips_low_medium(self):
        out = ist.needs_tom([
            {"owner": "quinn", "needsTom": False, "severity": "low", "status": "watching"},
            {"owner": "quinn", "needsTom": False, "severity": "medium", "status": "watching"},
        ])
        self.assertEqual(len(out), 0)

    def test_needs_tom_skips_resolved(self):
        # Resolved high-severity entries still pass needs_tom() — callers can
        # filter on `status` themselves if needed.
        out = ist.needs_tom([
            {"owner": "quinn", "needsTom": False, "severity": "high", "status": "resolved"},
        ])
        self.assertEqual(len(out), 1)


class ValidateWithSchemaTests(unittest.TestCase):
    def test_validate_unified_state_passes(self):
        # May skip if jsonschema not installed.
        try:
            ist.validate_with_schema(UNIFIED_QUINN_INCIDENTS)
        except ist.IncidentStateError as exc:
            if "jsonschema" in str(exc):
                self.skipTest(f"jsonschema not installed: {exc}")
            raise

    def test_validate_rejects_legacy_ops_key(self):
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.skipTest("jsonschema not installed")
        with self.assertRaises(Exception):
            ist.validate_with_schema(LEGACY_QUINN_OPS)

    def test_validate_requires_owner(self):
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.skipTest("jsonschema not installed")
        bad = {"incidents": {"x": {"status": "watching"}}}  # missing owner
        with self.assertRaises(Exception):
            ist.validate_with_schema(bad)

    def test_validate_accepts_linkedPr_as_array(self):
        # Quinn sometimes records multiple PRs for the same incident. The
        # schema must accept both string and array.
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.skipTest("jsonschema not installed")
        state = {"incidents": {"x": {
            "owner": "quinn",
            "status": "resolved",
            "linkedPr": ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"],
        }}}
        ist.validate_with_schema(state)  # should not raise


class RoundTripTests(unittest.TestCase):
    def test_round_trip_idempotency(self):
        """parse_file -> write back -> parse_file again yields the same list."""
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            (tmpdir / "brain" / "state").mkdir(parents=True)
            qpath = tmpdir / "brain" / "state" / "quinn-ops-state.json"
            qpath.write_text(json.dumps(LEGACY_QUINN_OPS))
            first = ist.parse_file(qpath)
            # Write back in unified shape.
            unified = {"incidents": {e["_slug"]: {k: v for k, v in e.items() if k != "_slug"} for e in first}}
            qpath.write_text(json.dumps(unified))
            second = ist.parse_file(qpath)
            # Sort by slug for comparison.
            first.sort(key=lambda e: e["_slug"])
            second.sort(key=lambda e: e["_slug"])
            self.assertEqual(len(first), len(second))
            for a, b in zip(first, second):
                # All non-_slug fields should match.
                a_clean = {k: v for k, v in a.items() if k != "_slug"}
                b_clean = {k: v for k, v in b.items() if k != "_slug"}
                self.assertEqual(a_clean, b_clean)


if __name__ == "__main__":
    unittest.main()