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
SCRIPTS = REPO / 'agents' / 'workflows' / 'bookmarks' / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
BOOKMARKS_ROOT = REPO / 'agents' / 'workflows' / 'bookmarks'
if str(BOOKMARKS_ROOT) not in sys.path:
    sys.path.insert(0, str(BOOKMARKS_ROOT))
WIKI_ROOT = REPO / 'agents' / 'workflows' / 'wiki'
if str(WIKI_ROOT) not in sys.path:
    sys.path.insert(0, str(WIKI_ROOT))


def load_module(name: str, file_name: str, workspace: Path):
    os.environ['OPENCLAW_WORKSPACE'] = str(workspace)
    for stale in ('common', 'wiki_catalog', 'bookmark_state_machine', 'classification_schema'):
        sys.modules.pop(stale, None)
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file_name)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ValidateSpecOutputMarkerTests(unittest.TestCase):
    def _seed_state(self, workspace: Path, bookmark_key: str) -> None:
        state_path = workspace / 'brain' / 'state' / 'bookmark-review-state.json'
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({
            'version': 1,
            'items': {
                bookmark_key: {
                    'bookmarkKey': bookmark_key,
                    'reviewStatus': 'spec_requested',
                },
            },
            'approvalLocks': {},
        }), encoding='utf-8')

    def _artifact(self, bookmark_key: str, spec_doc: str) -> dict:
        return {
            'entries': [
                {
                    'bookmarkKey': bookmark_key,
                    'requestType': 'new',
                    'specs': [
                        {
                            'title': 'Example',
                            'specDoc': spec_doc,
                            'classification': 'feature',
                            'classification_rationale': 'because',
                        },
                    ],
                },
            ],
        }

    def test_spec_missing_marker_is_rejected_and_state_not_advanced(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            self._seed_state(workspace, 'abcd1234')
            spec_rel = 'brain/bookmarks/specs/example-abcd1234.md'
            spec = workspace / spec_rel
            spec.parent.mkdir(parents=True)
            spec.write_text('# Spec — Example\n\n**Status:** Draft\n\n## Outcome\nShip it.\n', encoding='utf-8')

            artifact_path = workspace / 'brain' / 'state' / 'spec-output.json'
            artifact_path.write_text(json.dumps(self._artifact('abcd1234', spec_rel)), encoding='utf-8')

            mod = load_module('validate_spec_output_missing_marker_test', 'validate_spec_output.py', workspace)
            exit_code = mod.main(['--input', str(artifact_path), '--json'])

            self.assertEqual(exit_code, 0)
            state = mod.load_state(Path(mod.STATE_PATH))
            self.assertEqual(state['items']['abcd1234']['reviewStatus'], 'spec_requested')
            # Artifact must remain for a fixed re-run, not be silently consumed.
            self.assertTrue(artifact_path.exists())

    def test_spec_with_unchecked_marker_is_applied(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            self._seed_state(workspace, 'abcd1234')
            spec_rel = 'brain/bookmarks/specs/example-abcd1234.md'
            spec = workspace / spec_rel
            spec.parent.mkdir(parents=True)
            spec.write_text(
                '# Spec — Example\n\n**Status:** Draft\n- [ ] **Approved by Tom**\n\n## Outcome\nShip it.\n',
                encoding='utf-8',
            )

            artifact_path = workspace / 'brain' / 'state' / 'spec-output.json'
            artifact_path.write_text(json.dumps(self._artifact('abcd1234', spec_rel)), encoding='utf-8')

            mod = load_module('validate_spec_output_with_marker_test', 'validate_spec_output.py', workspace)
            exit_code = mod.main(['--input', str(artifact_path), '--json'])

            self.assertEqual(exit_code, 0)
            state = mod.load_state(Path(mod.STATE_PATH))
            self.assertEqual(state['items']['abcd1234']['reviewStatus'], 'spec_created')
            self.assertFalse(artifact_path.exists())
            self.assertTrue((artifact_path.with_name(artifact_path.name + '.processed')).exists())


if __name__ == '__main__':
    unittest.main()
