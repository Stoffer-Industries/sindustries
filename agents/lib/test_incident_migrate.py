"""Tests for agents.lib.incident_migrate — task 75ec1c8c.

Run from the repo root::

    python3 -m unittest agents.lib.test_incident_migrate -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agents.lib import incident_migrate as mig  # noqa: E402


LEGACY_QUINN = {
    "ops": {
        "tasks-api-down": {
            "firstSeen": "2026-07-01T00:00:00Z",
            "attempts": 3,
            "needsTom": True,
            "severity": "critical",
            "status": "escalated",
            "lastAction": "restart",
            "escalatedAt": "2026-07-02T00:00:00Z",
        }
    }
}

UNIFIED_LOX = {
    "_meta": {"v": 1},
    "incidents": {
        "firewall": {
            "owner": "lox",
            "status": "watching",
            "recurrenceCount": 2,
            "nextRetryAt": "2026-07-12T00:00:00Z",
            "details": {"note": "still blocked"},
        }
    },
}


class MigrateFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_quinn(self) -> Path:
        (self.tmpdir / "brain" / "state").mkdir(parents=True, exist_ok=True)
        p = self.tmpdir / "brain" / "state" / "quinn-ops-state.json"
        p.write_text(json.dumps(LEGACY_QUINN))
        return p

    def _write_lox(self) -> Path:
        (self.tmpdir / "brain" / "state").mkdir(parents=True, exist_ok=True)
        p = self.tmpdir / "brain" / "state" / "lox-incident-state.json"
        p.write_text(json.dumps(UNIFIED_LOX))
        return p

    def test_dry_run_does_not_write(self):
        path = self._write_quinn()
        before_text = path.read_text()
        result = mig.migrate_file(path, owner="quinn", write=False)
        self.assertTrue(result["changed"])
        self.assertEqual(path.read_text(), before_text)
        self.assertEqual(result["entries_migrated"], 1)

    def test_in_place_writes_unified_shape(self):
        path = self._write_quinn()
        result = mig.migrate_file(path, owner="quinn", write=True)
        self.assertTrue(result["changed"])
        self.assertTrue(result["backup"])
        self.assertTrue(Path(result["backup"]).exists())
        after = json.loads(path.read_text())
        self.assertIn("incidents", after)
        self.assertNotIn("ops", after)
        self.assertEqual(after["incidents"]["tasks-api-down"]["owner"], "quinn")
        self.assertEqual(after["incidents"]["tasks-api-down"]["recurrenceCount"], 0)
        self.assertEqual(after["incidents"]["tasks-api-down"]["nextRetryAt"], None)
        self.assertEqual(after["incidents"]["tasks-api-down"]["details"], {})

    def test_in_place_lox_preserves_unified_entries(self):
        path = self._write_lox()
        result = mig.migrate_file(path, owner="lox", write=True)
        # Lox file was already in unified shape with `incidents` key; normalize
        # path should still produce a valid file.
        after = json.loads(path.read_text())
        self.assertIn("incidents", after)
        self.assertEqual(after["incidents"]["firewall"]["owner"], "lox")
        self.assertEqual(after["incidents"]["firewall"]["recurrenceCount"], 2)
        self.assertIn("firstSeen", after["incidents"]["firewall"])

    def test_in_place_idempotent(self):
        path = self._write_quinn()
        first = mig.migrate_file(path, owner="quinn", write=True)
        self.assertTrue(first["changed"])
        second = mig.migrate_file(path, owner="quinn", write=True)
        # Second pass should report no change (no further .bak should be written).
        self.assertFalse(second["changed"])
        # Compare structural content.
        after_first = json.loads(path.read_text())
        # Re-migrate (dry-run) and confirm `changed` is now False on next pass.
        third = mig.migrate_file(path, owner="quinn", write=False)
        self.assertFalse(third["changed"])

    def test_reset_drops_entries(self):
        path = self._write_quinn()
        mig.migrate_file(path, owner="quinn", reset=True, write=True)
        after = json.loads(path.read_text())
        self.assertEqual(after["incidents"], {})

    def test_missing_file_returns_empty_result(self):
        result = mig.migrate_file(self.tmpdir / "nope.json", owner="quinn")
        self.assertFalse(result["existed"])
        self.assertFalse(result["changed"])
        self.assertEqual(result["entries_migrated"], 0)

    def test_malformed_json_raises(self):
        path = self._write_quinn()
        path.write_text("{ this is not json")
        with self.assertRaises(mig.IncidentStateError):
            mig.migrate_file(path, owner="quinn", write=True)

    def test_validates_against_schema_after_write(self):
        path = self._write_quinn()
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.skipTest("jsonschema not installed")
        mig.migrate_file(path, owner="quinn", write=True)
        # If the result didn't validate, migrate_file would have raised before
        # writing. Read back and re-validate explicitly for the test signal.
        from agents.lib.incident_state import validate_with_schema
        validate_with_schema(json.loads(path.read_text()))


class RunMigrationTests(unittest.TestCase):
    def test_run_migration_handles_both_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            (tmpdir / "brain" / "state").mkdir(parents=True)
            (tmpdir / "brain" / "state" / "quinn-ops-state.json").write_text(json.dumps(LEGACY_QUINN))
            (tmpdir / "brain" / "state" / "lox-incident-state.json").write_text(json.dumps(UNIFIED_LOX))
            results = mig.run_migration(tmpdir, write=False)
            self.assertEqual(len(results), 2)
            owners = [r["owner"] for r in results]
            self.assertEqual(owners, ["quinn", "lox"])
            # Quinn is migrated (ops -> incidents) and so changes shape; Lox
            # already uses `incidents` but gains missing fields (firstSeen,
            # attempts, needsTom, severity) on each entry, which is also a
            # change.
            self.assertTrue(results[0]["changed"])  # Quinn
            self.assertTrue(results[1]["changed"])  # Lox (gains missing fields)


if __name__ == "__main__":
    unittest.main()