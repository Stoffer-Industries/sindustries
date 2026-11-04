"""Tests for agents.lib.incident_queue.

Run from the repo root::

    python3 -m unittest agents.lib.test_incident_queue -v

Regression intent: heartbeat used to hand-count the queue from Quinn's own state
file only, which hid every Lox-owned incident (including a CRITICAL) for many
beats. These tests pin the split to the shared parser so the counts in a
heartbeat cannot drift from the registry again.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from textwrap import dedent
from unittest import mock

# Make the `agents` package importable when run directly from repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agents.lib import incident_queue as iq  # noqa: E402
from agents.lib import incident_state as ist  # noqa: E402

NOW = datetime(2026, 10, 21, 4, 50, tzinfo=timezone.utc)


def _incident(slug: str, **overrides) -> dict:
    base = {
        "key": slug,
        "owner": "quinn",
        "status": "watching",
        "severity": "medium",
        "needsTom": False,
        "firstSeen": "2026-10-20T00:00:00+00:00",
        "lastCheckedAt": NOW.isoformat(),
        "lastAction": f"{slug} last action",
        "details": {},
    }
    base.update(overrides)
    return base


class BuildQueueCountsTests(unittest.TestCase):
    def test_counts_read_from_both_owners_not_one_file(self):
        records = [
            _incident("lox-critical", owner="lox", severity="critical", needsTom=True),
            _incident("lox-high", owner="lox", severity="high"),
            _incident("quinn-watch", owner="quinn", severity="low"),
            _incident("quinn-medium", owner="quinn", severity="medium", needsTom=True),
        ]
        queue = iq.build_queue(records, now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 4)
        self.assertEqual(queue["counts"]["actionable"], 3)  # needsTom OR high/critical
        self.assertEqual(queue["counts"]["monitored"], 1)
        self.assertEqual(queue["counts"]["byOwner"], {"lox": 2, "quinn": 2})

    def test_resolved_and_task_scoped_records_never_count(self):
        records = [
            _incident("resolved", status="resolved", severity="critical", needsTom=True),
            _incident("false-positive", status="false_positive", severity="critical"),
            _incident("archived", status="archived", severity="high"),
            _incident("task-scoped", scope="task", severity="critical", needsTom=True),
            _incident("live", severity="low"),
        ]
        queue = iq.build_queue(records, now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 1)
        self.assertEqual(queue["counts"]["actionable"], 0)
        self.assertEqual(queue["counts"]["monitored"], 1)

    def test_stale_records_are_dropped_so_counts_do_not_inflate(self):
        stale = _incident(
            "stale",
            severity="critical",
            needsTom=True,
            lastCheckedAt=(NOW - timedelta(hours=100)).isoformat(),
        )
        queue = iq.build_queue([stale, _incident("fresh")], now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 1)
        self.assertEqual(queue["counts"]["actionable"], 0)

    def test_schema_minimal_record_does_not_crash_the_queue(self):
        """owner+status only is schema-legal and must not take the CLI down."""
        minimal = {"owner": "quinn", "status": "watching"}
        queue = iq.build_queue([minimal], now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 1)
        self.assertEqual(queue["counts"]["actionable"], 0)
        self.assertEqual(queue["monitored"][0]["identity"], "untitled incident")
        self.assertIn("Incident queue: 0 actionable, 1 monitored.", iq.render_text(queue))

    def test_schema_minimal_critical_still_tops_the_queue(self):
        """Same shape but high severity — must render, not raise."""
        minimal = {"owner": "lox", "status": "escalated", "severity": "critical"}
        queue = iq.build_queue([minimal], now=NOW)
        self.assertEqual(queue["counts"]["actionable"], 1)
        rendered = iq.render_text(queue)
        self.assertIn("1 incident(s) waiting on you.", rendered)
        self.assertIn("untitled incident", rendered)

    def test_blank_and_empty_text_fields_render_without_raising(self):
        records = [
            {"owner": "lox", "status": "watching", "lastAction": "", "trigger": ""},
            {"owner": "lox", "status": "watching", "lastAction": "\n", "title": ""},
            _incident("normal", severity="critical", needsTom=True),
        ]
        queue = iq.build_queue(records, now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 3)
        self.assertEqual(queue["counts"]["actionable"], 1)
        self.assertIn("Top unblock:", iq.render_text(queue))

    def test_empty_registry_reports_zero_not_an_error(self):
        queue = iq.build_queue([], now=NOW)
        self.assertEqual(queue["counts"]["reportable"], 0)
        self.assertEqual(iq.render_text(queue), "No active incident findings.")


class TopCandidateTests(unittest.TestCase):
    def test_top_candidate_is_severity_then_oldest_first(self):
        records = [
            _incident("low-old", severity="low", firstSeen="2026-01-01T00:00:00+00:00"),
            _incident("high-new", severity="high", needsTom=True,
                      firstSeen="2026-10-21T00:00:00+00:00"),
            _incident("critical-new", severity="critical", needsTom=True,
                      firstSeen="2026-10-21T00:00:00+00:00"),
            _incident("critical-old", severity="critical", needsTom=True,
                      firstSeen="2026-09-01T00:00:00+00:00"),
            _incident("medium-old", severity="medium", needsTom=True,
                      firstSeen="2026-01-01T00:00:00+00:00"),
        ]
        queue = iq.build_queue(records, now=NOW)
        self.assertEqual(queue["actionable"][0]["identity"], "critical-old")
        self.assertEqual(queue["actionable"][-1]["identity"], "medium-old")

    def test_fix_option_from_details_is_surfaced_in_top_unblock(self):
        record = _incident(
            "disk-critical",
            owner="lox",
            severity="critical",
            needsTom=True,
            title="Disk usage 97 percent",
            details={
                "fix_options_ranked": [
                    {"summary": "Run `scripts/infra/cleanup_disk.sh --execute` (~5 min)."}
                ]
            },
        )
        queue = iq.build_queue([record], now=NOW)
        top = queue["actionable"][0]
        self.assertIn("disk-critical (lox)", top["summary"])
        self.assertIn("Disk usage 97 percent", top["summary"])
        self.assertIn("cleanup_disk.sh --execute", top["summary"])


class RenderTextTests(unittest.TestCase):
    def test_text_lines_match_heartbeat_contract(self):
        records = [
            _incident("a", severity="critical", needsTom=True),
            _incident("b", severity="high"),
            _incident("c", severity="low"),
            _incident("d", severity="low"),
        ]
        text = iq.render_text(iq.build_queue(records, now=NOW))
        lines = text.splitlines()
        self.assertEqual(lines[0], "Incident queue: 2 actionable, 2 monitored.")
        self.assertEqual(lines[1], "2 incident(s) waiting on you.")
        self.assertTrue(lines[2].startswith("🔴 Top unblock: a (quinn)"))

    def test_zero_actionable_omits_escalation_lines(self):
        records = [_incident("a", severity="low"), _incident("b", severity="medium")]
        text = iq.render_text(iq.build_queue(records, now=NOW))
        self.assertNotIn("waiting on you", text)
        self.assertNotIn("Top unblock", text)
        self.assertIn("Incident queue: 0 actionable, 2 monitored.", text)

    def test_verbose_lists_every_actionable_entry(self):
        records = [
            _incident("a", severity="critical", needsTom=True),
            _incident("b", severity="high", needsTom=True),
        ]
        text = iq.render_text(iq.build_queue(records, now=NOW), verbose=True)
        self.assertIn("escalatedAt=never", text)


class ReadFailureTests(unittest.TestCase):
    """A queue built from an unreadable registry is not a verified snapshot.

    The heartbeat renders "No active incident findings." for a zero queue. When
    the state files could not be read at all, that line is a false zero, so the
    queue must say so rather than look clean.
    """

    def _failure(self, path: str = "brain/state/quinn-ops-state.json") -> dict:
        return {
            "path": path,
            "owner": "quinn",
            "error": "OSError: [Errno 11] Resource deadlock avoided",
        }

    def test_queue_is_marked_unverified_when_a_state_file_could_not_be_read(self):
        queue = iq.build_queue([], now=NOW, read_failures=[self._failure()])
        self.assertFalse(queue["verified"])
        self.assertEqual(len(queue["readFailures"]), 1)

    def test_queue_is_verified_when_nothing_failed(self):
        queue = iq.build_queue([], now=NOW)
        self.assertTrue(queue["verified"])
        self.assertEqual(queue["readFailures"], [])

    def test_unreadable_registry_never_renders_as_a_clean_zero(self):
        queue = iq.build_queue([], now=NOW, read_failures=[self._failure()])
        text = iq.render_text(queue)
        self.assertNotEqual(text, "No active incident findings.")
        self.assertIn("UNVERIFIED", text)
        self.assertIn("quinn-ops-state.json", text)
        self.assertIn("Resource deadlock avoided", text)

    def test_unreadable_registry_still_reports_the_counts_it_did_compute(self):
        records = [_incident("a", severity="critical", needsTom=True)]
        queue = iq.build_queue(records, now=NOW, read_failures=[self._failure()])
        text = iq.render_text(queue)
        self.assertIn("1 actionable, 0 monitored", text)
        self.assertIn("UNVERIFIED", text)

    def test_unreadable_registry_still_surfaces_the_top_unblock(self):
        """UNVERIFIED must add to the summary, not replace it.

        A partially-readable registry still holds real incidents. Rendering
        only the counts would hide the top unblock behind a banner — the
        exact blind spot this whole change exists to close.
        """
        records = [
            _incident("disk-critical", owner="lox", severity="critical", needsTom=True,
                      title="Disk usage 97 percent"),
        ]
        queue = iq.build_queue(records, now=NOW, read_failures=[self._failure()])
        text = iq.render_text(queue)
        self.assertIn("1 incident(s) waiting on you.", text)
        self.assertIn("Top unblock:", text)
        self.assertIn("disk-critical (lox)", text)
        self.assertIn("Disk usage 97 percent", text)
        self.assertIn("UNVERIFIED", text)
        # The banner must not swallow the escalation lines.
        self.assertLess(
            text.index("waiting on you"),
            text.index("could not be read"),
        )

    def test_unreadable_registry_with_no_actionable_records_has_no_top_unblock(self):
        """No actionable records means no top unblock line — that is correct."""
        records = [_incident("a", severity="low")]
        queue = iq.build_queue(records, now=NOW, read_failures=[self._failure()])
        text = iq.render_text(queue)
        self.assertNotIn("waiting on you", text)
        self.assertNotIn("Top unblock", text)
        self.assertIn("UNVERIFIED", text)

    def test_unreadable_registry_never_renders_as_no_active_findings(self):
        """The clean-zero line is reserved for a verified, empty registry."""
        queue = iq.build_queue([], now=NOW, read_failures=[self._failure()])
        self.assertNotEqual(iq.render_text(queue), "No active incident findings.")

    def test_cli_exits_non_zero_when_a_state_file_could_not_be_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "brain" / "state").mkdir(parents=True)
            # Both state files present but malformed, so both reads fail.
            (workspace / "brain" / "state" / "quinn-ops-state.json").write_text("{not json")
            (workspace / "brain" / "state" / "lox-incident-state.json").write_text("{not json")
            code = iq.main(["--workspace", str(workspace)])
        self.assertEqual(code, 3)

    def test_cli_exits_zero_when_state_files_are_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "brain" / "state").mkdir(parents=True)
            (workspace / "brain" / "state" / "quinn-ops-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            (workspace / "brain" / "state" / "lox-incident-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            code = iq.main(["--workspace", str(workspace)])
        self.assertEqual(code, 0)


class MalformedShapeTests(unittest.TestCase):
    """A registry that parses as JSON but is the wrong shape is malformed.

    Per `agents/schemas/agent-incident-state.schema.json` the top level must
    be an object with an `incidents` object. A file that is valid JSON but
    does not have that shape used to yield an empty list — the same empty
    list a genuinely empty registry yields — so the false zero this PR
    closes was still reachable.
    """

    def _workspace(self, tmp: str, quinn_body: str, lox_body: str) -> Path:
        workspace = Path(tmp)
        state_dir = workspace / "brain" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "quinn-ops-state.json").write_text(quinn_body)
        (state_dir / "lox-incident-state.json").write_text(lox_body)
        return workspace

    def _cases(self):
        return {
            "empty_object": "{}",
            "incidents_not_an_object": json.dumps({"incidents": []}),
            "top_level_array": "[]",
            "top_level_scalar": '"just a string"',
            "no_incidents_container": json.dumps({"meta": {"beat": 7}}),
            "incidents_is_a_string": json.dumps({"incidents": "nope"}),
        }

    def test_shape_invalid_registry_is_reported_as_a_read_failure(self):
        for name, body in self._cases().items():
            with self.subTest(shape=name):
                with tempfile.TemporaryDirectory() as tmp:
                    workspace = self._workspace(tmp, body, body)
                    failures = ist.state_file_read_failures(workspace)
                    self.assertEqual(
                        len(failures), 2, f"{name} should fail to load"
                    )
                    for failure in failures:
                        self.assertTrue(failure["error"])

    def test_shape_invalid_registry_never_renders_as_a_clean_zero(self):
        for name, body in self._cases().items():
            with self.subTest(shape=name):
                with tempfile.TemporaryDirectory() as tmp:
                    workspace = self._workspace(tmp, body, body)
                    code = iq.main(["--workspace", str(workspace)])
                    self.assertEqual(code, 3, f"{name} must not exit clean")
                    queue = iq.build_queue(workspace=workspace, now=NOW)
                    self.assertFalse(queue["verified"])
                    text = iq.render_text(queue)
                    self.assertIn("UNVERIFIED", text)
                    self.assertNotEqual(text, "No active incident findings.")

    def test_shape_invalid_file_does_not_hide_the_other_files_records(self):
        """One bad file must not blank out the good file's incidents."""
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            state_dir = workspace / "brain" / "state"
            state_dir.mkdir(parents=True)
            (state_dir / "quinn-ops-state.json").write_text("{}")
            (state_dir / "lox-incident-state.json").write_text(
                json.dumps(
                    {
                        "incidents": {
                            "lox-critical": {
                                "key": "lox-critical",
                                "owner": "lox",
                                "status": "escalated",
                                "severity": "critical",
                                "needsTom": True,
                                "firstSeen": "2026-10-19T08:33:39+00:00",
                                "lastCheckedAt": NOW.isoformat(),
                                "lastAction": "df reported 97%",
                            }
                        }
                    }
                )
            )
            queue = iq.build_queue(workspace=workspace, now=NOW)
            self.assertFalse(queue["verified"])
            self.assertEqual(queue["counts"]["actionable"], 1)
            text = iq.render_text(queue)
            self.assertIn("1 incident(s) waiting on you.", text)
            self.assertIn("Top unblock:", text)
            self.assertIn("lox-critical (lox)", text)
            self.assertIn("UNVERIFIED", text)

    def test_legacy_ops_shape_is_still_a_valid_registry(self):
        """The legacy `ops` container must not be mistaken for a malformed file."""
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            state_dir = workspace / "brain" / "state"
            state_dir.mkdir(parents=True)
            legacy = json.dumps({"ops": {"legacy-one": {"owner": "quinn", "status": "watching"}}})
            (state_dir / "quinn-ops-state.json").write_text(legacy)
            (state_dir / "lox-incident-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            failures = ist.state_file_read_failures(workspace)
            self.assertEqual(failures, [])
            queue = iq.build_queue(workspace=workspace, now=NOW)
            self.assertTrue(queue["verified"])
            self.assertEqual(queue["counts"]["reportable"], 1)


class SingleReadTests(unittest.TestCase):
    """The records and the read failures must come from the same read.

    Reading each state file twice (once for the failure check, once for the
    records) opens a window where iCloud materialises the file between the
    two reads and the queue's counts disagree with its own failure list.
    """

    def test_each_state_file_is_read_exactly_once_per_queue_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            state_dir = workspace / "brain" / "state"
            state_dir.mkdir(parents=True)
            (state_dir / "quinn-ops-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            (state_dir / "lox-incident-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            reads: list[str] = []
            original = Path.read_text

            def counting_read_text(self, *args, **kwargs):
                reads.append(self.name)
                return original(self, *args, **kwargs)

            with mock.patch.object(Path, "read_text", counting_read_text):
                iq.build_queue(workspace=workspace, now=NOW)

            state_reads = [
                name
                for name in reads
                if name in ("quinn-ops-state.json", "lox-incident-state.json")
            ]
            self.assertEqual(
                sorted(state_reads),
                ["lox-incident-state.json", "quinn-ops-state.json"],
                "each state file must be read exactly once per queue build",
            )

    def test_records_and_failures_come_from_the_same_registry_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            state_dir = workspace / "brain" / "state"
            state_dir.mkdir(parents=True)
            (state_dir / "quinn-ops-state.json").write_text("{not json")
            (state_dir / "lox-incident-state.json").write_text(
                json.dumps({"incidents": {}})
            )
            registry = ist.read_registry(workspace)
            self.assertEqual(len(registry.records), 0)
            self.assertEqual(len(registry.failures), 1)
            self.assertFalse(registry.verified)
            self.assertEqual(len(registry.files), 2)


class ParityTests(unittest.TestCase):
    def test_actionable_split_matches_shared_needs_tom(self):
        records = [
            _incident("needs-tom", needsTom=True, severity="low"),
            _incident("severity-high", severity="high", needsTom=False),
            _incident("quiet-low", severity="low", needsTom=False),
            _incident("quiet-medium", severity="medium", needsTom=False),
        ]
        queue = iq.build_queue(records, now=NOW)
        shared = {inc.get("key") for inc in ist.needs_tom(records, now=NOW)}
        self.assertEqual({e["identity"] for e in queue["actionable"]}, shared)


class WorkspaceFileTests(unittest.TestCase):
    """The regression this CLI exists for: two state files, one count."""

    def _write_workspace(self, root: Path) -> Path:
        state_dir = root / "brain" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "quinn-ops-state.json").write_text(
            json.dumps(
                {
                    "incidents": {
                        "quinn-one": _incident("quinn-one", severity="low"),
                    }
                }
            )
        )
        (state_dir / "lox-incident-state.json").write_text(
            dedent(
                """
                {
                  "incidents": {
                    "lox-critical": {
                      "key": "lox-critical",
                      "owner": "lox",
                      "status": "escalated",
                      "severity": "critical",
                      "needsTom": true,
                      "escalatedAt": "2026-10-19T11:19:10+00:00",
                      "firstSeen": "2026-10-19T08:33:39+00:00",
                      "lastCheckedAt": "%s",
                      "lastAction": "df reported 97%%"
                    }
                  }
                }
                """
            )
            % NOW.isoformat()
        )
        return root

    def test_lox_only_critical_is_counted(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = self._write_workspace(Path(tmp))
            queue = iq.build_queue(workspace=root, now=NOW)
            self.assertEqual(queue["counts"]["reportable"], 2)
            self.assertEqual(queue["counts"]["actionable"], 1)
            self.assertEqual(queue["actionable"][0]["identity"], "lox-critical")
            self.assertEqual(queue["actionable"][0]["escalatedAt"], "2026-10-19T11:19:10+00:00")


if __name__ == "__main__":
    unittest.main()
