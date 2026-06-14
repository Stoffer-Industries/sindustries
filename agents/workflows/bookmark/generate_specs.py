#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from pathlib import Path as P

from common import (
    LLMOutputValidationError,
    SPECS_ROOT,
    STATE_PATH,
    WORKSPACE,
    bookmark_workspace_context,
    dump_json,
    ensure_parent,
    expect_string,
    expect_string_list,
    invoke_llm_json,
    load_state,
    load_text,
    log_transition,
    merge_bookmark_context,
    now_iso,
    save_state,
    slugify,
    transition_log_path,
)

def to_wiki_link(path: str) -> str:
    """Convert file path to Obsidian-style wiki link [[filename]].
    
    Examples:
        brain/bookmarks/summaries/foo.md -> [[foo.md]]
        brain/bookmarks/specs/bar.md -> [[bar.md]]
    """
    if not path:
        return path
    return f"[[{P(path).name}]]"


SPEC_PROMPT = """You are drafting implementation specs from a reviewed bookmark for Tom Stoffer's OpenClaw workspace.
The review already decided this item is worth implementation work. Your job is to turn that into real, stack-aware delivery plans.

Faithfulness rule (read carefully): the spec's framing must reflect the bookmark and the review's headline. The state-of-the-nation document and topic profile are relevance signals, not a target list to re-shape the bookmark onto. If the bookmark describes a multi-part idea (e.g. a modular memory kit with N memory types), the spec must address those parts — even if our frictions only mention one of them. A spec that drops most of the bookmark to fit our problem list is a quality failure, regardless of how cleanly the partial fit lands. If only a small part of the bookmark is actually relevant to us, that is a signal the review should have been `monitor`, not `implement` — say so in the spec's `problemStatement` and recommend the right review reclassification instead of forcing a partial spec.

Output quality bar:
- Produce plans that could actually be built in this repository and workflow
- Prefer one spec when there is a single coherent slice
- Split into multiple specs only when the work naturally separates into distinct tracks with independent value
- Proposed tasks should feel like credible incremental slices, not phases in disguise
- Proposed tasks should usually map to work that could land in a single PR with a noticeable outcome

Rules:
- Stay grounded in the current bookmark pipeline, topic context, and review analysis
- Name concrete touchpoints in the existing stack where appropriate
- Keep assignee blank in proposed tasks
- Do not suggest creating tasks yet; only draft specs and proposed slices
- Avoid placeholder language like "validate", "explore", or "refine" unless paired with a concrete deliverable
- Write like an implementation note for this repository, not a consulting-style product brief
- Prefer specific file/process references over generic "system" or "platform" wording
- Default to 1-3 proposed tasks per spec unless the work clearly needs more separable PRs
- Do not split tasks by acceptance criterion alone
- A good task may include multiple commits and multiple acceptance criteria if together they produce one reviewable, noticeable change
- When the work clearly spans different codebases, repos, runtime domains, or rollout surfaces, use those boundaries as a valid reason to split tasks
- If a proposed task would re-build something we already have, name the existing thing (file or branch) it would supersede, and either propose a smaller complementary slice or call out the duplication explicitly in the task's `why`
- If a friction in the state-of-the-nation is genuinely central to the spec, name it in `problemStatement`; do not use it as the spec's reason for being if the bookmark's own framing is broader"""

SPEC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "specs": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "specType": {"type": "string"},
                    "whySeparateNow": {"type": "string"},
                    "outcome": {"type": "string"},
                    "problemStatement": {"type": "string"},
                    "approach": {"type": "string"},
                    "stackTouchpoints": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "scopeBoundaries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "risksAndUnknowns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "incrementalRollout": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "successChecks": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "proposedTasks": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "priority": {"type": "string"},
                                "summary": {"type": "string"},
                                "deliverable": {"type": "string"},
                                "acceptanceCriteria": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "minItems": 1,
                                },
                            },
                            "required": ["title", "priority", "summary", "deliverable", "acceptanceCriteria"],
                        },
                    },
                },
                "required": [
                    "title",
                    "specType",
                    "whySeparateNow",
                    "outcome",
                    "problemStatement",
                    "approach",
                    "stackTouchpoints",
                    "scopeBoundaries",
                    "risksAndUnknowns",
                    "incrementalRollout",
                    "successChecks",
                    "proposedTasks",
                ],
            },
        }
    },
    "required": ["specs"],
}


def spec_doc_path(specs_root: Path, topic: str, spec_title: str, bookmark_key: str, index: int) -> Path:
    # flat — topic no longer appears in the file path
    suffix = "" if index == 0 else f"-part-{index + 1}"
    return specs_root / f"{slugify(spec_title)}-{bookmark_key}{suffix}.md"


def revised_spec_doc_path(topic: str, spec_doc: str) -> Path:
    # Revised specs live alongside current specs — flat, no topic subfolder
    spec_name = Path(spec_doc).stem + "-prev.md"
    return SPECS_ROOT / spec_name


def next_revised_live_spec_doc(spec_doc: str) -> str:
    path = Path(spec_doc)
    stem = path.stem
    suffix = path.suffix or ".md"
    if "-rev" in stem:
        base, rev_part = stem.rsplit("-rev", 1)
        if rev_part.isdigit():
            return str(path.with_name(f"{base}-rev{int(rev_part) + 1}{suffix}"))
    return str(path.with_name(f"{stem}-rev1{suffix}"))


def build_spec_md(item: dict[str, Any], spec: dict[str, Any], spec_rel: str, review_doc: str, previous_spec: str | None = None) -> str:
    stack_md = "\n".join(f"- {entry}" for entry in spec["stackTouchpoints"])
    scope_md = "\n".join(f"- {entry}" for entry in spec["scopeBoundaries"])
    risks_md = "\n".join(f"- {entry}" for entry in spec["risksAndUnknowns"])
    rollout_md = "\n".join(f"1. {entry}" for entry in spec["incrementalRollout"])
    success_md = "\n".join(f"- {entry}" for entry in spec["successChecks"])
    task_lines = []
    for task in spec["proposedTasks"]:
        ac_lines = "\n".join(f"  - {ac}" for ac in task["acceptanceCriteria"])
        task_lines.append(
            f"### {task['title']}\n\n"
            f"- **Priority:** `{task['priority']}`\n"
            f"- **Assignee:** _blank_\n"
            f"- **Why:** {task['summary']}\n"
            f"- **Deliverable:** {task['deliverable']}\n"
            f"- **Acceptance Criteria:**\n{ac_lines}"
        )
    tasks_md = "\n\n".join(task_lines)
    previous_spec_line = f"- **Previous Spec:** {to_wiki_link(previous_spec)}\n" if previous_spec else ""
    return f'''# Spec - {spec["title"]}

## Source
- **Bookmark:** {to_wiki_link(item["path"])}
- **Review:** {to_wiki_link(review_doc)}
- **Topic:** `{item["topic"]}`
- **Spec Path:** {to_wiki_link(spec_rel)}
{previous_spec_line}- **Spec Type:** `{spec["specType"]}`

## Intended Outcome

{spec["outcome"]}

## Why This Is Its Own Spec

{spec["whySeparateNow"]}

## Problem Statement

{spec["problemStatement"]}

## Proposed Approach

{spec["approach"]}

## Stack Touchpoints

{stack_md}

## Scope Boundaries

{scope_md}

## Risks / Unknowns

{risks_md}

## Incremental Rollout

{rollout_md}

## Success Checks

{success_md}

## Proposed Tasks

{tasks_md}
'''


def render_task_description(task: dict[str, Any], spec_doc: str, review_doc: str) -> str:
    ac_lines = "\n".join(f"- [ ] {line}" for line in task["acceptanceCriteria"])
    return (
        f"**What:** {task['title']}\n"
        f"**Why:** {task['summary']}\n\n"
        f"**Deliverable:** {task['deliverable']}\n\n"
        f"**AC:**\n{ac_lines}\n\n"
        f"**Spec:** {spec_doc}\n"
        f"**Source Review:** {review_doc}"
    )


def generate_spec_bundle(item: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    item = merge_bookmark_context(item)
    payload = {
        "bookmark": {
            "title": item.get("title", ""),
            "topic": item.get("topic", "general"),
            "path": item.get("path", ""),
            "source": item.get("source", "unknown"),
            "link": item.get("link", ""),
            "tags": item.get("tags", []),
            "bodyExcerpt": item.get("bodyExcerpt", ""),
            "body": item.get("body", ""),
        },
        "review": analysis,
        "workspaceContext": bookmark_workspace_context(item.get("topic", "general")),
        "constraints": {
            "assignee": "blank",
            "taskCreation": "disabled for now",
            "approval": "one pending approval per topic",
        },
    }
    raw = invoke_llm_json(SPEC_PROMPT, payload, SPEC_SCHEMA)
    specs = raw.get("specs")
    if not isinstance(specs, list) or not specs:
        raise LLMOutputValidationError("specs must contain at least one spec")

    normalized_specs = []
    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise LLMOutputValidationError(f"specs[{index}] must be an object")
        tasks = spec.get("proposedTasks")
        # Be resilient to partial/weak LLM output: skip specs that have no actionable tasks.
        if not isinstance(tasks, list) or not tasks:
            continue
        normalized_tasks = []
        for task_index, task in enumerate(tasks):
            if not isinstance(task, dict):
                raise LLMOutputValidationError(f"specs[{index}].proposedTasks[{task_index}] must be an object")
            normalized_tasks.append({
                "title": expect_string(task.get("title"), f"specs[{index}].proposedTasks[{task_index}].title"),
                "priority": expect_string(task.get("priority"), f"specs[{index}].proposedTasks[{task_index}].priority"),
                "summary": expect_string(task.get("summary"), f"specs[{index}].proposedTasks[{task_index}].summary"),
                "deliverable": expect_string(task.get("deliverable"), f"specs[{index}].proposedTasks[{task_index}].deliverable"),
                "acceptanceCriteria": expect_string_list(
                    task.get("acceptanceCriteria"),
                    f"specs[{index}].proposedTasks[{task_index}].acceptanceCriteria",
                    min_items=1,
                ),
            })
        normalized_specs.append({
            "title": expect_string(spec.get("title"), f"specs[{index}].title"),
            "specType": expect_string(spec.get("specType"), f"specs[{index}].specType"),
            "whySeparateNow": expect_string(spec.get("whySeparateNow"), f"specs[{index}].whySeparateNow"),
            "outcome": expect_string(spec.get("outcome"), f"specs[{index}].outcome"),
            "problemStatement": expect_string(spec.get("problemStatement"), f"specs[{index}].problemStatement"),
            "approach": expect_string(spec.get("approach"), f"specs[{index}].approach"),
            "stackTouchpoints": expect_string_list(spec.get("stackTouchpoints"), f"specs[{index}].stackTouchpoints", min_items=1),
            "scopeBoundaries": expect_string_list(spec.get("scopeBoundaries"), f"specs[{index}].scopeBoundaries", min_items=1),
            "risksAndUnknowns": expect_string_list(
                spec.get("risksAndUnknowns"),
                f"specs[{index}].risksAndUnknowns",
                min_items=1,
            ),
            "incrementalRollout": expect_string_list(
                spec.get("incrementalRollout"),
                f"specs[{index}].incrementalRollout",
                min_items=1,
            ),
            "successChecks": expect_string_list(
                spec.get("successChecks"),
                f"specs[{index}].successChecks",
                min_items=1,
            ),
            "proposedTasks": normalized_tasks,
        })
    if not normalized_specs:
        raise LLMOutputValidationError("specs must include at least one spec with proposed tasks")
    return {"specs": normalized_specs}


REVISION_PROMPT = """You are revising bookmark-derived implementation specs for Tom Stoffer's OpenClaw workspace.
A human reviewed a pending approval package and requested changes. Update the actual spec content and the proposed task set to reflect the revision faithfully.

Rules:
- Preserve the overall intent of the underlying spec unless the human clearly redirects it
- Apply the human's requested changes to both the spec body and proposed tasks
- You may remove, rewrite, reorder, split, or add tasks as needed
- Keep output grounded in the existing repository/workflow context
- Keep assignee blank / null
- Return the full revised spec set, not a diff
- Be conservative: do not invent broad new work unless the revision asks for it
- Prefer clear implementation slices with concrete deliverables and acceptance criteria
- Proposed tasks should usually map to single-PR-sized deliverables with noticeable user/dev-facing change
- Do not split tasks by acceptance criterion alone
- Use codebase/repo/domain boundaries as a reason to split tasks when those boundaries imply separate PRs or rollout risk
"""

REVISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "specs": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "specDoc": {"type": "string"},
                    "specType": {"type": "string"},
                    "whySeparateNow": {"type": "string"},
                    "outcome": {"type": "string"},
                    "problemStatement": {"type": "string"},
                    "approach": {"type": "string"},
                    "stackTouchpoints": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "scopeBoundaries": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "risksAndUnknowns": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "incrementalRollout": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "successChecks": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "proposedTasks": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "priority": {"type": "string"},
                                "summary": {"type": "string"},
                                "deliverable": {"type": "string"},
                                "acceptanceCriteria": {"type": "array", "items": {"type": "string"}, "minItems": 1}
                            },
                            "required": ["title", "priority", "summary", "deliverable", "acceptanceCriteria"]
                        }
                    }
                },
                "required": ["title", "specDoc", "specType", "whySeparateNow", "outcome", "problemStatement", "approach", "stackTouchpoints", "scopeBoundaries", "risksAndUnknowns", "incrementalRollout", "successChecks", "proposedTasks"]
            }
        }
    },
    "required": ["specs"],
}


def apply_revision_request_to_spec_proposals(item: dict[str, Any], spec_proposals: list[dict[str, Any]], revision_text: str, existing_spec_docs: list[str], review_doc: str) -> tuple[list[dict[str, Any]], list[str]]:
    if not revision_text:
        return spec_proposals, existing_spec_docs

    current_specs = []
    for idx, proposal in enumerate(spec_proposals):
        spec_doc = existing_spec_docs[idx] if idx < len(existing_spec_docs) else proposal.get("specDoc", "")
        current_specs.append({
            "title": proposal.get("title", ""),
            "specDoc": spec_doc,
            "currentMarkdown": load_text(WORKSPACE / spec_doc) if spec_doc else "",
            "proposedTasks": proposal.get("proposedTasks") or [],
        })

    payload = {
        "bookmark": {
            "title": item.get("title", ""),
            "topic": item.get("topic", "general"),
            "path": item.get("path", ""),
        },
        "workspaceContext": bookmark_workspace_context(item.get("topic", "general")),
        "revisionRequest": revision_text,
        "currentSpecs": current_specs,
    }
    raw = invoke_llm_json(REVISION_PROMPT, payload, REVISION_SCHEMA)
    revised = raw.get("specs")
    if not isinstance(revised, list) or not revised:
        raise LLMOutputValidationError("revision output must include specs")

    normalized_proposals: list[dict[str, Any]] = []
    spec_docs: list[str] = []
    for spec_index, spec in enumerate(revised):
        if not isinstance(spec, dict):
            raise LLMOutputValidationError(f"revision specs[{spec_index}] must be an object")
        tasks = spec.get("proposedTasks")
        if not isinstance(tasks, list) or not tasks:
            raise LLMOutputValidationError(f"revision specs[{spec_index}].proposedTasks must be a non-empty array")
        original_spec_doc = expect_string(spec.get("specDoc"), f"revision specs[{spec_index}].specDoc")
        if original_spec_doc not in existing_spec_docs:
            raise ValueError(f"revision specs[{spec_index}].specDoc must be one of the existing spec docs, got: {original_spec_doc}")
        spec_doc = next_revised_live_spec_doc(original_spec_doc)
        spec_docs.append(spec_doc)
        normalized_tasks = []
        renderable_tasks = []
        for task_index, task in enumerate(tasks):
            if not isinstance(task, dict):
                raise LLMOutputValidationError(f"revision specs[{spec_index}].proposedTasks[{task_index}] must be an object")
            title = expect_string(task.get("title"), f"revision specs[{spec_index}].proposedTasks[{task_index}].title")
            priority = expect_string(task.get("priority"), f"revision specs[{spec_index}].proposedTasks[{task_index}].priority")
            summary = expect_string(task.get("summary"), f"revision specs[{spec_index}].proposedTasks[{task_index}].summary")
            deliverable = expect_string(task.get("deliverable"), f"revision specs[{spec_index}].proposedTasks[{task_index}].deliverable")
            acceptance = expect_string_list(task.get("acceptanceCriteria"), f"revision specs[{spec_index}].proposedTasks[{task_index}].acceptanceCriteria", min_items=1)
            renderable_tasks.append({
                "title": title,
                "priority": priority,
                "summary": summary,
                "deliverable": deliverable,
                "acceptanceCriteria": acceptance,
            })
            normalized_tasks.append({
                "title": title,
                "priority": priority,
                "assignee": None,
                "description": render_task_description({
                    "title": title,
                    "priority": priority,
                    "summary": summary,
                    "deliverable": deliverable,
                    "acceptanceCriteria": acceptance,
                }, spec_doc, review_doc),
            })

        original_spec_path = WORKSPACE / original_spec_doc
        spec_path = WORKSPACE / spec_doc
        previous_spec_rel = None
        if original_spec_path.exists():
            previous_path = revised_spec_doc_path(item.get("topic") or "general", original_spec_doc)
            ensure_parent(previous_path)
            previous_path.write_text(original_spec_path.read_text(encoding="utf-8"), encoding="utf-8")
            original_spec_path.unlink()
            try:
                previous_spec_rel = str(previous_path.relative_to(WORKSPACE))
            except ValueError:
                previous_spec_rel = str(previous_path)
        ensure_parent(spec_path)
        spec_md = build_spec_md(item, {
            "title": expect_string(spec.get("title"), f"revision specs[{spec_index}].title"),
            "specType": expect_string(spec.get("specType"), f"revision specs[{spec_index}].specType"),
            "whySeparateNow": expect_string(spec.get("whySeparateNow"), f"revision specs[{spec_index}].whySeparateNow"),
            "outcome": expect_string(spec.get("outcome"), f"revision specs[{spec_index}].outcome"),
            "problemStatement": expect_string(spec.get("problemStatement"), f"revision specs[{spec_index}].problemStatement"),
            "approach": expect_string(spec.get("approach"), f"revision specs[{spec_index}].approach"),
            "stackTouchpoints": expect_string_list(spec.get("stackTouchpoints"), f"revision specs[{spec_index}].stackTouchpoints", min_items=1),
            "scopeBoundaries": expect_string_list(spec.get("scopeBoundaries"), f"revision specs[{spec_index}].scopeBoundaries", min_items=1),
            "risksAndUnknowns": expect_string_list(spec.get("risksAndUnknowns"), f"revision specs[{spec_index}].risksAndUnknowns", min_items=1),
            "incrementalRollout": expect_string_list(spec.get("incrementalRollout"), f"revision specs[{spec_index}].incrementalRollout", min_items=1),
            "successChecks": expect_string_list(spec.get("successChecks"), f"revision specs[{spec_index}].successChecks", min_items=1),
            "proposedTasks": renderable_tasks,
        }, spec_doc, review_doc, previous_spec=previous_spec_rel)
        spec_path.write_text(spec_md, encoding="utf-8")

        normalized_proposals.append({
            "title": expect_string(spec.get("title"), f"revision specs[{spec_index}].title"),
            "specDoc": spec_doc,
            "proposedTasks": normalized_tasks,
        })
    return normalized_proposals, spec_docs


def extract_tasks_from_spec_md(spec_path: Path, review_doc: str) -> list[dict[str, Any]]:
    """Parse a spec markdown file on disk and extract current proposed tasks.

    Handles the case where Tom manually edited the spec file — the bookmark's
    specProposals are stale but the spec on disk is authoritative.
    """
    import re
    text = load_text(spec_path)
    tasks = []
    match = re.search(r'^## Proposed Tasks\s*\n', text, re.MULTILINE)
    if not match:
        return []
    section = text[match.end():]
    next_heading = re.search(r'^## ', section, re.MULTILINE)
    section_text = section[:next_heading.start()] if next_heading else section
    blocks = re.split(r'^### ', section_text, flags=re.MULTILINE)
    for block in blocks[1:]:
        lines = block.strip().split('\n')
        title = lines[0].strip()
        priority_match = re.search(r'\*\*Priority:\*\*.*?`?(\w+)`?', block)
        priority = (priority_match.group(1) if priority_match else 'medium').lower()
        body = '\n'.join(lines[1:]).strip()
        description = f"**What:** {title}\n\n{body}" if body else f"**What:** {title}"
        tasks.append({
            'title': title,
            'priority': priority,
            'assignee': None,
            'description': description,
        })
    return tasks

def main() -> int:
    p = argparse.ArgumentParser(description="Generate spec docs for implement-worthy bookmarks")
    p.add_argument("--specs-root", default=str(SPECS_ROOT))
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(__import__("sys").stdin)
    implement = data.get("implement", [])
    # Don't resolve - keep the raw path to avoid iCloud symlink issues
    specs_root = Path(args.specs_root).resolve()
    state = load_state(Path(STATE_PATH))
    items = state["items"]

    generated = []
    for item in implement:
        state_item = items.get(item["bookmarkKey"], {})
        analysis = state_item.get("analysis") or item.get("analysis")
        hydrated_item = merge_bookmark_context({**state_item, **item})

        # Reuse existing spec artifacts when they already exist and approval/tasking hasn't happened.
        existing_spec_docs = state_item.get("specDocs") or item.get("specDocs") or []
        existing_spec_proposals = state_item.get("specProposals") or item.get("specProposals") or []
        valid_existing_spec_docs = [doc for doc in existing_spec_docs if (WORKSPACE / doc).exists()]
        has_existing_spec_work = bool(valid_existing_spec_docs)
        pending_or_tasked = bool(state_item.get("reviewStatus") in {"approval_pending", "revision_staged"} or state_item.get("taskIds"))
        if has_existing_spec_work and not pending_or_tasked:
            review_doc = state_item.get("reviewDoc") or item.get("reviewDoc", "")
            revision_text = str(state_item.get("latestRevisionRequest") or "").strip()
            if state_item.get("reviewStatus") == "revision_requested" and revision_text:
                # Route revision to Quinn's heartbeat — same pattern as fresh spec generation.
                # Quinn reads the existing spec, applies the revision request, writes a new version,
                # and calls update_spec_state.py. State stays revision_requested until Quinn acts.
                continue

            # Content-freshness check: compare total task count across ALL spec files
            # on disk vs total in specProposals. A mismatch means a manual spec edit
            # (e.g. task joining, spec deletion) and specProposals are stale.
            disk_total_tasks = 0
            for spec_doc in existing_spec_docs:
                spec_path = WORKSPACE / spec_doc
                if spec_path.exists():
                    disk_total_tasks += len(extract_tasks_from_spec_md(spec_path, review_doc))
            stored_total_tasks = sum(
                len(p.get("proposedTasks", [])) for p in existing_spec_proposals
            )
            # Also force sync when stored tasks are empty but spec file exists —
            # prevents a permanent stall when the LLM produced an empty proposedTasks
            # array and the parser also returns 0 (both sides equal, sync never fires).
            spec_needs_sync = (disk_total_tasks != stored_total_tasks) or (
                stored_total_tasks == 0 and bool(valid_existing_spec_docs)
            )
            if spec_needs_sync:
                previous_status = state_item.get("reviewStatus")
                revised_proposals = []
                revised_spec_docs = []
                for spec_doc in existing_spec_docs:
                    spec_path = WORKSPACE / spec_doc
                    if spec_path.exists():
                        tasks = extract_tasks_from_spec_md(spec_path, review_doc)
                        import re
                        spec_text = load_text(spec_path)
                        title_match = re.search(r'^# Spec - (.+)$', spec_text, re.MULTILINE)
                        spec_title = title_match.group(1).strip() if title_match else spec_path.stem.replace("-", " ").title()
                        revised_proposals.append({
                            "title": spec_title,
                            "specDoc": spec_doc,
                            "proposedTasks": tasks,
                        })
                        revised_spec_docs.append(spec_doc)
                state_item.update({
                    "specDocs": revised_spec_docs,
                    "specProposals": revised_proposals,
                    "lastUpdatedAt": now_iso(),
                })
                items[item["bookmarkKey"]] = state_item
                log_transition(
                    item["bookmarkKey"],
                    previous_status,
                    previous_status,
                    "spec proposals synced from disk",
                    transitions_path=transition_log_path(Path(STATE_PATH)),
                )
                generated.append({
                    **hydrated_item,
                    "specDocs": revised_spec_docs,
                    "specProposals": revised_proposals,
                })
                continue


            previous_status = state_item.get("reviewStatus")
            state_item.update({
                "reviewStatus": "spec_created",
                "specDocs": valid_existing_spec_docs,
                "specProposals": existing_spec_proposals,
                "lastUpdatedAt": now_iso(),
            })
            items[item["bookmarkKey"]] = state_item
            log_transition(
                item["bookmarkKey"],
                previous_status,
                "spec_created",
                "existing spec artifacts reused",
                transitions_path=transition_log_path(Path(STATE_PATH)),
            )
            generated.append({
                **hydrated_item,
                "specDocs": valid_existing_spec_docs,
                "specProposals": existing_spec_proposals,
            })
            continue

        # Queue for Quinn's heartbeat spec dispatch.
        # Quinn picks up spec_requested items, writes specs with full tool access,
        # then calls scripts/bookmarks/update_spec_state.py to record the result.
        # build_task_proposals.approval_recoverable_items re-enters them once spec_created.
        if state_item.get("reviewStatus") != "spec_requested":
            previous_status = state_item.get("reviewStatus")
            state_item.update({
                "reviewStatus": "spec_requested",
                "lastUpdatedAt": now_iso(),
            })
            items[item["bookmarkKey"]] = state_item
            tlog = transition_log_path(Path(STATE_PATH))
            log_transition(
                item["bookmarkKey"],
                previous_status,
                "spec_requested",
                "queued for Quinn heartbeat spec dispatch",
                transitions_path=tlog,
            )
            # Log curation bucket exit so the dashboard chart can show
            # "Curated: High Signal" decreasing as specs are requested.
            # to=None means only the `from` side is adjusted in backward reconstruction.
            log_transition(
                item["bookmarkKey"],
                "Curated: High Signal",
                None,
                "curation bucket exit → spec_requested",
                transitions_path=tlog,
            )

    save_state(state, Path(STATE_PATH))
    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "implement": generated,
        "monitoring": data.get("monitoring", []),
        "reviewed": data.get("reviewed", []),
    }
    if args.json:
        dump_json(payload)
    else:
        print(f"generated {len(generated)} specs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
