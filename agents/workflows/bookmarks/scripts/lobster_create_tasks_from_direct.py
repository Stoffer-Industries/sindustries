#!/usr/bin/env python3
"""Create Tasks API tasks from `/directCreateItems` in the bookmark pipeline.

Task 536e04fc WS3 — direct-create route.

This script is the consumer for the `directCreateItems` slice emitted by
`lobster_request_spec_approval.py` when its classification routing
determines that none of an item's specs require Tom's approval (all specs
are `code` or `research`). It runs unconditionally in the pipeline (no
approval gate), bypassing the approval flow so a code/research spec
becomes a task in one cron tick instead of waiting for human review.

Output payload shape (per `lobster_request_spec_approval.py`):

  directCreateItems: [
    {
      "bookmarkKey": "...",
      "topic": "...",
      "title": "...",
      "specDocs": [...],
      "tasks": [
        {
          "title": "...",
          "type": "code" | "research",
          "specDoc": "brain/bookmarks/specs/foo.md",
          "bookmarkKey": "...",
          "classification_rationale": "...",
        },
      ],
    },
  ]

For each task, we POST to the Tasks API with `taskType` matching the
classification (so the sort `taskType=code` or `taskType=research` filter
hits it from the dashboard). The description points at the spec doc so
the implementer can find the source of truth.

Dedup: we keep the same per-spec-tags scheme the approval flow uses
(`spec-task:<sha1>`) so re-running the pipeline does not duplicate
existing tasks.
"""
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

from tasks_api_client import api_request, list_tasks, service_token_env  # noqa: E402

# Per-agent service credential for the tasks-api mutation surface
# (task 0719a8e3). Same BOOKMARK_LOBSTER_TOKEN the approval-flow consumer
# uses. Falls back to TASKS_API_APPROVAL_TOKEN when unset.
BOOKMARK_LOBSTER_TOKEN = service_token_env('BOOKMARK_LOBSTER_TOKEN')

TASK_SPECS_IN_PROGRESS = 'brain/tasks/specs/in-progress'
BOOKMARK_SPECS_PREFIX = 'brain/bookmarks/specs/'


def spec_marker(spec_doc: str) -> str:
    """Stable dedup marker based on spec doc path.

    Mirrors `lobster_create_tasks_from_proposals.spec_marker` so the
    direct-route and approval-route share dedup keys; an item that flips
    from feature to code (or vice versa) keeps the same taskId.
    """
    digest = hashlib.sha1(spec_doc.encode('utf-8')).hexdigest()[:16]
    return f'spec-task:{digest}'


def task_spec_destination(spec_doc: str) -> str:
    rel = str(spec_doc).strip()
    if rel.startswith(f'{TASK_SPECS_IN_PROGRESS}/'):
        return rel
    if not rel.startswith(BOOKMARK_SPECS_PREFIX):
        return rel
    return f'{TASK_SPECS_IN_PROGRESS}/{Path(rel).name}'


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


def _extract_section(text: str, heading: str) -> str:
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
            if isinstance(tag, str) and tag.startswith('spec-task:'):
                indexed[tag] = task
    return indexed


def create_task_for_direct(
    base_url: str,
    topic: str,
    bookmark_key: str,
    spec_doc: str,
    spec_docs: list[str],
    task_type: str,
    classification_rationale: str | None,
    existing_by_marker: dict[str, dict],
) -> tuple[dict | None, dict | None]:
    """Create (or reuse) a task for a single direct-routed spec.

    Returns (created, error). When the marker exists, returns
    `reused: True` and moves the spec to in-progress if needed.
    """
    task_spec_doc = task_spec_destination(spec_doc)
    marker = spec_marker(task_spec_doc)
    legacy_marker = spec_marker(spec_doc)
    existing = existing_by_marker.get(marker) or existing_by_marker.get(legacy_marker)
    if existing and existing.get('id'):
        try:
            moved_doc, moved = move_bookmark_spec_to_task_in_progress(spec_doc)
        except FileNotFoundError:
            # Backward-compatible reuse path; the source spec is gone but the
            # task already exists. The next pipeline run will still see the
            # marker, so this branch is safe.
            moved_doc, moved = spec_doc, False
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
            'taskType': task_type,
        }, None

    spec_def = build_task_from_spec(spec_doc, task_spec_doc, bookmark_key, topic)
    if spec_def is None:
        return None, {
            'bookmarkKey': bookmark_key,
            'topic': topic,
            'specDoc': spec_doc,
            'marker': marker,
            'error': f'spec file not found: {spec_doc}',
        }

    payload = {
        'title': spec_def['title'],
        'description': spec_def['description'],
        'priority': spec_def['priority'],
        'status': 'open',
        'taskType': task_type,
        'tags': task_tags(topic, bookmark_key, [task_spec_destination(d) for d in spec_docs], marker),
    }
    if classification_rationale:
        # Carry the WS3 rationale through to the task as a tag so reviewers
        # can audit *why* the classifier routed this spec to direct-create.
        payload['tags'].append(f'classification-rationale:{classification_rationale[:120]}')

    response = api_request('POST', base_url, '/tasks', payload, token=BOOKMARK_LOBSTER_TOKEN)
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
        'title': spec_def['title'],
        'taskId': str(task_id),
        'taskType': task_type,
        'reused': False,
        'moved': moved,
        'marker': marker,
    }
    existing_by_marker[marker] = task if isinstance(task, dict) else {'id': task_id, 'tags': payload['tags']}
    return created, None


def main() -> int:
    p = argparse.ArgumentParser(description='Create Tasks API tasks from direct-routed bookmark specs')
    p.add_argument('--base-url', default='')
    p.add_argument('--json', action='store_true')
    args = p.parse_args()

    data = json.load(sys.stdin)
    base_url = args.base_url.strip() or (os.getenv('TASKS_API_BASE_URL') or '').strip()
    if not base_url:
        raise SystemExit('--base-url or TASKS_API_BASE_URL is required')

    direct_items = data.get('directCreateItems') or []
    existing_by_marker = existing_tasks_by_marker(base_url)

    created: list[dict] = []
    errors: list[dict] = []
    for item in direct_items:
        bookmark_key = item.get('bookmarkKey') or ''
        topic = item.get('topic') or 'general'
        spec_docs = item.get('specDocs') or []
        for task in item.get('tasks') or []:
            spec_doc = task.get('specDoc')
            task_type = task.get('type')
            if task_type not in ('code', 'research'):
                # Defensive: routing layer should never emit anything else,
                # but if a corrupt spec_payload ever reaches us, fail
                # closed instead of silently demoting to feature.
                errors.append({
                    'bookmarkKey': bookmark_key,
                    'topic': topic,
                    'specDoc': spec_doc,
                    'error': f'direct-create task type must be code or research, got {task_type!r}',
                })
                continue
            if not spec_doc:
                errors.append({
                    'bookmarkKey': bookmark_key,
                    'topic': topic,
                    'error': 'direct-create task missing specDoc',
                })
                continue
            result, error = create_task_for_direct(
                base_url,
                topic,
                bookmark_key,
                spec_doc,
                spec_docs,
                task_type,
                task.get('classification_rationale'),
                existing_by_marker,
            )
            if result:
                created.append(result)
            if error:
                errors.append(error)

    dump_json({
        'ok': len(errors) == 0,
        'generatedAt': now_iso(),
        'created': created,
        'errors': errors,
        'directCreateItems': direct_items,
    })
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
