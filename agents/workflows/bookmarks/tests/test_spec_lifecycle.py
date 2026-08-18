#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[4]
SCRIPTS = REPO / 'agents' / 'workflows' / 'bookmarks' / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
TASKS_API = REPO / 'agents' / 'skills' / 'ops' / 'tasks-api'
if str(TASKS_API) not in sys.path:
    sys.path.insert(0, str(TASKS_API))


def load_module(name: str, file_name: str, workspace: Path):
    os.environ['OPENCLAW_WORKSPACE'] = str(workspace)
    sys.modules.pop('common', None)
    sys.modules.pop('wiki_catalog', None)
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file_name)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class BookmarkSpecLifecycleTests(unittest.TestCase):
    def test_approval_toggle_checks_marker_without_moving_file(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            mod = load_module('handle_approval_reply_toggle_test', 'handle_approval_reply.py', workspace)
            spec = workspace / 'brain/bookmarks/specs/example-abcd1234.md'
            spec.parent.mkdir(parents=True)
            spec.write_text('# Spec\n\n- [ ] **Approved by Tom**\n', encoding='utf-8')

            changed = mod.set_spec_approval_checkbox('brain/bookmarks/specs/example-abcd1234.md', True)
            self.assertTrue(changed)
            self.assertTrue(spec.exists())
            self.assertIn('- [x] **Approved by Tom**', spec.read_text(encoding='utf-8'))
            self.assertFalse(mod.set_spec_approval_checkbox('brain/bookmarks/specs/example-abcd1234.md', True))

    def test_declined_toggle_does_not_check_marker(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            mod = load_module('handle_approval_reply_decline_test', 'handle_approval_reply.py', workspace)
            spec = workspace / 'brain/bookmarks/specs/example-abcd1234.md'
            spec.parent.mkdir(parents=True)
            spec.write_text('- [ ] **Approved by Tom**\n', encoding='utf-8')

            self.assertFalse(mod.set_spec_approval_checkbox('brain/bookmarks/specs/example-abcd1234.md', False))
            self.assertIn('- [ ] **Approved by Tom**', spec.read_text(encoding='utf-8'))

    def test_bookmark_task_creation_moves_spec_and_uses_destination_spec_line(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            mod = load_module('lobster_create_tasks_lifecycle_test', 'lobster_create_tasks_from_proposals.py', workspace)
            source_rel = 'brain/bookmarks/specs/example-abcd1234.md'
            source = workspace / source_rel
            source.parent.mkdir(parents=True)
            source.write_text(
                '# Spec — Example\n\n- [x] **Approved by Tom**\n\n## Outcome\nShip it.\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n',
                encoding='utf-8',
            )
            seen_payloads = []
            wiki = load_module('wiki_catalog_lifecycle_test', '../../wiki/wiki_catalog.py', workspace)
            wiki.upsert_entry('spec', source_rel, 'Example', 'Ship it')

            def fake_api(method, base_url, path, payload=None, *, token=None):
                seen_payloads.append((method, path, payload))
                if method == 'POST':
                    return {'data': {'id': 'task-1', 'description': payload['description'], 'tags': payload['tags']}}
                if method == 'PATCH':
                    return {'data': {'id': 'task-1'}}
                return {'data': {'id': 'task-1', 'description': ''}}

            with mock.patch.object(mod, 'api_request', side_effect=fake_api):
                result, error = mod.create_task_for_spec('http://tasks', 'agent-tools', 'abcd1234', source_rel, [source_rel], {})

            self.assertIsNone(error)
            self.assertIsNotNone(result)
            dest_rel = 'brain/tasks/specs/in-progress/example-abcd1234.md'
            self.assertEqual(result['specDoc'], dest_rel)
            self.assertFalse(source.exists())
            self.assertTrue((workspace / dest_rel).exists())
            post_payload = seen_payloads[0][2]
            self.assertIn(f'**Spec:** {dest_rel}', post_payload['description'])
            index_text = (workspace / 'brain/wiki/index.md').read_text(encoding='utf-8')
            self.assertNotIn(f'`{source_rel}`', index_text)
            self.assertIn(f'`{dest_rel}`', index_text)

    def test_bookmark_task_creation_seeds_wiki_entry_for_unindexed_legacy_spec(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            mod = load_module('lobster_create_tasks_legacy_wiki_test', 'lobster_create_tasks_from_proposals.py', workspace)
            source_rel = 'brain/bookmarks/specs/example-abcd1234.md'
            source = workspace / source_rel
            source.parent.mkdir(parents=True)
            source.write_text(
                '# Spec — Example\n\n- [x] **Approved by Tom**\n\n## Outcome\nShip it.\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n',
                encoding='utf-8',
            )
            # Deliberately do NOT seed the wiki index for source_rel — this
            # reproduces a spec created before validate_spec_output.py wired
            # in wiki_upsert_entry (2026-08-14), so old_source was never
            # indexed. retarget_entry alone would hard-fail here even though
            # the task and file move below succeed.
            load_module('wiki_catalog_legacy_wiki_test', '../../wiki/wiki_catalog.py', workspace)

            def fake_api(method, base_url, path, payload=None, *, token=None):
                if method == 'POST':
                    return {'data': {'id': 'task-1', 'description': payload['description'], 'tags': payload['tags']}}
                if method == 'PATCH':
                    return {'data': {'id': 'task-1'}}
                return {'data': {'id': 'task-1', 'description': ''}}

            with mock.patch.object(mod, 'api_request', side_effect=fake_api):
                result, error = mod.create_task_for_spec('http://tasks', 'agent-tools', 'abcd1234', source_rel, [source_rel], {})

            self.assertIsNone(error)
            self.assertIsNotNone(result)
            dest_rel = 'brain/tasks/specs/in-progress/example-abcd1234.md'
            self.assertEqual(result['specDoc'], dest_rel)
            self.assertFalse(source.exists())
            self.assertTrue((workspace / dest_rel).exists())
            index_text = (workspace / 'brain/wiki/index.md').read_text(encoding='utf-8')
            self.assertIn(f'`{dest_rel}`', index_text)
            self.assertIn('Example', index_text)
            self.assertIn('Ship it.', index_text)

    def test_bookmark_move_is_idempotent_and_repairs_stale_spec_line_for_existing_task(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            mod = load_module('lobster_create_tasks_idempotent_test', 'lobster_create_tasks_from_proposals.py', workspace)
            source_rel = 'brain/bookmarks/specs/example-abcd1234.md'
            dest_rel = 'brain/tasks/specs/in-progress/example-abcd1234.md'
            source = workspace / source_rel
            source.parent.mkdir(parents=True)
            source.write_text('# Spec — Example\n', encoding='utf-8')
            dest = workspace / dest_rel
            dest.parent.mkdir(parents=True)
            dest.write_text('# Spec — Example\n', encoding='utf-8')
            patched = []
            wiki = load_module('wiki_catalog_idempotent_test', '../../wiki/wiki_catalog.py', workspace)
            wiki.upsert_entry('spec', source_rel, 'Example', 'Ship it')
            source.unlink()

            def fake_api(method, base_url, path, payload=None, *, token=None):
                if method == 'GET':
                    return {'data': {'id': 'task-1', 'description': f'**Spec:** {source_rel}\n'}}
                if method == 'PATCH':
                    patched.append(payload['description'])
                    return {'data': {'id': 'task-1'}}
                raise AssertionError(method)

            existing = {mod.spec_marker(source_rel): {'id': 'task-1', 'description': f'**Spec:** {source_rel}\n', 'tags': []}}
            with mock.patch.object(mod, 'api_request', side_effect=fake_api):
                result, error = mod.create_task_for_spec('http://tasks', 'agent-tools', 'abcd1234', source_rel, [source_rel], existing)

            self.assertIsNone(error)
            self.assertEqual(result['specDoc'], dest_rel)
            self.assertEqual(patched, [f'**Spec:** {dest_rel}'])
            index_text = (workspace / 'brain/wiki/index.md').read_text(encoding='utf-8')
            self.assertNotIn(f'`{source_rel}`', index_text)
            self.assertEqual(index_text.count(f'`{dest_rel}`'), 1)


if __name__ == '__main__':
    unittest.main()
