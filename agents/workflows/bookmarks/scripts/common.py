#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import select
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

_env_ws = os.environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env_ws).resolve() if _env_ws else Path(__file__).resolve().parents[6]
# brain is a symlink to iCloud - don't resolve it to avoid cross-device paths
BOOKMARKS_ROOT = WORKSPACE / "brain" / "bookmarks"
REVIEWS_ROOT = WORKSPACE / "brain" / "bookmarks" / "summaries"
SPECS_ROOT = WORKSPACE / "brain" / "bookmarks" / "specs"
STATE_ROOT = WORKSPACE / "brain" / "state"
STATE_PATH = STATE_ROOT / "bookmark-review-state.json"
TRANSITIONS_PATH = STATE_ROOT / "bookmark-transitions.jsonl"
STATE_OF_NATION_PATH = WORKSPACE / "docs" / "state-of-the-nation.md"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
KV_RE = re.compile(r"^([A-Za-z0-9_]+):\s*(.*)$")

FOCUS_CONFIG_PATH = WORKSPACE / "brain" / "state" / "focus-config.json"


class LLMInvocationError(RuntimeError):
    pass


class LLMOutputValidationError(RuntimeError):
    pass


_LAST_LLM_PROVENANCE: dict[str, Any] | None = None


def log_debug(message: str) -> None:
    print(f"[bookmark-debug] {message}", file=sys.stderr, flush=True)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def dump_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def get_approval_topic(item: dict[str, Any] | None) -> str:
    """Return the topic used by the approval gate for an item.

    Resolution order:
      1. item.curation.topic   (the curator's verdict, current model)
      2. item.approvalTopic    (legacy alias from the old schema)
      3. item.relevanceTopic   (legacy alias from the old schema)
      4. item.topic            (the bookmark's ingested topic)
      5. "general"             (last-resort default)
    """
    if not item:
        return "general"
    curation = item.get("curation") or {}
    return (
        curation.get("topic")
        or item.get("approvalTopic")
        or item.get("relevanceTopic")
        or item.get("topic")
        or "general"
    )


def read_first_json_value(stream: Any, timeout_seconds: float = 5.0) -> Any:
    decoder = json.JSONDecoder()
    buffer = ""
    try:
        fd = stream.fileno()
    except (AttributeError, io.UnsupportedOperation):
        return json.load(stream)
    while True:
        ready, _, _ = select.select([fd], [], [], timeout_seconds)
        if not ready:
            if buffer.strip():
                stripped = buffer.lstrip()
                try:
                    value, _ = decoder.raw_decode(stripped)
                    return value
                except json.JSONDecodeError:
                    raise TimeoutError("timed out waiting for complete JSON on stdin")
            raise TimeoutError("timed out waiting for JSON on stdin")
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        buffer += chunk.decode("utf-8")
        stripped = buffer.lstrip()
        if not stripped:
            continue
        try:
            value, _ = decoder.raw_decode(stripped)
            return value
        except json.JSONDecodeError:
            continue
    if not buffer.strip():
        raise json.JSONDecodeError("Expecting value", buffer, 0)
    stripped = buffer.lstrip()
    value, _ = decoder.raw_decode(stripped)
    return value


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw = m.group(1)
    body = text[m.end():]
    meta: dict[str, Any] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kv = KV_RE.match(line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            try:
                meta[key] = json.loads(value)
                continue
            except Exception:
                pass
        if value.startswith('"') and value.endswith('"'):
            meta[key] = value[1:-1]
        else:
            meta[key] = value
    return meta, body.strip()


def topic_from_path(path: Path, root: Path | None = None) -> str:
    root = root or BOOKMARKS_ROOT
    try:
        rel = path.resolve().relative_to(root.resolve())
        parts = rel.parts
        if not parts:
            return "general"
        # Bookmark layout is bookmarks/<source>/<category>/... .
        # Source stays in the bookmark path, but workflow topic/routing should
        # come from the category directory, not the source directory.
        if len(parts) >= 2:
            return parts[1] or "general"
        return parts[0] or "general"
    except Exception:
        return "general"


def bookmark_workspace_relpath(path: Path, root: Path | None = None) -> str:
    root = root or BOOKMARKS_ROOT
    try:
        rel = path.resolve().relative_to(root.resolve())
        return str(Path("brain") / "bookmarks" / rel)
    except Exception:
        try:
            return str(path.relative_to(WORKSPACE))
        except Exception:
            return str(path)


def bookmark_key(path: Path, meta: dict[str, Any]) -> str:
    canonical = meta.get("link") or meta.get("source_tweet") or bookmark_workspace_relpath(path)
    digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]
    return digest


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "bookmark"


def state_template() -> dict[str, Any]:
    return {
        "version": 1,
        "updatedAt": now_iso(),
        "items": {},
        "approvalLocks": {},
    }


def load_state(state_path: Path = STATE_PATH) -> dict[str, Any]:
    if not state_path.exists():
        return state_template()
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return state_template()
    if "items" not in data or not isinstance(data["items"], dict):
        data["items"] = {}
    if "approvalLocks" not in data or not isinstance(data["approvalLocks"], dict):
        data["approvalLocks"] = {}
    return data


def save_state(state: dict[str, Any], state_path: Path = STATE_PATH) -> None:
    state["updatedAt"] = now_iso()
    ensure_parent(state_path)
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def transition_log_path(state_path: Path = STATE_PATH) -> Path:
    return Path(state_path).with_name(TRANSITIONS_PATH.name)


def clear_approval_lock(state: dict, approval_id: str) -> str | None:
    """Remove the approvalLocks entry whose approvalId matches. Returns the
    topic that was locked, or None if no match was found.

    Used by handle_approval_reply, resolve_spec_request, and the
    revision-request flow to release the self-asserting global lock
    once the approval is resolved. Idempotent — calling on a state
    without the lock is a no-op.
    """
    if not approval_id:
        return None
    locks = state.get("approvalLocks")
    if not isinstance(locks, dict):
        return None
    target = str(approval_id).strip().lower()
    for topic, lock in list(locks.items()):
        if not isinstance(lock, dict):
            continue
        if str(lock.get("approvalId") or "").strip().lower() == target:
            del locks[topic]
            return topic
    return None


def log_transition(
    key: str,
    from_status: str | None,
    to_status: str | None,
    reason: str,
    *,
    transitions_path: Path | None = None,
) -> None:
    path = transitions_path or TRANSITIONS_PATH
    ensure_parent(path)
    # Duplicate guard: skip if the last recorded transition for this key already has the same `to` status
    if path.exists():
        try:
            last_for_key: dict[str, Any] | None = None
            with open(path, "r", encoding="utf-8") as fh:
                for raw_line in fh:
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        entry = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("key") == str(key):
                        last_for_key = entry
            if last_for_key is not None and last_for_key.get("to") == to_status:
                return
        except OSError:
            pass
    actor = (os.getenv("BOOKMARK_TRANSITION_ACTOR") or Path(sys.argv[0]).name or "unknown").strip()
    event = {
        "key": str(key),
        "from": from_status,
        "to": to_status,
        "at": now_iso(),
        "actor": actor,
        "reason": str(reason or "").strip(),
    }
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)

    # Best-effort Postgres analytics mirror. Runs only after the JSONL
    # append has succeeded so the JSONL remains the authoritative source
    # of truth; a DB failure here is logged but never raised. See
    # analytics_db.insert_transition() for the full contract.
    try:
        from analytics_db import insert_transition

        insert_transition(
            {
                "bookmark_key": event["key"],
                "from_status": event["from"],
                "to_status": event["to"],
                "actor": event["actor"],
                "source": "bookmark-workflow",
                "payload": {"reason": event["reason"], "at": event["at"]},
            }
        )
    except Exception as e:  # pragma: no cover - defensive guard
        log_debug(f"[bookmark-analytics] insert skipped: {e}")


def bookmark_record(path: Path) -> dict[str, Any]:
    text = load_text(path)
    meta, body = parse_frontmatter(text)
    root = BOOKMARKS_ROOT
    rel = None
    source = meta.get("source")
    try:
        rel = path.resolve().relative_to(root.resolve())
    except Exception:
        rel = None
    topic = topic_from_path(path)
    if not source and rel and len(rel.parts) >= 1:
        source = rel.parts[0]
    if not source:
        source = "x" if meta.get("source_tweet") else "unknown"
    key = bookmark_key(path, meta)
    body_excerpt = body[:1200].strip()
    return {
        "bookmarkKey": key,
        "path": bookmark_workspace_relpath(path),
        "topic": topic or "general",
        "source": source,
        "title": meta.get("title") or path.stem,
        "link": meta.get("link") or meta.get("source_tweet") or "",
        "sourceTweet": meta.get("source_tweet") or "",
        "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
        "type": meta.get("type") or topic,
        "dateArchived": meta.get("date_archived") or "",
        "body": body,
        "bodyExcerpt": body_excerpt,
        "meta": meta,
    }


def workspace_path(path_str: str) -> Path:
    return WORKSPACE / path_str


def bookmark_record_from_workspace_path(path_str: str) -> dict[str, Any]:
    return bookmark_record(workspace_path(path_str))


def merge_bookmark_context(base: dict[str, Any], path_str: str | None = None) -> dict[str, Any]:
    target_path = path_str or base.get("path")
    if not target_path:
        return dict(base)

    try:
        record = bookmark_record_from_workspace_path(target_path)
    except FileNotFoundError:
        return dict(base)

    merged = dict(record)
    merged.update({k: v for k, v in base.items() if v not in (None, "", [], {})})
    return merged


def load_state_of_nation() -> str:
    if not STATE_OF_NATION_PATH.exists():
        return ""
    text = load_text(STATE_OF_NATION_PATH).strip()
    return text[:12000]


def bookmark_workspace_context(topic: str) -> dict[str, Any]:
    shared = {
        "project": "OpenClaw chief-of-staff stack",
        "owner": "Tom Stoffer",
        "framingReminder": "The bookmark's own framing is the spec's center of gravity. The state-of-the-nation document, frictions, and topic profile are relevance signals — they tell you whether the bookmark belongs in this topic's domain, not what the bookmark is about. Do not re-shape the bookmark onto our frictions. The spec generation prompt has the full faithfulness rule.",
        "currentState": [
            "Bookmark ingest lives in agents/skills/bookmarks/x-ingest/scripts/",
            "Review workflow scripts live under agents/workflows/bookmarks/scripts/",
            "Review state is stored in brain/state/bookmark-review-state.json",
            "Pipeline orchestration target is agents/workflows/bookmarks/bookmarks.lobster.yaml",
        ],
        "goals": [
            "Automate repetitive work around planning, tasks, memory, and operations",
            "Prefer practical leverage over novelty or feature tourism",
            "Turn useful inbound research into judged reviews and implementation-ready plans",
        ],
        "constraints": [
            "No task creation yet",
            "Monitored bookmarks get a review only, with no spec, approval request, or tasks",
            "Only one bookmark approval may be pending globally",
            "Topic routing comes from brain/bookmarks/<topic>/...",
            "One bookmark may produce one or many specs when warranted",
        ],
        "decisionHeuristics": [
            "Favor ideas that improve Quinn/OpenClaw operating leverage, reliability, or clarity",
            "Down-rank ideas that require a new product surface with no clear path into the existing workspace",
            "Prefer thin slices that can be implemented incrementally in the current Python and markdown-based workflow",
        ],
    }

    topic_profiles = {
        "infra": {
            "stackFocus": "the OpenClaw runtime stack: agent orchestration, workflow plumbing, state files, observability, deployment, host hardening, and the scripts/lobsters that wire them together",
            "adjacentComponents": [
                "agents/workflows/bookmarks/scripts/*.py",
                "agents/skills/bookmarks/x-ingest/scripts/x/*.cjs",
                "agents/workflows/bookmarks/bookmarks.lobster.yaml",
                "brain/state/bookmark-review-state.json",
                "infra/runbooks/ and infra/RUNBOOKS.md",
                "codebases/sindustries/infra/ (Grafana, OTel, Prometheus)",
            ],
            "evaluationQuestions": [
                "Is the bookmark about a layer of the OpenClaw runtime, host operation, or wiring between them?",
                "Could it land in scripts/, infra/, or a lobster without inventing a new product surface?",
                "If it touches reliability, observability, or host hardening, does it integrate with what we already run (OTel/Prometheus/Grafana, the runbook set, the daily health review) rather than proposing a parallel stack?",
            ],
        },
        "app-assistant": {
            "stackFocus": "chief-of-staff assistant surfaces: calendar workflows, meeting/transcript capture, follow-ups, action extraction, reminders, and operator UX",
            "adjacentComponents": [
                "workspace memory files (MEMORY.md, memory/YYYY-MM-DD.md)",
                "calendar tooling (ical, gog)",
                "approval and task planning flow",
                "future assistant-facing product surfaces",
            ],
            "evaluationQuestions": [
                "Is the bookmark about how Tom interacts with Quinn, or about a surface Quinn exposes to Tom?",
                "Does it support a specific recurring workflow (calendar, meetings, follow-ups, capture) rather than generic assistant features?",
                "Could it land in workspace memory, daily notes, the calendar tooling, or the approval flow without needing a new runtime?",
            ],
        },
        "app-tasks": {
            "stackFocus": "task workflow itself: planning, triage, approval flow, backlog, state transitions, and progress reporting",
            "adjacentComponents": [
                "scripts/bookmarks/lobster_request_spec_approval.py",
                "Tasks API",
            ],
            "evaluationQuestions": [
                "Is the bookmark about how a task is shaped, triaged, approved, transitioned, or reported — rather than about a specific task domain?",
                "Could it land in the Tasks API + bookmark-pipeline spec workflow without inventing a new system?",
                "Does it sharpen an existing workflow step, rather than adding a new feature surface?",
            ],
        },
        "brain": {
            "stackFocus": "memory capture, review quality, information organization, and synthesis",
            "adjacentComponents": [
                "brain/bookmarks/",
                "brain/bookmarks/summaries/",
                "MEMORY.md and daily memory files",
            ],
            "evaluationQuestions": [
                "Does this improve how inbound knowledge becomes useful working context?",
                "Does it reduce noise or increase retrieval quality?",
                "Can the benefit be realized inside the existing markdown workspace?",
            ],
        },
        "outreach": {
            "stackFocus": "content pipelines, distribution experiments, and builder reputation",
            "adjacentComponents": [
                "brain/posts/",
                "bookmark-driven ideation",
                "topic approval flow before execution",
            ],
            "evaluationQuestions": [
                "Does this support Tom's builder visibility or network-building goals?",
                "Is there a concrete workflow improvement rather than generic audience advice?",
                "Can it be tested incrementally without creating a broad marketing system first?",
            ],
        },
        "crypto": {
            "stackFocus": "crypto operations, monitoring, alerting, and decision support",
            "adjacentComponents": [
                "event-driven monitors",
                "cost-sensitive automation",
                "Tom's BTC/ETH-heavy portfolio context",
            ],
            "evaluationQuestions": [
                "Does this create practical monitoring or decision leverage?",
                "Is it safer and more actionable than generic trading inspiration?",
                "Can it be implemented with explicit guardrails and narrow scope?",
            ],
        },
        "design": {
            "stackFocus": "taste, interface clarity, and differentiated product presentation",
            "adjacentComponents": [
                "brain/bookmarks/summaries/",
                "brain/bookmarks/specs/",
                "future product-facing surfaces",
            ],
            "evaluationQuestions": [
                "Does this sharpen product taste or execution quality in a way the stack can use?",
                "Is it specific enough to turn into an implementation decision?",
                "Would it change how a real surface is built, not just how it is described?",
            ],
        },
        "personal": {
            "stackFocus": "Tom's personal systems, leverage, routines, and decision hygiene",
            "adjacentComponents": [
                "calendar and memory workflows",
                "chief-of-staff operating routines",
                "family/time constraints",
            ],
            "evaluationQuestions": [
                "Does this support Tom's real constraints and leverage goals?",
                "Is it actionable inside OpenClaw rather than generic self-help?",
                "Would building it meaningfully improve day-to-day operating quality?",
            ],
        },
        "general": {
            "stackFocus": "cross-cutting workspace improvements that do not cleanly fit another topic",
            "adjacentComponents": [
                "shared bookmark workflow scripts",
                "approval flow",
                "markdown workspace conventions",
            ],
            "evaluationQuestions": [
                "Does this map to something we would actually build or change here?",
                "Is the idea concrete enough to survive contact with the current stack?",
                "Would it produce leverage soon enough to justify attention now?",
            ],
        },
    }

    profile = topic_profiles.get(topic or "general", topic_profiles["general"])
    return {
        **shared,
        "topic": topic or "general",
        "stateOfTheNation": load_state_of_nation(),
        **profile,
    }


def find_bookmark_files(root: Path = BOOKMARKS_ROOT) -> list[Path]:
    if not root.exists():
        return []
    return sorted([p for p in root.rglob("*.md") if p.is_file()])


def llm_provenance() -> dict[str, Any] | None:
    return dict(_LAST_LLM_PROVENANCE) if _LAST_LLM_PROVENANCE else None


def invoke_llm_json(prompt: str, input_payload: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    global _LAST_LLM_PROVENANCE
    model = (os.getenv("BOOKMARK_LLM_MODEL") or "minimax").strip()
    # Default to the non-recursive acpx/codex path first. Agent-direct bookmark LLM
    # calls can recursively spawn Quinn sessions from inside Quinn-owned workflows,
    # which causes silent stalls and session-lock contention under cron/manual runs.
    use_agent_direct = os.getenv("BOOKMARK_LLM_USE_AGENT_DIRECT", "false").strip().lower() in {"1", "true", "yes"}
    if use_agent_direct:
        return invoke_llm_json_via_agent(prompt, input_payload, schema)

    acpx_command = (os.getenv("BOOKMARK_LLM_ACPX_COMMAND") or "/opt/homebrew/bin/acpx").strip()
    timeout_seconds = int((os.getenv("BOOKMARK_LLM_TIMEOUT_SECONDS") or "120").strip())
    fallback_mode = (os.getenv("BOOKMARK_LLM_FALLBACK") or "agent").strip()
    message = build_agent_json_prompt(prompt, input_payload, schema)
    args = [
        acpx_command,
        "--approve-all",
        "--format",
        "quiet",
    ]
    if model:
        args.extend(["--model", model])
    args.extend([
        "codex",
        "exec",
        "-f",
        "-",
    ])
    try:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            input=message,
            cwd=str(WORKSPACE),
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        if fallback_mode in {"agent", "agent-on-timeout"}:
            return invoke_llm_json_via_agent(prompt, input_payload, schema)
        raise LLMInvocationError(
            f"bookmark LLM invocation via acpx/codex timed out after {timeout_seconds}s"
        ) from exc
    except FileNotFoundError as exc:
        raise LLMInvocationError("bookmark LLM invocation requires acpx/codex to be installed") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or str(exc)
        if fallback_mode.startswith("agent") or "internal error" in detail.lower():
            return invoke_llm_json_via_agent(prompt, input_payload, schema)
        raise LLMInvocationError(f"bookmark LLM invocation via acpx/codex failed: {detail}") from exc

    raw = (completed.stdout or "").strip()
    if not raw or "internal error" in raw.lower():
        if fallback_mode.startswith("agent"):
            return invoke_llm_json_via_agent(prompt, input_payload, schema)
        raise LLMInvocationError("bookmark LLM invocation returned empty output")
    _LAST_LLM_PROVENANCE = {
        "path": "acpx",
        "model": model or None,
        "command": acpx_command,
        "timeoutSeconds": timeout_seconds,
        "fallbackMode": fallback_mode,
    }
    return extract_json_object(raw)


def build_agent_json_prompt(prompt: str, input_payload: dict[str, Any], schema: dict[str, Any]) -> str:
    return (
        "You are performing a structured bookmark workflow step.\n"
        "Return exactly one JSON object and nothing else.\n"
        "Do not wrap it in markdown fences.\n"
        "Every required field must be present.\n"
        "Do not include explanatory text before or after the JSON.\n\n"
        f"Task prompt:\n{prompt}\n\n"
        f"Input JSON:\n{json.dumps(input_payload, ensure_ascii=False, indent=2)}\n\n"
        f"Required output schema:\n{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def extract_json_object(text: str) -> dict[str, Any]:
    candidate = text.strip()
    attempts = [candidate]
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end != -1 and end > start:
        attempts.append(candidate[start : end + 1])

    for raw in attempts:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise LLMInvocationError(f"bookmark agent output was not valid JSON: {candidate[:300]}")


def extract_first_json_value(text: str) -> Any:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
            return value
        except json.JSONDecodeError:
            continue
    raise LLMInvocationError(f"bookmark output was not valid JSON: {text[:300]}")


def invoke_llm_json_via_agent(prompt: str, input_payload: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    global _LAST_LLM_PROVENANCE
    agent_id = (os.getenv("BOOKMARK_LLM_AGENT") or "quinn").strip() or "quinn"
    session_id = f"bookmark-llm-{uuid.uuid4().hex}"
    timeout_seconds = int((os.getenv("BOOKMARK_LLM_AGENT_TIMEOUT_SECONDS") or "180").strip())
    message = build_agent_json_prompt(prompt, input_payload, schema)
    args = [
        "openclaw",
        "agent",
        "--agent",
        agent_id,
        "--session-id",
        session_id,
        "--message",
        message,
        "--timeout",
        str(timeout_seconds),
        "--json",
    ]
    try:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise LLMInvocationError("openclaw CLI not found for bookmark analysis") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or str(exc)
        raise LLMInvocationError(f"bookmark agent fallback failed: {detail}") from exc

    raw = (completed.stdout or "").strip()
    if not raw:
        raise LLMInvocationError("bookmark agent fallback returned empty output")

    # Try multiple extraction strategies
    wrapper = extract_first_json_value(raw)
    if isinstance(wrapper, dict):
        # Strategy 1: Check for {"result": {"payloads": [...]}} pattern
        result_obj = wrapper.get("result") or wrapper
        payloads = result_obj.get("payloads")
        if isinstance(payloads, list) and payloads:
            text = payloads[0].get("text") if isinstance(payloads[0], dict) else None
            if isinstance(text, str) and text.strip():
                inner = extract_json_object(text)
                if inner:
                    _LAST_LLM_PROVENANCE = {
                        "path": "openclaw-agent-fallback-payloads",
                        "agentId": agent_id,
                        "sessionId": session_id,
                        "timeoutSeconds": timeout_seconds,
                    }
                    return inner

        # Strategy 2: Check for {"analysis": {...}} or {"response": {...}} wrapper
        for key in ("analysis", "response", "data", "output"):
            if key in result_obj and isinstance(result_obj[key], dict):
                inner = result_obj[key]
                if "classification" in inner:
                    _LAST_LLM_PROVENANCE = {
                        "path": "openclaw-agent-fallback-wrapped",
                        "agentId": agent_id,
                        "sessionId": session_id,
                        "timeoutSeconds": timeout_seconds,
                    }
                    return inner

        # Strategy 3: Check if wrapper directly has classification (nested)
        if "classification" in result_obj:
            _LAST_LLM_PROVENANCE = {
                "path": "openclaw-agent-fallback-direct",
                "agentId": agent_id,
                "sessionId": session_id,
                "timeoutSeconds": timeout_seconds,
            }
            return result_obj

        # If nothing extracted, return wrapper but let caller handle
        _LAST_LLM_PROVENANCE = {
            "path": "openclaw-agent-fallback-raw",
            "agentId": agent_id,
            "sessionId": session_id,
            "timeoutSeconds": timeout_seconds,
        }
        return result_obj

    # Fallback: try raw extraction
    extracted = extract_json_object(raw)
    if extracted:
        _LAST_LLM_PROVENANCE = {
            "path": "openclaw-agent-fallback-raw-fallback",
            "agentId": agent_id,
            "sessionId": session_id,
            "timeoutSeconds": timeout_seconds,
        }
        return extracted

    raise LLMInvocationError(f"bookmark agent fallback could not parse output: {raw[:200]}")


def expect_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        if value is None:
            raise LLMOutputValidationError(f"{field} must be a string")
        if isinstance(value, dict):
            for k in ("value", "text", "content", "result", "classification"):
                if k in value and isinstance(value[k], str) and value[k].strip():
                    return value[k].strip()
            if value:
                first_val = next((v for v in value.values() if isinstance(v, str) and v.strip()), None)
                if first_val:
                    return first_val.strip()
            raise LLMOutputValidationError(f"{field} must be a string")
        coerced = str(value).strip()
        if not coerced:
            raise LLMOutputValidationError(f"{field} must not be empty after coercion")
        return coerced
    cleaned = value.strip()
    if not cleaned:
        raise LLMOutputValidationError(f"{field} must not be empty")
    return cleaned


def expect_string_list(value: Any, field: str, min_items: int = 0) -> list[str]:
    # Handle None
    if value is None:
        if min_items > 0:
            raise LLMOutputValidationError(f"{field} must be an array with at least {min_items} item(s)")
        return []
    # Handle non-list types
    if not isinstance(value, list):
        # String - could be a single item or comma-separated
        if isinstance(value, str):
            if value.strip():
                # Check if it looks like a list (contains newlines or commas)
                if "," in value or "\n" in value:
                    # Split and clean
                    items = [x.strip() for x in value.replace(",", "\n").split("\n") if x.strip()]
                    if len(items) >= min_items:
                        return items
                return [value.strip()]
            return []
        # Dict - try to extract string values
        if isinstance(value, dict):
            vals = []
            for v in value.values():
                if isinstance(v, str) and v.strip():
                    vals.append(v.strip())
                elif isinstance(v, list):
                    # Recurse for nested lists
                    vals.extend(expect_string_list(v, field, 0))
            if vals:
                return vals
            # Try to find a list value
            for v in value.values():
                if isinstance(v, list):
                    return expect_string_list(v, field, min_items)
            if min_items > 0:
                raise LLMOutputValidationError(f"{field} dict has no string values")
            return []
        # Unknown type
        raise LLMOutputValidationError(f"{field} must be an array, got {type(value).__name__}")
    # It's already a list - process items
    cleaned = []
    for index, item in enumerate(value):
        if not isinstance(item, str):
            if item is None:
                continue
            if isinstance(item, dict):
                for k in ("value", "text", "content", "result"):
                    if k in item and isinstance(item[k], str) and item[k].strip():
                        cleaned.append(item[k].strip())
                        break
                continue
            coerced = str(item).strip()
            if coerced:
                cleaned.append(coerced)
            continue
        text = item.strip()
        if not text:
            raise LLMOutputValidationError(f"{field}[{index}] must not be empty")
        cleaned.append(text)
    if len(cleaned) < min_items:
        raise LLMOutputValidationError(f"{field} must contain at least {min_items} item(s)")
    return cleaned


def parser_common(description: str) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--json", action="store_true", help="Emit JSON result")
    return p
