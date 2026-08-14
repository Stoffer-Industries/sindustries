#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
MODULE_PATH = REPO / "agents" / "workflows" / "wiki" / "wiki_catalog.py"


def load_module(workspace: Path):
    os.environ["OPENCLAW_WORKSPACE"] = str(workspace)
    name = f"wiki_catalog_test_{workspace.name}"
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class WikiCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.workspace = Path(self.tempdir.name)
        self.mod = load_module(self.workspace)

    def _write_source(self, rel: str, content: str = "# Doc\n\ncontent\n") -> Path:
        path = self.workspace / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_upsert_creates_index_and_dedupes_ingest_log_by_event_key(self):
        source = "brain/bookmarks/summaries/example-abc.md"
        self._write_source(source)
        event_key = self.mod.event_key_for_payload(
            "summary",
            {"source": source, "title": "Example", "summary": "One line"},
        )

        first = self.mod.upsert_entry("summary", source, "Example", "One line", event_key=event_key)
        second = self.mod.upsert_entry("summary", source, "Example", "One line", event_key=event_key)

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        index_text = (self.workspace / "brain/wiki/index.md").read_text(encoding="utf-8")
        self.assertIn("| summary | `brain/bookmarks/summaries/example-abc.md` | Example | One line |", index_text)
        log_text = (self.workspace / "brain/wiki/log.md").read_text(encoding="utf-8")
        self.assertEqual(log_text.count(f"Event-Key: {event_key}"), 1)
        self.assertEqual(log_text.count("ingest | brain/bookmarks/summaries/example-abc.md"), 1)

    def test_upsert_rejects_unsafe_path(self):
        rc = self.mod.main([
            "upsert",
            "--kind",
            "summary",
            "--source",
            "../outside.md",
            "--title",
            "Bad",
            "--summary",
            "Bad",
            "--json",
        ])
        self.assertEqual(rc, self.mod.EXIT_CONTRACT)

    def test_retarget_moves_unique_source_key_and_is_idempotent(self):
        old_source = "brain/bookmarks/specs/example.md"
        new_source = "brain/tasks/specs/in-progress/example.md"
        self._write_source(old_source, "# Spec\n\nold\n")
        self._write_source(new_source, "# Spec\n\nold\n")
        self.mod.upsert_entry("spec", old_source, "Example", "A spec row")

        first = self.mod.retarget_entry(old_source, new_source, event_key="retarget:1")
        second = self.mod.retarget_entry(old_source, new_source, event_key="retarget:1")

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        index_text = (self.workspace / "brain/wiki/index.md").read_text(encoding="utf-8")
        self.assertNotIn(f"`{old_source}`", index_text)
        self.assertEqual(index_text.count(f"`{new_source}`"), 1)
        log_text = (self.workspace / "brain/wiki/log.md").read_text(encoding="utf-8")
        self.assertIn(f"Moved-From: {old_source}", log_text)
        self.assertEqual(log_text.count("Event-Key: retarget:1"), 1)

    def test_read_source_requires_current_index_membership(self):
        source = "brain/bookmarks/summaries/example.md"
        self._write_source(source, "# Summary\n\nSupported\n")

        rc = self.mod.main(["read-source", "--source", source, "--json"])
        self.assertEqual(rc, self.mod.EXIT_MISSING_OR_UNINDEXED)

        self.mod.upsert_entry("summary", source, "Example", "Supported")
        payload = self.mod.read_source(source)
        self.assertTrue(payload["ok"])
        self.assertIn("Supported", payload["content"])

    def test_lint_reports_broken_rows_without_rewriting_index(self):
        source = "brain/bookmarks/summaries/example.md"
        self._write_source(source)
        self.mod.upsert_entry("summary", source, "Example", "Supported")
        index_path = self.workspace / "brain/wiki/index.md"
        before = index_path.read_text(encoding="utf-8")
        (self.workspace / source).unlink()

        payload, code = self.mod.lint_index()

        self.assertEqual(code, self.mod.EXIT_LINT_BROKEN)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["broken"], [{"source": source, "reason": "missing on disk"}])
        self.assertEqual(before, index_path.read_text(encoding="utf-8"))
        log_text = (self.workspace / "brain/wiki/log.md").read_text(encoding="utf-8")
        self.assertIn("lint | brain/wiki/index.md", log_text)
        self.assertIn("Broken-Path: brain/bookmarks/summaries/example.md (missing on disk)", log_text)

    def test_lint_logs_parser_failure(self):
        wiki_root = self.workspace / "brain/wiki"
        wiki_root.mkdir(parents=True, exist_ok=True)
        (wiki_root / "index.md").write_text("# Brain Wiki Index\n\nnot-a-table\n", encoding="utf-8")

        payload, code = self.mod.lint_index()

        self.assertEqual(code, self.mod.EXIT_CONTRACT)
        self.assertFalse(payload["ok"])
        log_text = (wiki_root / "log.md").read_text(encoding="utf-8")
        self.assertIn("Result: parser-error", log_text)


if __name__ == "__main__":
    unittest.main()
