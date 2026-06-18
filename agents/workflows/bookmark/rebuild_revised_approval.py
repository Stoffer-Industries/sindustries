#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
from pathlib import Path

_env_ws = os.environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env_ws).resolve() if _env_ws else Path(__file__).resolve().parents[5]
_BOOKMARK_WF = WORKSPACE / 'codebases' / 'sindustries' / 'agents' / 'workflows' / 'bookmark'
STATE_PATH = WORKSPACE / 'brain' / 'state' / 'bookmark-review-state.json'
GENERATE_SPECS = _BOOKMARK_WF / 'lobster_generate_specs.py'
REQUEST_SPEC_APPROVAL = _BOOKMARK_WF / 'lobster_request_spec_approval.py'
REQUEST_TOPIC_APPROVAL = _BOOKMARK_WF / 'request_topic_approval.py'


def run_json(cmd: list[str], stdin_data: dict | None = None, env: dict[str, str] | None = None) -> dict:
    proc = subprocess.run(
        cmd,
        cwd=str(WORKSPACE),
        input=(json.dumps(stdin_data) if stdin_data is not None else None),
        text=True,
        capture_output=True,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f'command failed: {cmd}')
    raw = (proc.stdout or '').strip()
    return json.loads(raw or '{}')


def load_state() -> dict:
    return json.loads(STATE_PATH.read_text(encoding='utf-8'))


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def approvals_have_delivery(approval_payload: dict) -> bool:
    if approval_payload.get('stageOnly'):
        return True
    approvals = approval_payload.get('approvals') or []
    if not isinstance(approvals, list) or not approvals:
        return False
    for approval in approvals:
        if approval.get('stageOnly'):
            return True
        delivery = approval.get('delivery') or {}
        if not isinstance(delivery, dict):
            continue
        if delivery.get('messageId'):
            return True
        payload = delivery.get('result') or delivery.get('payload') or {}
        if isinstance(payload, dict):
            nested_payload = payload.get('payload') if isinstance(payload.get('payload'), dict) else None
            for candidate in (payload, nested_payload):
                if isinstance(candidate, dict) and candidate.get('messageId'):
                    return True
    return False


def approval_failure_reason(approval_payload: dict) -> str | None:
    approvals = approval_payload.get('approvals') or []
    if not isinstance(approvals, list) or not approvals:
        blocked = approval_payload.get('blockedPackages') or []
        if isinstance(blocked, list) and blocked:
            reasons = []
            for pkg in blocked:
                reason = pkg.get('reason') or pkg.get('blockedReason')
                topic = pkg.get('approvalTopic') or pkg.get('topic') or 'unknown'
                if reason:
                    reasons.append(f"{topic}: {reason}")
            if reasons:
                return '; '.join(reasons)
        missing = approval_payload.get('missingResumeTokens') or []
        if isinstance(missing, list) and missing:
            reasons = []
            for item in missing:
                topic = item.get('topic') or 'unknown'
                reason = item.get('reason') or 'missing lobster resumeToken'
                reasons.append(f"{topic}: {reason}")
            if reasons:
                return '; '.join(reasons)
        return 'rebuild produced no approval packages'
    if approvals_have_delivery(approval_payload):
        return None
    errors = []
    for approval in approvals:
        if approval.get('deliveryError'):
            errors.append(str(approval.get('deliveryError')))
    if errors:
        return '; '.join(errors)
    return 'approval package was created but no delivery was confirmed'


def main() -> int:
    p = argparse.ArgumentParser(description='Rebuild and resend approval for a revised bookmark spec')
    p.add_argument('--bookmark-key', required=True)
    p.add_argument('--force', action='store_true', help='allow rebuild even if state has not yet persisted revision_requested')
    p.add_argument('--json', action='store_true')
    args = p.parse_args()

    env = os.environ.copy()
    state = load_state()
    original_state = copy.deepcopy(state)
    item = (state.get('items') or {}).get(args.bookmark_key)
    if not item:
        raise RuntimeError(f'bookmark not found in state: {args.bookmark_key}')
    if item.get('reviewStatus') != 'revision_requested' and not args.force:
        raise RuntimeError(f'bookmark {args.bookmark_key} is not revision_requested')

    implement_payload = {
        'implement': [{
            'bookmarkKey': args.bookmark_key,
            'path': item.get('path'),
            'topic': item.get('topic') or 'general',
            'title': item.get('title'),
            'source': item.get('source') or 'unknown',
            'link': item.get('link') or '',
            'tags': item.get('tags') or [],
            'bodyExcerpt': item.get('bodyExcerpt') or '',
            'body': item.get('body') or '',
            'analysis': item.get('analysis') or {},
            'reviewDoc': item.get('reviewDoc') or '',
            'specDocs': item.get('specDocs') or [],
            'specProposals': item.get('specProposals') or [],
        }],
        'monitoring': [],
        'reviewed': [],
    }

    generated = run_json([sys.executable, str(GENERATE_SPECS), '--json'], implement_payload, env=env)

    # generate_specs.py routes revision_requested items to Quinn's heartbeat.
    # If it returned no implement items, the spec isn't ready yet — return pending_spec
    # so handle_approval_reply.py can notify Tom and let Quinn's heartbeat finish the job.
    if not (generated.get('implement') or []):
        current_state = load_state()
        current_item = (current_state.get('items') or {}).get(args.bookmark_key, {})
        if current_item.get('reviewStatus') == 'revision_requested':
            print(json.dumps({'ok': True, 'status': 'pending_spec', 'bookmarkKey': args.bookmark_key}))
            return 0

    approval_topic = item.get('approvalTopic') or item.get('topic') or 'general'
    compact = run_json([sys.executable, str(REQUEST_SPEC_APPROVAL), '--approval-topic', approval_topic, '--json'], generated, env=env)

    resume_token = (
        item.get('approvalResumeToken')
        or item.get('latestApprovalResumeToken')
        or item.get('resumeToken')
    )
    if resume_token:
        compact['resumeToken'] = resume_token
        for pkg in compact.get('readyPackages') or []:
            pkg['resumeToken'] = resume_token

    approval = run_json([sys.executable, str(REQUEST_TOPIC_APPROVAL), '--json'], compact, env=env)

    failure_reason = approval_failure_reason(approval)
    if failure_reason:
        save_state(original_state)
        raise RuntimeError(f'revised approval rebuild failed: {failure_reason}')

    payload = {
        'ok': True,
        'bookmarkKey': args.bookmark_key,
        'approval': approval,
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
