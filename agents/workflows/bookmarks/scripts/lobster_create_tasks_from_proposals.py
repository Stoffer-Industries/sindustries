#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from common import WORKSPACE, dump_json, now_iso

SCRIPT_ROOT = WORKSPACE / "codebases" / "sindustries" / "agents" / "skills" / "ops" / "tasks-api"
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from tasks_api_client import api_request, list_tasks  # noqa: E402


TASK_SPECS_IN_PROGRESS = 'brain/tasks/specs/in-progress'
BOOKMARK_SPECS_PREFIX = 'brain/bookmarks/specs/'


def task_spec_destination(spec_doc: str) -> str:
    rel = str(spec_doc).strip()
    if rel.startswith(f'{TASK_SPECS_IN_PROGRESS}/'):
        return rel
    if not rel.startswith(BOOKMARK_SPECS_PREFIX):
        return rel
    return f'{TASK_SPECS_IN_PROGRESS}/{Path(rel).name}'


def rewrite_spec_line(description: str, old_path: str, new_path: str) -> str:
    pattern = re.compile(r'(?m)^(\s*\*\*Spec:\*\*\s+)([^\s].*?)\s*$')
    return pattern.sub(
        lambda match: f'{match.group(1)}{new_path}' if match.group(2).strip() == old_path else match.group(0),
        description,
        count=1,
    )


def move_bookmark_spec_to_task_in_progress(spec_doc: str) -> tuple[str, bool]:
    dest_doc = task_spec_destination(spec_doc)
    if dest_doc == spec_doc:
        return dest_doc, False
    source = WORKSPACE / spec_doc
    dest = WORKSPACE / dest_doc
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if source.exists() and source.read_bytes() != dest.read_bytes():
            raise RuntimeError(f'destination already exists with different content: {dest_doc}')
        return dest_doc, False
    if not source.exists():
        raise FileNotFoundError(f'spec file not found: {spec_doc}')
    source.rename(dest)
    return dest_doc, True


def patch_task_spec_line(base_url: str, task_id: str, old_path: str, new_path: str, task: dict | None = None) -> None:
    task_data = task or {}
    if not task_data.get('description'):
        resp = api_request('GET', base_url, f'/tasks/{task_id}')
        task_data = resp.get('data') if isinstance(resp, dict) else resp
        if not isinstance(task_data, dict):
            return
    desc = str(task_data.get('description') or '')
    new_desc = rewrite_spec_line(desc, old_path, new_path)
    if new_desc != desc:
        api_request('PATCH', base_url, f'/tasks/{task_id}', {'description': new_desc})


def proposal_marker(bookmark_key: str, spec_docs: list[str], proposal: dict) -> str:
    """Legacy marker for per-proposedTask dedup. Kept for backward compat with existing tasks."""
    payload = {
        'bookmarkKey': bookmark_key,
        'specDocs': sorted(spec_docs),
        'title': proposal.get('title') or '',
        'priority': proposal.get('priority') or 'medium',
        'description': proposal.get('description') or '',
    }
    digest = hashlib.sha1(json.dumps(payload, sort_keys=True).encode('utf-8')).hexdigest()[:16]
    return f'proposal:{digest}'


def spec_marker(spec_doc: str) -> str:
    """Stable dedup marker based on spec doc path."""
    digest = hashlib.sha1(spec_doc.encode('utf-8')).hexdigest()[:16]
    return f'spec-task:{digest}'


def task_tags(topic: str, bookmark_key: str, spec_docs: list[str], marker: str) -> list[str]:
    tags = [
        'source:bookmark-review-pipeline',
        f'topic:{topic}',
        f'bookmark:{bookmark_key}',
        marker,
    ]
    for spec_doc in spec_docs:
        tags.append(f'spec:{spec_doc}')
    return tags


def task_reusable(task: dict) -> bool:
    status = str(task.get('status') or '').strip().lower()
    if task.get('completedAt') or task.get('archivedAt'):
        return False
    if status == 'done':
        return False
    return True


def existing_tasks_by_marker(base_url: str, limit: int = 500) -> dict[str, dict]:
    indexed = {}
    for task in list_tasks(limit=limit, base_url=base_url):
        if not task_reusable(task):
            continue
        tags = task.get('tags')
        if not isinstance(tags, list):
            continue
        for tag in tags:
            if isinstance(tag, str) and (tag.startswith('proposal:') or tag.startswith('spec-task:')):
                indexed[tag] = task
    return indexed


def _extract_section(text: str, heading: str) -> str:
    """Extract content under a markdown ## heading."""
    pattern = re.compile(rf'^## {re.escape(heading)}\s*\n', re.MULTILINE)
    match = pattern.search(text)
    if not match:
        return ''
    section = text[match.end():]
    next_h = re.search(r'^## ', section, re.MULTILINE)
    return (section[:next_h.start()] if next_h else section).strip()


def build_task_from_spec(spec_doc: str, task_spec_doc: str, bookmark_key: str, topic: str) -> dict | None:
    """Read a spec markdown file and build a task dict (title + description)."""
    spec_path = WORKSPACE / spec_doc
    if not spec_path.exists():
        return None

    text = spec_path.read_text(encoding='utf-8')

    # Title from first # heading
    title_match = re.search(r'^#\s+Spec\s*[—–-]+\s*(.+)$', text, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else spec_path.stem.replace('-', ' ').title()

    acs = _extract_section(text, 'Acceptance Criteria')
    notes = _extract_section(text, 'Notes')
    outcome = _extract_section(text, 'Outcome')

    parts = [
        f'**Spec:** {task_spec_doc}',
        f'**Topic:** {topic}',
        f'**Bookmark:** {bookmark_key}',
    ]
    if outcome:
        parts += ['', '---', '', outcome]
    if acs:
        parts += ['', '## Acceptance Criteria', '', acs]
    if notes:
        parts += ['', '## Notes', '', notes]

    return {
        'title': title,
        'description': '\n'.join(parts),
        'priority': 'high',
    }


def create_task_for_spec(
    base_url: str,
    topic: str,
    bookmark_key: str,
    spec_doc: str,
    spec_docs: list[str],
    existing_by_marker: dict[str, dict],
) -> tuple[dict | None, dict | None]:
    task_spec_doc = task_spec_destination(spec_doc)
    marker = spec_marker(task_spec_doc)
    legacy_marker = spec_marker(spec_doc)
    existing = existing_by_marker.get(marker) or existing_by_marker.get(legacy_marker)
    if existing and existing.get('id'):
        try:
            moved_doc, moved = move_bookmark_spec_to_task_in_progress(spec_doc)
            patch_task_spec_line(base_url, str(existing['id']), spec_doc, moved_doc, existing)
        except Exception as exc:  # noqa: BLE001
            return None, {
                'bookmarkKey': bookmark_key,
                'topic': topic,
                'specDoc': spec_doc,
                'marker': marker,
                'error': str(exc),
            }
        return {
            'bookmarkKey': bookmark_key,
            'topic': topic,
            'specDoc': moved_doc,
            'sourceSpecDoc': spec_doc,
            'taskId': str(existing['id']),
            'reused': True,
            'moved': moved,
            'marker': marker,
        }, None

    task_def = build_task_from_spec(spec_doc, task_spec_doc, bookmark_key, topic)
    if not task_def:
        return None, {
            'bookmarkKey': bookmark_key,
            'topic': topic,
            'specDoc': spec_doc,
            'marker': marker,
            'error': f'spec file not found: {spec_doc}',
        }

    payload = {
        'title': task_def['title'],
        'description': task_def['description'],
        'priority': task_def['priority'],
        'status': 'open',
        'tags': task_tags(topic, bookmark_key, [task_spec_destination(d) for d in spec_docs], marker),
    }
    response = api_request('POST', base_url, '/tasks', payload)
    task = response.get('data') if isinstance(response, dict) else None
    task_id = task.get('id') if isinstance(task, dict) else None
    if task_id is None:
        return None, {
            'bookmarkKey': bookmark_key,
            'topic': topic,
            'specDoc': spec_doc,
            'marker': marker,
            'error': 'Tasks API response did not include data.id',
            'response': response,
        }

    try:
        moved_doc, moved = move_bookmark_spec_to_task_in_progress(spec_doc)
        if moved_doc != task_spec_doc:
            patch_task_spec_line(base_url, str(task_id), task_spec_doc, moved_doc, task if isinstance(task, dict) else None)
    except Exception as exc:  # noqa: BLE001
        return None, {
            'bookmarkKey': bookmark_key,
            'topic': topic,
            'specDoc': spec_doc,
            'marker': marker,
            'taskId': str(task_id),
            'error': str(exc),
        }

    created = {
        'bookmarkKey': bookmark_key,
        'topic': topic,
        'specDoc': moved_doc,
        'sourceSpecDoc': spec_doc,
        'title': task_def['title'],
        'taskId': str(task_id),
        'reused': False,
        'moved': moved,
        'marker': marker,
    }
    existing_by_marker[marker] = task if isinstance(task, dict) else {'id': task_id, 'tags': payload['tags']}
    return created, None


def main() -> int:
    p = argparse.ArgumentParser(description='Create Tasks API tasks from approved bookmark specs')
    p.add_argument('--base-url', default='')
    p.add_argument('--json', action='store_true')
    args = p.parse_args()

    data = json.load(__import__('sys').stdin)
    base_url = args.base_url.strip() or (os.getenv('TASKS_API_BASE_URL') or '').strip() or 'http://localhost:4000/api/v1'
    existing_by_marker = existing_tasks_by_marker(base_url)

    created = []
    errors = []
    approvals = data.get('approvals')
    if approvals is None:
        approvals = data.get('readyPackages', [])

    for approval in approvals:
        topic = approval.get('topic') or 'general'
        for item in approval.get('items', []):
            bookmark_key = item.get('bookmarkKey') or ''
            spec_docs = item.get('specDocs') or []
            for spec_doc in spec_docs:
                result, error = create_task_for_spec(
                    base_url, topic, bookmark_key, spec_doc, spec_docs, existing_by_marker
                )
                if result:
                    created.append(result)
                    if result.get('sourceSpecDoc') and result.get('specDoc'):
                        item['specDocs'] = [result['specDoc'] if d == result['sourceSpecDoc'] else d for d in spec_docs]
                if error:
                    errors.append(error)

    dump_json({
        'ok': len(errors) == 0,
        'generatedAt': now_iso(),
        'created': created,
        'errors': errors,
        'approvals': approvals,
        'blockedPackages': data.get('blockedPackages', []),
        'monitoring': data.get('monitoring', []),
        'reviewed': data.get('reviewed', []),
    })
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
