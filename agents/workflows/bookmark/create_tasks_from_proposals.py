#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from common import dump_json, now_iso

SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from tasks_api_client import api_request, list_tasks  # noqa: E402


def proposal_marker(bookmark_key: str, spec_docs: list[str], proposal: dict) -> str:
    payload = {
        'bookmarkKey': bookmark_key,
        'specDocs': sorted(spec_docs),
        'title': proposal.get('title') or '',
        'priority': proposal.get('priority') or 'medium',
        'description': proposal.get('description') or '',
    }
    digest = hashlib.sha1(json.dumps(payload, sort_keys=True).encode('utf-8')).hexdigest()[:16]
    return f'proposal:{digest}'


def task_tags(topic: str, bookmark_key: str, spec_docs: list[str], proposal: dict) -> list[str]:
    tags = [
        'source:bookmark-review-pipeline',
        f'topic:{topic}',
        f'bookmark:{bookmark_key}',
        proposal_marker(bookmark_key, spec_docs, proposal),
    ]
    for spec_doc in spec_docs:
        tags.append(f'spec:{spec_doc}')
    return tags


def task_reusable(task: dict) -> bool:
    status = str(task.get('status') or '').strip().lower()
    completed_at = task.get('completedAt')
    archived_at = task.get('archivedAt')
    if completed_at or archived_at:
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
            if isinstance(tag, str) and tag.startswith('proposal:'):
                indexed[tag] = task
    return indexed


def extract_proposed_tasks(item: dict) -> list[dict]:
    direct = item.get('proposedTasks')
    if isinstance(direct, list) and direct:
        return [task for task in direct if isinstance(task, dict)]

    nested: list[dict] = []
    for proposal in item.get('specProposals') or []:
        tasks = proposal.get('proposedTasks')
        if isinstance(tasks, list):
            nested.extend(task for task in tasks if isinstance(task, dict))
    return nested


def create_task(base_url: str, topic: str, item: dict, proposal: dict, existing_by_marker: dict[str, dict]) -> tuple[dict | None, dict | None]:
    spec_docs = item.get('specDocs', [])
    marker = proposal_marker(item['bookmarkKey'], spec_docs, proposal)
    existing = existing_by_marker.get(marker)
    if existing and existing.get('id'):
        return {
            'bookmarkKey': item['bookmarkKey'],
            'topic': topic,
            'title': proposal['title'],
            'priority': proposal.get('priority') or 'medium',
            'taskId': str(existing['id']),
            'reused': True,
            'marker': marker,
        }, None

    payload = {
        'title': proposal['title'],
        'description': proposal.get('description') or '',
        'priority': proposal.get('priority') or 'medium',
        # Tasks in this workspace are created as status=todo; with ready unset/false,
        # task_transition_check treats that as the logical Open state.
        'status': 'open',
        'tags': task_tags(topic, item['bookmarkKey'], spec_docs, proposal),
    }
    response = api_request('POST', base_url, '/tasks', payload)
    task = response.get('data') if isinstance(response, dict) else None
    task_id = task.get('id') if isinstance(task, dict) else None
    if task_id is None:
        return None, {
            'bookmarkKey': item['bookmarkKey'],
            'topic': topic,
            'title': proposal.get('title'),
            'marker': marker,
            'error': 'Tasks API response did not include data.id',
            'response': response,
        }

    created = {
        'bookmarkKey': item['bookmarkKey'],
        'topic': topic,
        'title': proposal['title'],
        'priority': proposal.get('priority') or 'medium',
        'taskId': str(task_id),
        'reused': False,
        'marker': marker,
        'response': response,
    }
    existing_by_marker[marker] = task if isinstance(task, dict) else {'id': task_id, 'tags': payload['tags']}
    return created, None


def main() -> int:
    p = argparse.ArgumentParser(description='Create Tasks API tasks from approved bookmark proposals')
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
            for proposal in extract_proposed_tasks(item):
                result, error = create_task(base_url, topic, item, proposal, existing_by_marker)
                if result:
                    created.append(result)
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
        'note': 'Tasks are created through the existing Tasks API /tasks POST path. Retry safety comes from stable proposal:* tags and reusing matching existing tasks when found.',
    })
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
