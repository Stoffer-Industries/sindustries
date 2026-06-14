#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from contextlib import contextmanager
import fcntl
from pathlib import Path
from typing import Any

from common import STATE_PATH, WORKSPACE, dump_json, load_state, log_transition, now_iso, save_state, transition_log_path


def _generate_approval_id(topic: str) -> str:
    """Generate a short deterministic approval ID from topic + timestamp + entropy."""
    raw = f"{topic}:{now_iso()}:{os.urandom(16).hex()}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"ap{digest}"

APPROVAL_TOPICS_PATH = WORKSPACE / "brain" / "state" / "bookmark-approval-topics.json"


@contextmanager
def approval_state_lock(state_path: Path):
    """Serialize approval claim, delivery, and state persistence."""
    lock_path = state_path.with_name(state_path.name + ".approval.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def normalize_topic(topic: str | None) -> str:
    text = str(topic or "").strip()
    return text or "general"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(WORKSPACE))
    except ValueError:
        return str(path)


def first_line(text: str | None) -> str | None:
    if not text:
        return None
    stripped = " ".join(text.strip().split())
    if not stripped:
        return None
    for sep in (". ", "! ", "? "):
        if sep in stripped:
            head = stripped.split(sep, 1)[0].strip()
            return head + sep[0]
    return stripped


def hydrate_proposed_tasks_from_state(state_item: dict) -> list[dict]:
    direct = state_item.get("proposedTasks")
    if isinstance(direct, list) and direct:
        return [task for task in direct if isinstance(task, dict)]

    nested: list[dict] = []
    for proposal in state_item.get("specProposals") or []:
        tasks = proposal.get("proposedTasks")
        if isinstance(tasks, list):
            nested.extend(task for task in tasks if isinstance(task, dict))
    return nested


def build_approval_message(package: dict, approval_id: str | None = None) -> str:
    topic = normalize_topic(package.get("approvalTopic") or package.get("topic"))
    items = package.get("items", [])

    plan_links = []
    todo_lines = []
    bookmark_titles = []

    for item in items:
        title = (item.get("title") or "").strip()
        if title:
            bookmark_titles.append(title)

        for spec_doc in item.get("specDocs", []):
            if spec_doc and spec_doc not in plan_links:
                plan_links.append(spec_doc)

        for task in item.get("proposedTasks", []):
            description = task.get("description") or ""
            deliverable = ""
            for marker in ("**Deliverable:**", "Deliverable:"):
                if marker in description:
                    deliverable = description.split(marker, 1)[1].strip().splitlines()[0].strip()
                    break
            task_line = f"- {task.get('title')}"
            if deliverable:
                task_line += f" — {deliverable}"
            todo_lines.append(task_line)

    bookmark_label = bookmark_titles[0] if len(bookmark_titles) == 1 else f"{len(bookmark_titles)} bookmarks"

    lines = [f"Approval request: {topic}"]
    if approval_id:
        lines.append(f"[#{approval_id}]")
    lines.extend(["", f"Bookmark: {bookmark_label}"])
    if approval_id:
        lines.append(f"Approval id: {approval_id}")
    lines.append("")

    if plan_links:
        lines.append("Spec path")
        lines.append(f"- {plan_links[0]}")
        if len(plan_links) > 1:
            lines.append(f"- …and {len(plan_links) - 1} more spec(s)")
        lines.append("")

    if todo_lines:
        lines.append("Proposed tasks")
        lines.extend(todo_lines)
        lines.append("")

    lines.append("Reply: `approve` / `decline` / `revise: <changes>`")
    return "\n".join(lines)


def parse_topic_thread_map(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    result = {}
    for key, value in payload.items():
        if not isinstance(key, str):
            continue
        text = str(value).strip()
        if text:
            result[key.strip()] = text
    return result


def load_approval_topics_config(path: Path | None = None) -> dict | None:
    path = path or APPROVAL_TOPICS_PATH
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def resolve_topic_thread_id(topic: str, config: dict | None) -> tuple[str | None, str | None, str | None]:
    topic = normalize_topic(topic)
    if not config:
        return None, None, None
    topics = config.get("topics")
    if not isinstance(topics, dict):
        return None, None, None

    direct = topics.get(topic)
    if direct not in (None, ""):
        return str(direct), None, "config"

    general = topics.get("general")
    if general not in (None, ""):
        return str(general), f"topic '{topic}' missing from {display_path(APPROVAL_TOPICS_PATH)}; falling back to 'general'", "config-general-fallback"

    return None, f"topic '{topic}' missing from {display_path(APPROVAL_TOPICS_PATH)} and no 'general' fallback exists", "config-missing"


def resolve_delivery_config(topic: str) -> tuple[dict | None, str | None]:
    topic = normalize_topic(topic)
    config = load_approval_topics_config()

    # Support two config formats:
    # 1) Legacy: {"chatId": "...", "topics": {"infra": 2, ...}}
    # 2) Per-topic map: {"infra": {"chatId": "...", "threadId": "2"}, "general": {...}}
    config_target = ""
    config_thread = None
    warning = None
    routing_source = None

    if config:
        # Legacy format
        if isinstance(config.get("chatId"), (str, int)):
            config_target = str(config.get("chatId") or "").strip()
            thread_id, warning, routing_source = resolve_topic_thread_id(topic, config)
            config_thread = thread_id
        else:
            # Per-topic format
            topic_entry = config.get(topic)
            general_entry = config.get("general")
            chosen = None
            if isinstance(topic_entry, dict):
                chosen = topic_entry
                routing_source = "config"
            elif isinstance(general_entry, dict):
                chosen = general_entry
                routing_source = "config-general-fallback"
                warning = f"topic '{topic}' missing from {display_path(APPROVAL_TOPICS_PATH)}; falling back to 'general'"

            if isinstance(chosen, dict):
                config_target = str(chosen.get("chatId") or "").strip()
                config_thread = str(chosen.get("threadId") or "").strip() or None

    channel = (os.getenv("BOOKMARK_APPROVAL_CHANNEL") or ("telegram" if config else "")).strip()
    target = config_target or (os.getenv("BOOKMARK_APPROVAL_TARGET") or "").strip()
    if not channel:
        return None, "missing approval delivery channel; set BOOKMARK_APPROVAL_CHANNEL or provide bookmark approval topic config"
    if not target:
        return None, f"missing Telegram chat target; expected chatId in {display_path(APPROVAL_TOPICS_PATH)} or BOOKMARK_APPROVAL_TARGET"

    thread_id = config_thread
    if not thread_id:
        topic_map = parse_topic_thread_map(os.getenv("BOOKMARK_APPROVAL_TOPIC_THREADS"))
        env_thread_id = (
            topic_map.get(topic)
            or topic_map.get("general")
            or (os.getenv("BOOKMARK_APPROVAL_THREAD_ID") or "").strip()
            or None
        )
        if env_thread_id:
            thread_id = env_thread_id
            routing_source = routing_source or "env"
        else:
            detail = warning or f"no Telegram topic id configured for '{topic}'"
            return None, detail

    account = (os.getenv("BOOKMARK_APPROVAL_ACCOUNT") or "").strip() or None
    return {
        "channel": channel,
        "target": target,
        "threadId": thread_id,
        "account": account,
        "routingSource": routing_source,
        "routingWarning": warning,
        "topicConfigPath": display_path(APPROVAL_TOPICS_PATH),
    }, None


def extract_delivery_ids(payload: dict | None) -> tuple[str | None, str | None]:
    if not isinstance(payload, dict):
        return None, None
    message_id = None
    thread_id = None
    for key in ("message_id", "messageId", "id"):
        value = payload.get(key)
        if value not in (None, ""):
            message_id = str(value)
            break
    for key in ("thread_id", "threadId", "message_thread_id", "topic_id"):
        value = payload.get(key)
        if value not in (None, ""):
            thread_id = str(value)
            break
    nested = payload.get("message")
    if isinstance(nested, dict):
        nested_message_id, nested_thread_id = extract_delivery_ids(nested)
        message_id = message_id or nested_message_id
        thread_id = thread_id or nested_thread_id
    return message_id, thread_id


def deliver_approval_message(message: str, delivery: dict) -> dict:
    args = [
        "openclaw",
        "message",
        "send",
        "--channel",
        delivery["channel"],
        "--target",
        delivery["target"],
        "--message",
        message,
        "--json",
    ]
    if delivery.get("account"):
        args.extend(["--account", delivery["account"]])
    if delivery.get("threadId"):
        args.extend(["--thread-id", delivery["threadId"]])

    completed = subprocess.run(
        args,
        capture_output=True,
        text=True,
    )
    raw = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        payload = {"raw": raw, "stderr": stderr}
    if completed.returncode != 0 and isinstance(payload, dict) and not payload.get("error"):
        payload["error"] = stderr or raw or f"openclaw message send failed with code {completed.returncode}"
        payload["returncode"] = completed.returncode
    message_id, resolved_thread_id = extract_delivery_ids(payload)
    return {
        "channel": delivery["channel"],
        "target": delivery["target"],
        "threadId": resolved_thread_id or delivery.get("threadId"),
        "messageId": message_id,
        "account": delivery.get("account"),
        "routingSource": delivery.get("routingSource"),
        "routingWarning": delivery.get("routingWarning"),
        "topicConfigPath": delivery.get("topicConfigPath"),
        "result": payload,
    }


def _main_locked(data: dict[str, Any]) -> int:
    ready = data.get("readyPackages", [])
    stage_only = bool(data.get("stageOnly"))

    state = load_state(Path(STATE_PATH))
    items = state["items"]
    approval_locks = state.setdefault("approvalLocks", {})

    approvals: list[dict[str, Any]] = []
    blocked_packages: list[dict[str, Any]] = list(data.get("blockedPackages", []))
    missing_resume_tokens: list[dict[str, Any]] = []
    approval_ids_out: list[dict[str, Any]] = []
    timestamp = now_iso()

    # Validate inputs and claim each available topic while holding the
    # process-wide state lock. The lock remains held through delivery and
    # final persistence so another run cannot observe an intermediate state.
    candidates: list[dict[str, Any]] = []
    for package in ready:
        topic = normalize_topic(package.get("approvalTopic") or package.get("topic"))
        resume_token = (
            package.get("resumeToken")
            or package.get("lobsterResumeToken")
            or data.get("resumeToken")
        )

        # Existing-lock check is the primary guard against concurrent runs.
        # We also keep the per-item scan as a defense-in-depth check (in
        # case the lock field was cleared but items still in flight).
        if topic in approval_locks:
            blocked_packages.append({
                **package,
                "reason": "approval already pending for topic",
            })
            continue
        topic_already_pending = any(
            (state_item.get("approvalTopic") or state_item.get("topic") or "general") == topic
            and state_item.get("reviewStatus") in {"approval_pending", "revision_staged"}
            for state_item in items.values()
        )
        if topic_already_pending:
            blocked_packages.append({
                **package,
                "reason": "approval already pending for topic",
            })
            continue

        package_spec_count = sum(
            len(item.get("specDocs") or []) for item in package.get("items", [])
        )
        if package_spec_count == 0:
            blocked_packages.append({
                **package,
                "reason": "no spec docs — spec needs to be written before approval can be requested",
            })
            continue

        if not resume_token:
            missing_resume_tokens.append({
                "topic": topic,
                "reason": "missing lobster resumeToken (approval not staged; Lobster-native resume is required)",
                "itemCount": len(package.get("items", [])),
            })
            blocked_packages.append({
                **package,
                "reason": "missing lobster resumeToken",
            })
            continue

        approval_id = _generate_approval_id(topic)
        candidates.append({
            "package": package,
            "topic": topic,
            "approval_id": approval_id,
            "resume_token": resume_token,
        })
        approval_ids_out.append({
            "topic": topic,
            "approvalId": approval_id,
            "itemCount": len(package.get("items", [])),
        })

    for cand in candidates:
        package = cand["package"]
        topic = cand["topic"]
        approval_locks[topic] = {
            "approvalId": cand["approval_id"],
            "requestedAt": timestamp,
            "items": [item["bookmarkKey"] for item in package.get("items", []) if item.get("bookmarkKey")],
        }

    save_state(state, Path(STATE_PATH))

    for cand in candidates:
        package = cand["package"]
        topic = cand["topic"]
        approval_id = cand["approval_id"]
        resume_token = cand["resume_token"]

        delivery, delivery_error = resolve_delivery_config(topic)
        delivery_result = None
        if stage_only:
            delivery = None
            delivery_error = None
        summaries = []
        pending_state_updates: list[tuple[str, dict]] = []
        for item in package.get("items", []):
            bookmark_key = item["bookmarkKey"]
            state_item = dict(items.get(bookmark_key, {}))
            previous_status = state_item.get("reviewStatus")
            proposed_tasks = item.get("proposedTasks") or hydrate_proposed_tasks_from_state(state_item)
            spec_docs = item.get("specDocs") or state_item.get("specDocs") or []
            review_doc = item.get("reviewDoc") or state_item.get("reviewDoc")
            title = item.get("title") or state_item.get("title")
            topic_value = state_item.get("topic") or item.get("topic") or topic
            spec_proposals = state_item.get("specProposals") or []
            if isinstance(spec_proposals, list) and spec_proposals:
                proposal_title = (spec_proposals[0].get("title") or "").strip()
                if proposal_title:
                    title = proposal_title
            state_item["approvalTopic"] = topic
            state_item["approvalId"] = approval_id
            state_item["approvalStatus"] = "pending"
            state_item["approvalRequestedAt"] = timestamp
            state_item["approvalResumeToken"] = resume_token
            state_item["reviewStatus"] = "revision_staged" if stage_only else "approval_pending"
            state_item["lastUpdatedAt"] = timestamp
            state_item["_previousReviewStatus"] = previous_status
            pending_state_updates.append((bookmark_key, state_item))
            summaries.append({
                "bookmarkKey": bookmark_key,
                "path": state_item.get("path") or item.get("path"),
                "topic": topic_value,
                "title": title,
                "summary": item.get("summary") or state_item.get("summary"),
                "whyItMatters": item.get("whyItMatters") or state_item.get("whyItMatters"),
                "reviewDoc": review_doc,
                "specDocs": spec_docs,
                "proposedTasks": proposed_tasks,
            })
        hydrated_package = {
            **package,
            "items": summaries,
            "proposedTasks": [task for item in summaries for task in (item.get("proposedTasks") or [])],
        }
        message = build_approval_message(hydrated_package, approval_id)
        delivery_confirmed = False
        delivered_message_id = None
        delivered_thread_id = None
        if delivery:
            try:
                delivery_result = deliver_approval_message(message, delivery)
                if isinstance(delivery_result, dict):
                    delivered_message_id = delivery_result.get("messageId")
                    delivered_thread_id = delivery_result.get("threadId")
                    result_payload = delivery_result.get("result") or {}
                    if isinstance(result_payload, dict) and result_payload.get("error"):
                        delivery_error = str(result_payload.get("error"))
                delivery_confirmed = bool(delivered_message_id)
            except Exception as exc:  # noqa: BLE001
                delivery_error = str(exc)
        if delivery and not delivery_confirmed and not delivery_error:
            delivery_error = "approval message did not return a messageId"
        persist_claim = stage_only or delivery_confirmed
        if persist_claim:
            for bookmark_key, state_item in pending_state_updates:
                previous_status = state_item.pop("_previousReviewStatus", None)
                if delivered_message_id:
                    state_item["approvalMessageId"] = delivered_message_id
                if delivered_thread_id:
                    state_item["approvalThreadId"] = delivered_thread_id
                elif stage_only and delivery and delivery.get("threadId"):
                    state_item["approvalThreadId"] = delivery.get("threadId")
                items[bookmark_key] = state_item
                log_transition(
                    bookmark_key,
                    previous_status,
                    state_item.get("reviewStatus"),
                    f"approval request staged for topic={topic}; stageOnly={stage_only}",
                    transitions_path=transition_log_path(Path(STATE_PATH)),
                )
        else:
            approval_locks.pop(topic, None)
        approvals.append({
            "topic": topic,
            "approvalId": approval_id,
            "stageOnly": stage_only,
            "resumeToken": resume_token,
            "summary": f"Approval needed for {len(package.get('items', []))} bookmark-derived plan(s)",
            "items": summaries,
            "proposedTasks": hydrated_package["proposedTasks"],
            "message": message,
            "delivery": delivery_result,
            "deliveryError": delivery_error,
        })

    if candidates:
        save_state(state, Path(STATE_PATH))

    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "approvals": approvals,
        "approvalIds": approval_ids_out,
        "blockedPackages": blocked_packages,
        "missingResumeTokens": missing_resume_tokens,
        "monitoring": data.get("monitoring", []),
        "reviewed": data.get("reviewed", []),
        "stageOnly": stage_only,
        "note": "Approval claim, delivery, and state persistence are serialized with an OS file lock. Failed deliveries release their topic lock for retry.",
    })
    return 0


def main() -> int:
    data = json.load(__import__("sys").stdin)
    with approval_state_lock(Path(STATE_PATH)):
        return _main_locked(data)


if __name__ == "__main__":
    raise SystemExit(main())
