#!/usr/bin/env python3
from __future__ import annotations

"""Handle Telegram approve/decline replies for bookmark approvals.

Resume-token only: bookmark approvals must resume through native `lobster resume`.
If a pending approval lacks `approvalResumeToken`, fail loudly so the pipeline can be fixed.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from common import STATE_PATH, WORKSPACE, dump_json, load_state, log_transition, now_iso, save_state, transition_log_path, get_approval_topic, clear_approval_lock

TOM_SENDER_NUM = 6435140143
APPROVE_RE = re.compile(r"\bapprove\b", re.IGNORECASE)
DECLINE_RE = re.compile(r"\bdecline\b", re.IGNORECASE)
REVISE_RE = re.compile(r"\brev(?:ise)?\b", re.IGNORECASE)
APPROVAL_ID_RE = re.compile(r"\b(ap[a-f0-9]{7,8})\b", re.IGNORECASE)
AUDIT_LOG_PATH = WORKSPACE / "brain" / "state" / "approval-reply-audit.csv"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Resume Lobster approval workflows from Telegram replies")
    p.add_argument("--channel", default="telegram")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--json", action="store_true")
    p.add_argument("--trigger-text", type=str, default="", help="Pre-fetched trigger message text from hook")
    p.add_argument("--trigger-sender", type=str, default="", help="Pre-fetched trigger sender ID from hook")
    p.add_argument("--trigger-reply-text", type=str, default="", help="Body/text of the message this reply responded to, when available")
    return p.parse_args()


def fetch_messages(channel: str, limit: int, trigger_text: str = "", trigger_sender: str = "", trigger_reply_text: str = "") -> list[dict]:
    # If hook already passed the triggering message content, use it directly.
    # Include replied-to approval body when available so short replies like
    # "approve" / "decline" can inherit the approval id from the quoted message.
    if trigger_text and trigger_sender:
        msg = {
            "sender_id": trigger_sender,
            "text": trigger_text,
        }
        if trigger_reply_text:
            msg["reply_text"] = trigger_reply_text
        return [msg]
    args = ["openclaw", "messages", "list", "--channel", channel, "--limit", str(limit), "--json"]
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, cwd=str(WORKSPACE))
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    raw = (result.stdout or "").strip()
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if isinstance(payload, dict):
        return payload.get("messages") or payload.get("items") or []
    if isinstance(payload, list):
        return payload
    return []


def sender_id(msg: dict) -> int | None:
    for field in ("sender_id", "userId", "user_id", "fromId", "from_id"):
        value = msg.get(field)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def extract_decision(text: str) -> str | None:
    if REVISE_RE.search(text):
        return "revise"
    if APPROVE_RE.search(text):
        return "approve"
    if DECLINE_RE.search(text):
        return "decline"
    return None


def extract_revision_text(text: str) -> str:
    cleaned = APPROVAL_ID_RE.sub("", text)
    cleaned = re.sub(r"^\s*rev(?:ise)?\s*:?\s*", "", cleaned, flags=re.IGNORECASE)
    return " ".join(cleaned.split()).strip()


def extract_approval_ids(text: str) -> list[str]:
    return [m.lower() for m in APPROVAL_ID_RE.findall(text)]


def extract_approval_ids_from_message(msg: dict) -> list[str]:
    ids: list[str] = []
    for field in ("text", "body", "content", "reply_text", "reply_body", "quoted_text", "quoted_body"):
        value = msg.get(field)
        if isinstance(value, str) and value.strip():
            ids.extend(extract_approval_ids(value))
    # preserve order while deduping
    return list(dict.fromkeys(ids))


def pending_by_approval_id(state: dict) -> dict[str, dict]:
    indexed: dict[str, dict] = {}
    for item in (state.get("items") or {}).values():
        if item.get("reviewStatus") not in {"approval_pending", "revision_staged"}:
            continue
        approval_id = str(item.get("approvalId") or "").strip().lower()
        if approval_id:
            indexed[approval_id] = item
    return indexed


def run_lobster_resume(token: str, approve: bool) -> tuple[dict | None, str | None]:
    args = ["lobster", "resume", "--token", token, "--approve", "yes" if approve else "no"]
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, cwd=str(WORKSPACE))
    except FileNotFoundError:
        return None, "lobster CLI not found"
    except subprocess.CalledProcessError as exc:
        raw = (exc.stdout or exc.stderr or str(exc)).strip()
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                err = parsed.get("error") or {}
                message = err.get("message") or raw
                return None, f"lobster resume failed: {message}"
        except json.JSONDecodeError:
            pass
        return None, f"lobster resume failed: {raw}"

    raw = (result.stdout or "").strip()
    if not raw:
        return None, "lobster resume returned empty output"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, f"lobster resume returned invalid JSON: {raw[:300]}"


def run_script(script_name: str, args: list[str], stdin_payload: dict) -> tuple[dict | None, str | None]:
    script = Path(__file__).resolve().parent / script_name
    cmd = [sys.executable, str(script), *args]
    env = os.environ.copy()
    env.setdefault("TASKS_API_BASE_URL", "http://localhost:4000/api/v1")
    try:
        result = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            cwd=str(WORKSPACE),
            input=json.dumps(stdin_payload),
            env=env,
        )
    except subprocess.CalledProcessError as exc:
        return None, exc.stderr or exc.stdout or str(exc)

    raw = (result.stdout or "").strip()
    if not raw:
        return None, f"{script_name} returned empty output"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, f"{script_name} returned invalid JSON: {raw[:300]}"


def force_clear_approval_lock(state: dict, approval_id: str, approved: bool) -> int:
    cleared = 0
    for key, item in (state.get("items") or {}).items():
        if str(item.get("approvalId") or "").strip().lower() != approval_id:
            continue
        # Always update by approvalId regardless of current reviewStatus — the workflow may
        # have already transitioned the status but we still need to clear the approval fields.
        previous_status = item.get("reviewStatus")
        item["approvalResumeToken"] = None
        item["approvalId"] = None
        # approvalTopic removed; readers use get_approval_topic() helper
        item["approvalStatus"] = "approved" if approved else "declined"
        item["approvalResolvedAt"] = now_iso()
        if not approved:
            # Reset to summarised so the pipeline can re-curate and re-spec with updated review
            item["reviewStatus"] = "summarised"
            item["curation"] = None
        elif item.get("taskIds") or []:
            item["reviewStatus"] = "tasked"
        else:
            item["reviewStatus"] = "spec_created"
        item["lastUpdatedAt"] = now_iso()
        state["items"][key] = item
        log_transition(
            key,
            previous_status,
            item["reviewStatus"],
            f"approval decision: {'approved' if approved else 'declined'} (id={approval_id})",
            transitions_path=transition_log_path(STATE_PATH),
        )
        cleared += 1
    return cleared


def rebuild_revised_approval(bookmark_key: str) -> dict | None:
    script = WORKSPACE / "codebases" / "sindustries" / "agents" / "workflows" / "bookmark" / "rebuild_revised_approval.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--bookmark-key", bookmark_key, "--json"],
        text=True,
        capture_output=True,
        cwd=str(WORKSPACE),
        env=os.environ.copy(),
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "rebuild_revised_approval failed")
    raw = (proc.stdout or "").strip()
    return json.loads(raw) if raw else None


def apply_revision_request(state: dict, approval_id: str, revision_text: str) -> dict:
    updated = []
    timestamp = now_iso()
    for key, item in (state.get("items") or {}).items():
        if str(item.get("approvalId") or "").strip().lower() != approval_id:
            continue
        if item.get("reviewStatus") not in {"approval_pending", "revision_staged"}:
            continue
        previous_status = item.get("reviewStatus")
        history = item.get("revisionRequests") or []
        if not isinstance(history, list):
            history = []
        history.append({"at": timestamp, "text": revision_text})
        item["revisionRequests"] = history
        item["latestRevisionRequest"] = revision_text
        item["approvalStatus"] = None
        item["approvalRequestedAt"] = None
        item["approvalResolvedAt"] = None
        item["approvalId"] = None
        item["latestApprovalResumeToken"] = item.get("approvalResumeToken")
        item["approvalResumeToken"] = None
        item["reviewStatus"] = "revision_requested"
        item["lastUpdatedAt"] = timestamp
        state["items"][key] = item
        log_transition(
            key,
            previous_status,
            "revision_requested",
            f"revision request (id={approval_id}): {revision_text[:80]}",
            transitions_path=transition_log_path(STATE_PATH),
        )
        updated.append({
            "bookmarkKey": key,
            "title": item.get("title"),
            "specDocs": item.get("specDocs") or [],
            "topic": get_approval_topic(item),
        })
    return {
        "approvalId": approval_id,
        "revisionText": revision_text,
        "updated": updated,
        "count": len(updated),
        "summary": f"Revision requested for {approval_id} — marked {len(updated)} spec{'s' if len(updated) != 1 else ''} for rewrite",
    }


def summarize_post_resume_state(state: dict, approval_id: str, decision: str, expected_bookmark_keys: list[str] | None = None) -> dict:
    expected_set = set(expected_bookmark_keys or [])
    matched = []

    for key, item in (state.get("items") or {}).items():
        if expected_set and key not in expected_set:
            continue
        if str(item.get("approvalId") or "").strip().lower() == approval_id:
            matched.append((key, item))

    if not matched and expected_set:
        for key in expected_bookmark_keys or []:
            item = (state.get("items") or {}).get(key)
            if not item:
                continue
            if item.get("reviewStatus") in {"approval_pending", "revision_staged"}:
                continue
            if item.get("approvalStatus") != ("approved" if decision == "approve" else "declined"):
                continue
            matched.append((key, item))

    if not matched and not expected_set:
        for key, item in (state.get("items") or {}).items():
            if item.get("approvalStatus") != ("approved" if decision == "approve" else "declined"):
                continue
            if item.get("reviewStatus") in {"approval_pending", "revision_staged"}:
                continue
            matched.append((key, item))

    task_ids = []
    declined = 0
    spec_created = 0
    tasked = 0
    bookmark_keys = []
    for key, item in matched:
        bookmark_keys.append(key)
        task_ids.extend(str(tid) for tid in (item.get("taskIds") or []))
        status = item.get("reviewStatus")
        if item.get("approvalStatus") == "declined":
            declined += 1
        elif status == "tasked":
            tasked += 1
        elif status == "spec_created":
            spec_created += 1

    unique_task_ids = list(dict.fromkeys(task_ids))
    if decision == "decline":
        summary = f"Declined {approval_id} — reset {declined or len(bookmark_keys)} bookmark{'s' if (declined or len(bookmark_keys)) != 1 else ''} to summarised for re-curation"
    elif unique_task_ids:
        summary = f"Approved {approval_id} — created/linked {len(unique_task_ids)} task{'s' if len(unique_task_ids) != 1 else ''}"
    elif tasked:
        summary = f"Approved {approval_id} — marked {tasked} item{'s' if tasked != 1 else ''} tasked"
    elif spec_created:
        summary = f"Approved {approval_id} — spec kept as spec_created (no tasks created)"
    else:
        summary = f"Approved {approval_id} — resume completed"

    return {
        "approvalId": approval_id,
        "decision": decision,
        "bookmarkKeys": bookmark_keys,
        "taskIds": unique_task_ids,
        "summary": summary,
        "counts": {
            "bookmarks": len(bookmark_keys),
            "taskIds": len(unique_task_ids),
            "declined": declined,
            "tasked": tasked,
            "specCreated": spec_created,
        },
    }


def extract_proposed_tasks(item: dict) -> list[dict]:
    direct = item.get("proposedTasks")
    if isinstance(direct, list) and direct:
        return direct

    nested: list[dict] = []
    for proposal in item.get("specProposals") or []:
        tasks = proposal.get("proposedTasks")
        if isinstance(tasks, list):
            nested.extend(task for task in tasks if isinstance(task, dict))
    return nested


def build_approval_payload_from_state(state: dict, approval_id: str) -> dict:
    items = []
    topic = "general"
    for key, item in (state.get("items") or {}).items():
        if item.get("reviewStatus") not in {"approval_pending", "revision_staged"}:
            continue
        if str(item.get("approvalId") or "").strip().lower() != approval_id:
            continue
        topic = get_approval_topic(item)
        items.append({
            "bookmarkKey": key,
            "approvalId": item.get("approvalId"),
            "approvalTopic": get_approval_topic(item),
            "topic": item.get("topic"),
            "title": item.get("title"),
            "path": item.get("path"),
            "proposedTasks": extract_proposed_tasks(item),
            "specDocs": item.get("specDocs", []),
        })
    return {"approvals": [{"topic": topic, "items": items}], "created": []}


def audit_log(**row: object) -> None:
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "ts",
        "phase",
        "channel",
        "message_sender_id",
        "message_text",
        "decision",
        "reply_approval_ids",
        "matched_approval_id",
        "pending_ids",
        "result_status",
        "error",
        "details",
    ]
    exists = AUDIT_LOG_PATH.exists()
    with AUDIT_LOG_PATH.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        if not exists:
            writer.writeheader()
        payload = {key: "" if value is None else str(value) for key, value in row.items()}
        writer.writerow({field: payload.get(field, "") for field in fields})


def main() -> int:
    args = parse_args()
    state = load_state(Path(STATE_PATH))
    pending = pending_by_approval_id(state)

    audit_log(
        ts=now_iso(),
        phase="start",
        channel=args.channel,
        pending_ids="|".join(sorted(pending.keys())),
        details=f"limit={args.limit}",
    )

    if not pending:
        payload = {"ok": True, "action": "none", "reason": "no pending approvals"}
        audit_log(
            ts=now_iso(),
            phase="exit",
            channel=args.channel,
            pending_ids="",
            result_status="none",
            details="no pending approvals",
        )
        dump_json(payload) if args.json else print(payload["reason"])
        return 0

    messages = fetch_messages(args.channel, args.limit, args.trigger_text, args.trigger_sender, args.trigger_reply_text)
    replies = []
    for msg in messages:
        sid = sender_id(msg)
        text = (msg.get("text") or msg.get("body") or msg.get("content") or "").strip()
        decision = extract_decision(text) if text else None
        approval_ids = extract_approval_ids_from_message(msg) if text else []
        audit_log(
            ts=now_iso(),
            phase="message_seen",
            channel=args.channel,
            message_sender_id=sid,
            message_text=text[:160],
            decision=decision,
            reply_approval_ids="|".join(approval_ids),
            pending_ids="|".join(sorted(pending.keys())),
            result_status="candidate" if (sid == TOM_SENDER_NUM and decision) else "ignored",
            details=f"keys={','.join(sorted(msg.keys()))}",
        )
        if sid != TOM_SENDER_NUM:
            continue
        if not text:
            continue
        if not decision:
            continue
        replies.append({
            "decision": decision,
            "approvalIds": approval_ids,
            "text": text[:160],
            "senderId": sid,
            "revisionText": extract_revision_text(text) if decision == "revise" else "",
        })

    if not replies:
        payload = {"ok": True, "action": "none", "reason": "no approval replies from Tom in recent messages"}
        audit_log(
            ts=now_iso(),
            phase="exit",
            channel=args.channel,
            pending_ids="|".join(sorted(pending.keys())),
            result_status="none",
            details="no approval replies from Tom in recent messages",
        )
        dump_json(payload) if args.json else print(payload["reason"])
        return 0

    results = []
    for reply in replies:
        decision = reply["decision"]
        approval_ids = reply["approvalIds"]
        matched_id = None

        if not approval_ids:
            if len(pending) == 1:
                matched_id = next(iter(pending.keys()))
            else:
                audit_log(
                    ts=now_iso(),
                    phase="reply_match",
                    channel=args.channel,
                    message_sender_id=reply.get("senderId"),
                    message_text=reply.get("text"),
                    decision=decision,
                    reply_approval_ids="",
                    pending_ids="|".join(sorted(pending.keys())),
                    result_status="skipped",
                    error="missing approvalId in reply",
                )
                results.append({"status": "skipped", "decision": decision, "reason": "missing approvalId in reply; include token like apxxxxxxx"})
                continue
        else:
            matched_id = next((aid for aid in approval_ids if aid in pending), None)

        if not matched_id:
            audit_log(
                ts=now_iso(),
                phase="reply_match",
                channel=args.channel,
                message_sender_id=reply.get("senderId"),
                message_text=reply.get("text"),
                decision=decision,
                reply_approval_ids="|".join(approval_ids),
                pending_ids="|".join(sorted(pending.keys())),
                result_status="skipped",
                error="no matching pending approvalId",
            )
            results.append({"status": "skipped", "decision": decision, "approvalIds": approval_ids, "reason": "no matching pending approvalId"})
            continue

        audit_log(
            ts=now_iso(),
            phase="reply_match",
            channel=args.channel,
            message_sender_id=reply.get("senderId"),
            message_text=reply.get("text"),
            decision=decision,
            reply_approval_ids="|".join(approval_ids),
            matched_approval_id=matched_id,
            pending_ids="|".join(sorted(pending.keys())),
            result_status="matched",
        )

        item = pending[matched_id]
        token = str(item.get("approvalResumeToken") or "").strip()
        approval_payload = build_approval_payload_from_state(state, matched_id)
        approval_items = ((approval_payload.get("approvals") or [{}])[0].get("items") or [])
        expected_bookmark_keys = [str(summary.get("bookmarkKey")) for summary in approval_items if summary.get("bookmarkKey")]
        expected_task_markers = set()
        for summary in approval_items:
            bookmark_key = str(summary.get("bookmarkKey") or "")
            spec_docs = summary.get("specDocs") or []
            for proposal in extract_proposed_tasks(summary):
                title = proposal.get("title") or ""
                priority = proposal.get("priority") or "medium"
                description = proposal.get("description") or ""
                marker_payload = {
                    "bookmarkKey": bookmark_key,
                    "specDocs": sorted(spec_docs),
                    "title": title,
                    "priority": priority,
                    "description": description,
                }
                digest = __import__("hashlib").sha1(json.dumps(marker_payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]
                expected_task_markers.add(f"proposal:{digest}")

        if decision == "revise":
            revision_text = (reply.get("revisionText") or "").strip()
            if not revision_text:
                results.append({
                    "status": "error",
                    "decision": decision,
                    "approvalId": matched_id,
                    "reason": "missing revision details; use 'revise: <changes>'",
                })
                continue
            revision = apply_revision_request(state, matched_id, revision_text)
            clear_approval_lock(state, matched_id)
            save_state(state, Path(STATE_PATH))
            rebuilt = None
            rebuild_error = None
            try:
                first_updated = (revision.get("updated") or [])[0] if revision.get("updated") else None
                if first_updated and first_updated.get("bookmarkKey"):
                    rebuilt = rebuild_revised_approval(first_updated["bookmarkKey"])
                    state = load_state(Path(STATE_PATH))
            except Exception as exc:
                rebuild_error = str(exc)
            pending = pending_by_approval_id(state)
            audit_log(
                ts=now_iso(),
                phase="action",
                channel=args.channel,
                decision=decision,
                matched_approval_id=matched_id,
                pending_ids="|".join(sorted(pending.keys())),
                result_status="revised" if not rebuild_error else "error",
                error=rebuild_error,
                details=revision_text,
            )
            pending_spec = isinstance(rebuilt, dict) and rebuilt.get("status") == "pending_spec"
            if pending_spec:
                # Quinn's heartbeat will write the spec and resend the approval.
                revision["summary"] = f"Revision recorded for {matched_id} — Quinn will rewrite the spec and resend the approval shortly"
                results.append({
                    "status": "pending_spec",
                    "decision": decision,
                    "approvalId": matched_id,
                    "outcome": revision,
                    "rebuild": rebuilt,
                })
            elif rebuilt and isinstance(rebuilt, dict):
                approvals = ((rebuilt.get("approval") or {}).get("approvals") or [])
                if approvals:
                    first = approvals[0]
                    new_approval_id = first.get("approvalId")
                    count = len(first.get("items") or [])
                    revision["summary"] = f"Revision requested for {matched_id} — rebuilt new approval {new_approval_id} for {count} item{'s' if count != 1 else ''}"
                    revision["revisedApprovalId"] = new_approval_id
                    revision["revisedApprovalMessage"] = first.get("message")
                results.append({
                    "status": "revised" if not rebuild_error else "error",
                    "decision": decision,
                    "approvalId": matched_id,
                    "outcome": revision,
                    "rebuild": rebuilt,
                    "error": rebuild_error,
                })
            else:
                results.append({
                    "status": "revised" if not rebuild_error else "error",
                    "decision": decision,
                    "approvalId": matched_id,
                    "outcome": revision,
                    "rebuild": rebuilt,
                    "error": rebuild_error,
                })
            continue

        if token:
            resumed, err = run_lobster_resume(token, decision == "approve")
            cleared = 0
            if not err:
                # Reload after resume so we don't write stale pre-resume state back over
                # any mutations done by downstream workflow steps.
                state = load_state(Path(STATE_PATH))
                cleared = force_clear_approval_lock(state, matched_id, decision == "approve")
                clear_approval_lock(state, matched_id)
                pending = pending_by_approval_id(state)
            outcome = summarize_post_resume_state(state, matched_id, decision, expected_bookmark_keys) if not err else None
            if outcome is not None:
                created_entries = []
                resumed_payload = (resumed or {}).get("output")
                if isinstance(resumed_payload, dict):
                    resumed_created = resumed_payload.get("created") or []
                elif isinstance(resumed_payload, list):
                    resumed_created = resumed_payload
                else:
                    resumed_created = []
                if isinstance(resumed_created, list):
                    created_entries = [entry for entry in resumed_created if isinstance(entry, dict)]
                relevant_created = []
                for entry in created_entries:
                    if expected_bookmark_keys and str(entry.get("bookmarkKey") or "") not in expected_bookmark_keys:
                        continue
                    marker = str(entry.get("marker") or "")
                    if expected_task_markers and marker and marker not in expected_task_markers:
                        continue
                    relevant_created.append(entry)
                created_task_ids = list(dict.fromkeys(str(entry.get("taskId")) for entry in relevant_created if entry.get("taskId")))
                reused_task_ids = list(dict.fromkeys(str(entry.get("taskId")) for entry in relevant_created if entry.get("taskId") and entry.get("reused") is True))
                newly_created_task_ids = [str(entry.get("taskId")) for entry in relevant_created if entry.get("taskId") and entry.get("reused") is not True]
                newly_created_task_ids = list(dict.fromkeys(newly_created_task_ids))
                outcome["taskIds"] = created_task_ids
                outcome["newTaskIds"] = newly_created_task_ids
                outcome["reusedTaskIds"] = reused_task_ids
                outcome["counts"]["taskIds"] = len(created_task_ids)
                if decision == "approve" and created_task_ids:
                    created = len(newly_created_task_ids)
                    linked = len(reused_task_ids)
                    if created and linked:
                        outcome["summary"] = f"Approved {matched_id} — created {created} task{'s' if created != 1 else ''}, linked {linked} existing"
                    elif created:
                        outcome["summary"] = f"Approved {matched_id} — created {created} task{'s' if created != 1 else ''}"
                    elif linked:
                        outcome["summary"] = f"Approved {matched_id} — linked {linked} existing task{'s' if linked != 1 else ''}"
            status = "resumed" if not err else "error"
            audit_log(
                ts=now_iso(),
                phase="action",
                channel=args.channel,
                decision=decision,
                matched_approval_id=matched_id,
                pending_ids="|".join(sorted(pending.keys())),
                result_status=status,
                error=err,
                details=f"token={token};cleared={cleared}",
            )
            results.append({
                "status": status,
                "decision": decision,
                "approvalId": matched_id,
                "resumeToken": token,
                "resumed": resumed,
                "cleared": cleared,
                "error": err,
                "outcome": outcome,
            })
            continue

        audit_log(
            ts=now_iso(),
            phase="action",
            channel=args.channel,
            decision=decision,
            matched_approval_id=matched_id,
            pending_ids="|".join(sorted(pending.keys())),
            result_status="error",
            error="missing approvalResumeToken",
            details="resume-token-only path refuses fallback",
        )
        results.append({
            "status": "error",
            "decision": decision,
            "approvalId": matched_id,
            "reason": "missing approvalResumeToken in state; resume-token-only path refuses fallback",
        })
        continue

    save_state(state, Path(STATE_PATH))
    audit_log(
        ts=now_iso(),
        phase="exit",
        channel=args.channel,
        pending_ids="|".join(sorted(pending.keys())),
        result_status="processed",
        details=f"processed={len(results)}",
    )
    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "processed": len(results),
        "pendingIds": sorted(pending.keys()),
        "results": results,
        "note": "Resume-token only: approvals must resume through native Lobster resume; missing tokens are surfaced as errors.",
    }
    dump_json(payload) if args.json else print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
