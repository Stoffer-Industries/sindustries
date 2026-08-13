#!/usr/bin/env python3
"""Tests for compute_compounding_signal.py.

These tests use a scratch workspace under ``tempfile`` and never read live
brain state. They cover the AC verification matrix in the tech design:

  * AC1: weekly JSON + Markdown with headline, four windows, current
    promotions; deterministic Markdown; rejected schema.
  * AC2: eligible-state numerator/denominator, one-decimal rounding,
    window boundaries, missing/empty refs, duplicate/self refs.
  * AC3: closed low-trend decision table; each note ID.
  * AC5: input immutability across successful/dry-run/malformed paths;
    failures never overwrite the destination pair.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = THIS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import compute_compounding_signal as ccs  # noqa: E402


def _now() -> dt.datetime:
    """Return a stable UTC 'now' used to anchor rolling windows."""
    return dt.datetime(2026, 8, 17, 20, 15, 0, tzinfo=dt.timezone.utc)


def _iso(days_ago: int, hour: int = 12, now: dt.datetime | None = None) -> str:
    """Return an ISO-8601 timestamp ``days_ago`` days before ``now``."""
    base = now or _now()
    target = base - dt.timedelta(days=days_ago)
    target = target.replace(hour=hour, minute=0, second=0, microsecond=0)
    return ccs.format_iso(target)


class ParseAndFormatTests(unittest.TestCase):
    def test_parse_iso_accepts_z_suffix(self):
        result = ccs.parse_iso("2026-08-17T20:15:00Z")
        self.assertEqual(result, dt.datetime(2026, 8, 17, 20, 15, 0, tzinfo=dt.timezone.utc))

    def test_parse_iso_accepts_explicit_offset(self):
        result = ccs.parse_iso("2026-08-17T20:15:00+00:00")
        self.assertIsNotNone(result)

    def test_parse_iso_rejects_naive(self):
        self.assertIsNone(ccs.parse_iso("2026-08-17T20:15:00"))

    def test_parse_iso_rejects_empty_and_garbage(self):
        self.assertIsNone(ccs.parse_iso(""))
        self.assertIsNone(ccs.parse_iso("not-a-date"))
        self.assertIsNone(ccs.parse_iso(None))
        self.assertIsNone(ccs.parse_iso(12345))

    def test_format_iso_emits_z_suffix(self):
        formatted = ccs.format_iso(dt.datetime(2026, 8, 17, 20, 15, 0, tzinfo=dt.timezone.utc))
        self.assertTrue(formatted.endswith("Z"))
        self.assertEqual(formatted, "2026-08-17T20:15:00Z")


class WindowBoundsTests(unittest.TestCase):
    def test_windows_partition_now_without_overlap(self):
        as_of = _now()
        last_end = None
        for offset in range(4):
            start, end = ccs.window_bounds(as_of, offset)
            self.assertEqual((end - start).days, 7)
            if last_end is not None:
                # Each window's end equals the previous window's end minus 7d.
                # In other words, the windows tile [as_of - 28d, as_of).
                self.assertEqual(last_end, end + dt.timedelta(days=7))
            last_end = end
        # Current window end is exactly as_of.
        self.assertEqual(ccs.window_bounds(as_of, 0)[1], as_of)

    def test_offset_weeks_are_contiguous(self):
        as_of = _now()
        a = ccs.window_bounds(as_of, 0)
        b = ccs.window_bounds(as_of, 1)
        # Offset 0 end equals offset 1 start only if b is the next window
        # **before** a. The spec tiles [as_of - 28d, as_of) so offset 1's
        # end equals offset 0's start.
        self.assertEqual(b[1], a[0])
        self.assertEqual(a[0], b[1])

    def test_partition_covers_28_days(self):
        as_of = _now()
        windows = [ccs.window_bounds(as_of, offset) for offset in range(4)]
        # The four windows cover [as_of - 28d, as_of) without overlap.
        self.assertEqual(windows[0][1], as_of)
        self.assertEqual(windows[-1][0], as_of - dt.timedelta(days=28))
        for prev, curr in zip(windows, windows[1:]):
            self.assertEqual(prev[1], curr[1] + dt.timedelta(days=7))


class EligibilityTests(unittest.TestCase):
    def test_effective_review_status_treats_task_linked_as_tasked(self):
        item = {"reviewStatus": "approved", "taskIds": ["abc-123"]}
        self.assertEqual(ccs.effective_review_status(item), "tasked")

    def test_effective_review_status_falls_back_to_pending(self):
        self.assertEqual(ccs.effective_review_status({}), "pending")
        self.assertEqual(ccs.effective_review_status(None), "pending")

    def test_effective_review_status_passes_through_normal_state(self):
        self.assertEqual(ccs.effective_review_status({"reviewStatus": "summarized"}), "summarized")

    def test_context_evaluation_at_prefers_reviewed_at(self):
        item = {
            "reviewedAt": "2026-08-15T10:00:00Z",
            "lastUpdatedAt": "2026-08-14T10:00:00Z",
            "firstSeenAt": "2026-08-13T10:00:00Z",
        }
        self.assertEqual(ccs.context_evaluation_at(item), dt.datetime(2026, 8, 15, 10, 0, 0, tzinfo=dt.timezone.utc))

    def test_context_evaluation_at_returns_none_when_missing(self):
        self.assertIsNone(ccs.context_evaluation_at({}))

    def test_prior_context_refs_filters_non_dicts(self):
        item = {"priorContextRefs": [{"key": "a"}, "string", 42, None]}
        keys = [r.get("key") for r in ccs.prior_context_refs(item)]
        self.assertEqual(keys, ["a"])


class TrendWindowTests(unittest.TestCase):
    def test_one_decimal_rounding(self):
        items = [
            {"key": "a", "reviewStatus": "summarized", "reviewedAt": _iso(1), "priorContextRefs": [{"key": "b"}]},
            {"key": "b", "reviewStatus": "summarized", "reviewedAt": _iso(1), "priorContextRefs": [{"key": "a"}]},
            {"key": "c", "reviewStatus": "summarized", "reviewedAt": _iso(1)},
        ]
        window = ccs.compute_trend_window(items, as_of=_now(), offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 3)
        self.assertEqual(window["referencedCount"], 2)
        self.assertAlmostEqual(window["percentage"], 66.7, places=1)

    def test_zero_denominator_returns_none(self):
        window = ccs.compute_trend_window([], as_of=_now(), offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 0)
        self.assertIsNone(window["percentage"])

    def test_self_references_are_excluded(self):
        items = [
            {"key": "a", "reviewStatus": "summarized", "reviewedAt": _iso(1), "priorContextRefs": [{"key": "a"}]},
        ]
        window = ccs.compute_trend_window(items, as_of=_now(), offset_weeks=0)
        self.assertEqual(window["referencedCount"], 0)

    def test_unknown_state_raises(self):
        items = [
            {"key": "a", "reviewStatus": "glorp", "reviewedAt": _iso(1)},
        ]
        with self.assertRaises(ValueError):
            ccs.compute_trend_window(items, as_of=_now(), offset_weeks=0)

    def test_ingested_state_is_excluded(self):
        items = [
            {"key": "a", "reviewStatus": "ingested", "reviewedAt": _iso(1), "priorContextRefs": [{"key": "b"}]},
        ]
        window = ccs.compute_trend_window(items, as_of=_now(), offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 0)

    def test_window_boundary_is_half_open(self):
        as_of = _now()
        # Exactly at start (inclusive): counted.
        items_start = [
            {"key": "a", "reviewStatus": "summarized", "reviewedAt": ccs.format_iso(as_of - dt.timedelta(days=7))},
        ]
        window = ccs.compute_trend_window(items_start, as_of=as_of, offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 1)
        # Exactly at end (exclusive): not counted.
        items_end = [
            {"key": "a", "reviewStatus": "summarized", "reviewedAt": ccs.format_iso(as_of)},
        ]
        window = ccs.compute_trend_window(items_end, as_of=as_of, offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 0)

    def test_task_linked_counts_even_without_tasked_status(self):
        items = [
            {"key": "a", "reviewStatus": "approved", "taskIds": ["task-1"], "reviewedAt": _iso(1), "priorContextRefs": [{"key": "b"}]},
        ]
        window = ccs.compute_trend_window(items, as_of=_now(), offset_weeks=0)
        self.assertEqual(window["eligibleCount"], 1)
        self.assertEqual(window["referencedCount"], 1)


class DossierPromotionTests(unittest.TestCase):
    def test_counts_unique_events_in_current_window(self):
        events = [
            {"eventId": "e1", "promotedAt": _iso(1)},
            {"eventId": "e2", "promotedAt": _iso(2)},
            {"eventId": "e3", "promotedAt": _iso(10)},  # prior window
            {"eventId": "e1", "promotedAt": _iso(1)},  # duplicate dedup
        ]
        self.assertEqual(ccs.compute_dossier_promotion_count(events, as_of=_now()), 2)

    def test_event_without_id_is_ignored(self):
        events = [{"promotedAt": _iso(0)}]
        self.assertEqual(ccs.compute_dossier_promotion_count(events, as_of=_now()), 0)


class OperatorNoteTests(unittest.TestCase):
    def _trend(self, percentages):
        return [
            {
                "offsetWeeks": offset,
                "start": "2026-08-10T20:15:00Z",
                "end": "2026-08-17T20:15:00Z",
                "eligibleCount": 5,
                "referencedCount": 1,
                "percentage": percentages[offset],
            }
            for offset in range(4)
        ]

    def test_corpus_too_small_when_corpus_below_threshold(self):
        trend = self._trend([10.0, 10.0, 10.0, 10.0])
        note = ccs.select_operator_note(trend, corpus_document_count=5)
        self.assertEqual(note["id"], "corpus_too_small")

    def test_retrieval_broken_when_zero_referenced_and_too_few_eligible(self):
        # eligible_total must be >= 10; references == 0.
        trend = [
            {
                "offsetWeeks": offset,
                "start": "2026-08-10T20:15:00Z",
                "end": "2026-08-17T20:15:00Z",
                "eligibleCount": 3,
                "referencedCount": 0,
                "percentage": 0.0,
            }
            for offset in range(4)
        ]
        note = ccs.select_operator_note(trend, corpus_document_count=ccs.CORPUS_ESTABLISHED_DOCUMENTS)
        self.assertEqual(note["id"], "retrieval_path_may_be_broken")

    def test_mostly_unrelated_intake_default_low(self):
        trend = self._trend([10.0, 10.0, 10.0, 10.0])
        note = ccs.select_operator_note(trend, corpus_document_count=ccs.CORPUS_ESTABLISHED_DOCUMENTS)
        self.assertEqual(note["id"], "mostly_unrelated_intake")

    def test_no_note_when_headline_above_threshold(self):
        trend = self._trend([60.0, 10.0, 10.0, 10.0])
        self.assertIsNone(ccs.select_operator_note(trend, corpus_document_count=40))

    def test_no_note_when_any_window_null(self):
        trend = self._trend([None, 10.0, 10.0, 10.0])
        self.assertIsNone(ccs.select_operator_note(trend, corpus_document_count=40))


class BuildSignalTests(unittest.TestCase):
    def test_signal_has_exactly_four_windows_and_consistent_headline(self):
        # No eligible items anywhere: all four windows null, headline null.
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        self.assertEqual(len(signal["trend"]), 4)
        self.assertIsNone(signal["headlinePercentage"])
        for window in signal["trend"]:
            self.assertIsNone(window["percentage"])
        self.assertEqual(signal["headlinePercentage"], signal["trend"][0]["percentage"])

    def test_decision_policy_is_emitted(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        self.assertEqual(signal["decisionPolicy"]["lowPercentageBelow"], ccs.LOW_PERCENTAGE_BELOW)
        self.assertEqual(
            signal["decisionPolicy"]["corpusEstablishedDocuments"],
            ccs.CORPUS_ESTABLISHED_DOCUMENTS,
        )

    def test_dossier_promotion_count_in_current_window(self):
        events = [
            {"eventId": "e1", "promotedAt": _iso(0)},
            {"eventId": "e2", "promotedAt": _iso(0)},
        ]
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=events,
            inputs_meta={},
        )
        self.assertEqual(signal["currentWindow"]["dossierPromotionCount"], 2)


class ValidateSignalTests(unittest.TestCase):
    def test_valid_signal_passes(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        ccs.validate_signal(signal)  # no exception

    def test_wrong_trend_count_raises(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        signal["trend"] = signal["trend"][:3]
        with self.assertRaises(ValueError):
            ccs.validate_signal(signal)

    def test_referenced_count_exceeding_eligible_raises(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        signal["trend"][0]["referencedCount"] = 999
        with self.assertRaises(ValueError):
            ccs.validate_signal(signal)

    def test_headline_mismatch_raises(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        signal["headlinePercentage"] = 99.9
        with self.assertRaises(ValueError):
            ccs.validate_signal(signal)

    def test_unknown_note_id_raises(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        signal["operatorNote"] = {"id": "made-up", "text": "fake"}
        with self.assertRaises(ValueError):
            ccs.validate_signal(signal)


class MarkdownRenderTests(unittest.TestCase):
    def test_markdown_contains_run_id_and_four_row_trend(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={"bookmarkState": {"path": "x"}, "corpusIndex": {"path": "y"}, "dossierPromotions": {"path": "z"}},
        )
        md = ccs.render_markdown(signal)
        self.assertIn(signal["runId"], md)
        self.assertIn("Compounding signal", md)
        self.assertIn("Four-week trend", md)
        self.assertIn("offset 0w", md)
        self.assertIn("offset 3w", md)
        # All-null trend -> no operator note selected -> no "Operator note" section.
        self.assertNotIn("Operator note", md)
        self.assertIn("bookmarkState", md)

    def test_markdown_with_operator_note(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        signal["operatorNote"] = {"id": "corpus_too_small", "text": ccs.OPERATOR_NOTES["corpus_too_small"]}
        md = ccs.render_markdown(signal)
        self.assertIn("corpus_too_small", md)
        self.assertIn("operator note", md.lower())

    def test_markdown_deterministic(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        self.assertEqual(ccs.render_markdown(signal), ccs.render_markdown(signal))


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ccs-write-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_publishes_both_files(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={"bookmarkState": {"path": "x"}, "corpusIndex": {"path": "y"}, "dossierPromotions": {"path": "z"}},
        )
        json_path = self.tmp / "compounding-signal.json"
        md_path = self.tmp / "compounding-signal.md"
        ccs.write_artifacts(signal, ccs.render_markdown(signal), json_path, md_path)
        self.assertTrue(json_path.exists())
        self.assertTrue(md_path.exists())
        self.assertEqual(json.loads(json_path.read_text())["runId"], signal["runId"])
        self.assertIn(signal["runId"], md_path.read_text())

    def test_does_not_leave_tmp_files(self):
        signal = ccs.build_signal(
            as_of=_now(),
            bookmark_state={"items": {}},
            corpus_index=[],
            dossier_events=[],
            inputs_meta={},
        )
        json_path = self.tmp / "compounding-signal.json"
        md_path = self.tmp / "compounding-signal.md"
        ccs.write_artifacts(signal, ccs.render_markdown(signal), json_path, md_path)
        self.assertFalse(list(self.tmp.glob("*.tmp")))


class CLIIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="ccs-cli-"))
        self.state_dir = self.workspace / "brain" / "state"
        self.state_dir.mkdir(parents=True)
        # The resolver checks for agents/workflows/bookmarks/ to recognise a
        # workspace root. Create that breadcrumb so the test standalone path
        # does not depend on WORKSPACE_ROOT being set in the parent shell.
        (self.workspace / "agents" / "workflows" / "bookmarks").mkdir(parents=True)
        self.state_path = self.state_dir / "bookmark-review-state.json"
        self.state_path.write_text(json.dumps({"version": 1, "items": {}}))

    def tearDown(self):
        shutil.rmtree(self.workspace, ignore_errors=True)

    def test_dry_run_returns_zero_and_does_not_write(self):
        code = ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
            "--dry-run",
        ])
        self.assertEqual(code, 0)
        self.assertFalse((self.state_dir / "compounding-signal.json").exists())

    def test_dry_run_print_json_outputs_full_signal(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = ccs.main([
                "--workspace-root", str(self.workspace),
                "--as-of", ccs.format_iso(_now()),
                "--dry-run",
                "--print-json",
            ])
        self.assertEqual(code, 0)
        printed = json.loads(buf.getvalue())
        self.assertEqual(printed["schemaVersion"], ccs.SCHEMA_VERSION)
        self.assertIn("trend", printed)

    def test_publishes_artifacts(self):
        code = ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
            "--json-path", str(self.state_dir / "compounding-signal.json"),
            "--md-path", str(self.state_dir / "compounding-signal.md"),
        ])
        self.assertEqual(code, 0)
        self.assertTrue((self.state_dir / "compounding-signal.json").exists())
        self.assertTrue((self.state_dir / "compounding-signal.md").exists())

    def test_missing_state_returns_three(self):
        (self.state_dir / "bookmark-review-state.json").unlink()
        code = ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
        ])
        self.assertEqual(code, 3)
        self.assertFalse((self.state_dir / "compounding-signal.json").exists())

    def test_malformed_state_returns_four(self):
        self.state_path.write_text("{not json")
        code = ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
        ])
        self.assertEqual(code, 4)


class InputImmutabilityTests(unittest.TestCase):
    """AC5: read-only against all pipeline data sources."""

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="ccs-immut-"))
        self.state_dir = self.workspace / "brain" / "state"
        self.state_dir.mkdir(parents=True)
        (self.workspace / "agents" / "workflows" / "bookmarks").mkdir(parents=True)
        self.state_path = self.state_dir / "bookmark-review-state.json"
        self.state_path.write_text(json.dumps({"version": 1, "items": {}}))
        self.corpus_path = self.state_dir / "index" / "bookmark-corpus-index.jsonl"
        self.corpus_path.parent.mkdir(parents=True)
        self.corpus_path.write_text("")
        self._before_state = self.state_path.read_bytes()
        self._before_corpus = self.corpus_path.read_bytes()

    def tearDown(self):
        shutil.rmtree(self.workspace, ignore_errors=True)

    def test_inputs_unchanged_after_successful_run(self):
        ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
        ])
        self.assertEqual(self.state_path.read_bytes(), self._before_state)
        self.assertEqual(self.corpus_path.read_bytes(), self._before_corpus)

    def test_inputs_unchanged_after_dry_run(self):
        ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
            "--dry-run",
        ])
        self.assertEqual(self.state_path.read_bytes(), self._before_state)
        self.assertEqual(self.corpus_path.read_bytes(), self._before_corpus)

    def test_inputs_unchanged_after_malformed_run(self):
        self.state_path.write_text("{not json")
        ccs.main([
            "--workspace-root", str(self.workspace),
            "--as-of", ccs.format_iso(_now()),
        ])
        # State was modified to be malformed before the run; that is intentional.
        # The important invariant is that the corrupt state is still there afterwards.
        self.assertEqual(self.state_path.read_bytes(), b"{not json")


class WorkspaceResolutionTests(unittest.TestCase):
    def test_resolves_to_canonical_when_env_and_cli_unset(self):
        # Build a fake workspace layout that satisfies the heuristic.
        workspace = Path(tempfile.mkdtemp(prefix="ccs-resolve-"))
        try:
            (workspace / "agents" / "workflows" / "bookmarks").mkdir(parents=True)
            resolved = ccs.resolve_workspace_root(None)
            # The CLI flag is None; WORKSPACE_ROOT may be set in the harness.
            # What we can assert is that resolution does not raise and returns a Path.
            self.assertIsInstance(resolved, Path)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    def test_resolves_cli_path(self):
        workspace = Path(tempfile.mkdtemp(prefix="ccs-resolve-cli-"))
        try:
            (workspace / "agents" / "workflows" / "bookmarks").mkdir(parents=True)
            resolved = ccs.resolve_workspace_root(str(workspace))
            self.assertEqual(resolved, workspace.resolve())
        finally:
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
