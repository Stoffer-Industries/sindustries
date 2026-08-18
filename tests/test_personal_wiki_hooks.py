#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
BOOKMARK_SCRIPTS = REPO / "agents" / "workflows" / "bookmarks" / "scripts"
WIKI_MODULE = REPO / "agents" / "workflows" / "wiki" / "wiki_catalog.py"
if str(BOOKMARK_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(BOOKMARK_SCRIPTS))

import common
import lobster_summarize as summarize_mod
import validate_spec_output as validate_spec_output_mod


def load_wiki_module(workspace: Path):
    os.environ["OPENCLAW_WORKSPACE"] = str(workspace)
    spec = importlib.util.spec_from_file_location(f"wiki_catalog_{workspace.name}", WIKI_MODULE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class PersonalWikiHookTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_path = self.root / "brain" / "state" / "bookmark-review-state.json"
        self.state_root = self.state_path.parent
        self.transitions_path = self.state_root / "bookmark-transitions.jsonl"
        self.reviews_root = self.root / "brain" / "bookmarks" / "summaries"
        self.output_path = self.state_root / "spec-output.json"
        self.wiki = load_wiki_module(self.root)

    def _init_state(self, items: dict[str, dict]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        common.save_state({"version": 1, "updatedAt": common.now_iso(), "items": items, "approvalLocks": {}}, self.state_path)

    def _summary_candidate(self, key: str) -> dict:
        return {
            "bookmarkKey": key,
            "path": f"brain/bookmarks/infra/{key}.md",
            "topic": "infra",
            "source": "x",
            "title": f"Bookmark {key}",
            "link": "https://example.com/post",
            "tags": ["infra"],
            "type": "infra",
            "dateArchived": "2026-08-14",
            "bodyExcerpt": "excerpt",
            "body": "body",
        }

    def test_lobster_summarize_indexes_summary_before_state_transition(self):
        self._init_state({})
        llm_payload = {
            "headline": "A grounded summary",
            "problem": "p",
            "approach": "a",
            "valueProposition": "v",
            "keyDetails": ["k1"],
            "relevantTo": "r",
            "constraints": [],
        }
        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "STATE_PATH", self.state_path), \
             patch.object(summarize_mod, "wiki_upsert_entry", self.wiki.upsert_entry), \
             patch.object(summarize_mod, "event_key_for_payload", self.wiki.event_key_for_payload), \
             patch.object(summarize_mod, "invoke_llm_json", return_value=llm_payload), \
             patch.object(summarize_mod, "llm_provenance", return_value={"path": "test", "model": "test"}), \
             patch("sys.stdin", io.StringIO(json.dumps({"candidates": [self._summary_candidate("k1")]}))), \
             patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
            rc = summarize_mod.main()

        self.assertEqual(rc, 0)
        state = common.load_state(self.state_path)
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "summarized")
        index_text = (self.root / "brain/wiki/index.md").read_text(encoding="utf-8")
        self.assertIn("brain/bookmarks/summaries/bookmark-k1-k1.md", index_text)
        log_text = (self.root / "brain/wiki/log.md").read_text(encoding="utf-8")
        self.assertIn("ingest | brain/bookmarks/summaries/bookmark-k1-k1.md", log_text)

    def test_lobster_summarize_fails_closed_when_wiki_update_fails(self):
        self._init_state({})
        llm_payload = {
            "headline": "A grounded summary",
            "problem": "p",
            "approach": "a",
            "valueProposition": "v",
            "keyDetails": ["k1"],
            "relevantTo": "r",
            "constraints": [],
        }
        with patch.object(common, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "WORKSPACE", self.root), \
             patch.object(summarize_mod, "STATE_PATH", self.state_path), \
             patch.object(summarize_mod, "invoke_llm_json", return_value=llm_payload), \
             patch.object(summarize_mod, "llm_provenance", return_value={"path": "test", "model": "test"}), \
             patch.object(summarize_mod, "wiki_upsert_entry", side_effect=RuntimeError("wiki unavailable")), \
             patch("sys.stdin", io.StringIO(json.dumps({"candidates": [self._summary_candidate("k1")]}))), \
             patch.object(sys, "argv", ["lobster_summarize.py", "--json", "--reviews-root", str(self.reviews_root)]):
            with self.assertRaises(RuntimeError):
                summarize_mod.main()

        state = common.load_state(self.state_path)
        self.assertEqual(state["items"], {})

    def test_validate_spec_output_indexes_specs_before_state_transition(self):
        self._init_state({"k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"}})
        spec_rel = "brain/bookmarks/specs/example-k1.md"
        spec_path = self.root / spec_rel
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(
            "# Spec — Example\n\n- [ ] **Approved by Tom**\n\n## Outcome\n\nShip the grounded recall path.\n\n## Acceptance Criteria\n\n- [ ] AC1\n",
            encoding="utf-8",
        )
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "bookmarkKey": "k1",
                            "requestType": "new",
                            "specs": [{
                                "title": "Example",
                                "specDoc": spec_rel,
                                "classification": "feature",
                                "classification_rationale": "Example spec for grounded recall path — product-facing feature work.",
                            }],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(common, "STATE_ROOT", self.state_root), \
             patch.object(common, "TRANSITIONS_PATH", self.transitions_path), \
             patch.object(common, "WORKSPACE", self.root), \
             patch.object(validate_spec_output_mod, "DEFAULT_OUTPUT", self.output_path), \
             patch.object(validate_spec_output_mod, "STATE_PATH", self.state_path), \
             patch.object(validate_spec_output_mod, "STATE_ROOT", self.state_root), \
             patch.object(validate_spec_output_mod, "WORKSPACE", self.root), \
             patch.object(validate_spec_output_mod, "wiki_upsert_entry", self.wiki.upsert_entry), \
             patch.object(validate_spec_output_mod, "event_key_for_payload", self.wiki.event_key_for_payload):
            rc = validate_spec_output_mod.main()

        self.assertEqual(rc, 0)
        state = common.load_state(self.state_path)
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "spec_created")
        index_text = (self.root / "brain/wiki/index.md").read_text(encoding="utf-8")
        self.assertIn(f"`{spec_rel}`", index_text)
        self.assertIn("Ship the grounded recall path.", index_text)

    def test_validate_spec_output_fails_closed_when_wiki_update_fails(self):
        self._init_state({"k1": {"bookmarkKey": "k1", "reviewStatus": "spec_requested"}})
        spec_rel = "brain/bookmarks/specs/example-k1.md"
        spec_path = self.root / spec_rel
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(
            "# Spec — Example\n\n- [ ] **Approved by Tom**\n\n## Outcome\n\nShip it.\n",
            encoding="utf-8",
        )
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "bookmarkKey": "k1",
                            "requestType": "new",
                            "specs": [{
                                "title": "Example",
                                "specDoc": spec_rel,
                                "classification": "feature",
                                "classification_rationale": "Example spec — needs Tom approval before any task exists.",
                            }],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        with patch.object(common, "STATE_PATH", self.state_path), \
             patch.object(common, "STATE_ROOT", self.state_root), \
             patch.object(common, "TRANSITIONS_PATH", self.transitions_path), \
             patch.object(common, "WORKSPACE", self.root), \
             patch.object(validate_spec_output_mod, "DEFAULT_OUTPUT", self.output_path), \
             patch.object(validate_spec_output_mod, "STATE_PATH", self.state_path), \
             patch.object(validate_spec_output_mod, "STATE_ROOT", self.state_root), \
             patch.object(validate_spec_output_mod, "WORKSPACE", self.root), \
             patch.object(validate_spec_output_mod, "wiki_upsert_entry", side_effect=RuntimeError("wiki unavailable")):
            with self.assertRaises(RuntimeError):
                validate_spec_output_mod.main()

        state = common.load_state(self.state_path)
        self.assertEqual(state["items"]["k1"]["reviewStatus"], "spec_requested")


if __name__ == "__main__":
    unittest.main()
