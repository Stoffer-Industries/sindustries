#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from common import (
    LLMOutputValidationError,
    REVIEWS_ROOT,
    STATE_PATH,
    WORKSPACE,
    bookmark_workspace_context,
    dump_json,
    ensure_parent,
    expect_string,
    expect_string_list,
    invoke_llm_json,
    llm_provenance,
    load_state,
    log_transition,
    now_iso,
    review_status_from_classification,
    save_state,
    slugify,
    transition_log_path,
)

REVIEW_PROMPT = """You are reviewing a saved bookmark for Tom Stoffer's OpenClaw workspace.
Your job is to decide whether the bookmark deserves implementation work in the current stack, should be monitored as context only, or should be ignored for now.

This is not generic bookmarking advice. Judge the item against:
- the current bookmark-review pipeline and topic-specific stack context
- Tom's leverage-first priorities
- the cost of adding another half-baked idea to the queue

IMPORTANT: Treat this bookmark as a fresh review. Never mark as "duplicate" or reference prior reviews - judge this item on its own merits based solely on the bookmark content provided. If you've seen similar content before, ignore that and evaluate this bookmark independently.

Faithfulness rule (read carefully): the bookmark's own framing is the spec's center of gravity. The state-of-the-nation document and topic profile are relevance signals, not a target list to map the bookmark onto. If the bookmark describes a multi-part idea (e.g. a modular memory kit with N memory types), your review must reflect those parts — even if our current frictions only mention one of them. A review that drops most of the bookmark to fit our problem list is a quality failure. Cite our frictions only as supporting context when they actually apply.

Decision bar:
- `ignore`: clearly not useful, too far from the stack, or already well-covered
- `monitor`: useful context or pattern to remember, could become relevant later but not now
- `implement`: worth drafting implementation specs for, even if they're rough or exploratory

Rules:
- Be curious, not skeptical; you're looking for seeds worth planting
- Distinguish between "interesting" and "worth exploring" - a loose "try this" is still valuable
- Explain why monitor vs implement in concrete stack terms, not abstract product language
- Cite specific evidence from the bookmark plus the provided OpenClaw context
- If classification is `implement`, point toward what kind of implementation shape makes sense
- If classification is `monitor`, explain what future trigger would make it worth revisiting
- Write like a sharp internal review note, not a generic product-analysis template
- Use direct language and concrete nouns from the bookmark when possible
- Avoid filler like "this could be useful" unless you immediately explain useful for what
- It's okay to propose exploratory specs - thin slices that test an idea rather than full solutions
- Do not propose a thin slice that ignores most of the bookmark's framing just because a friction we have names one part of it. If only a small part of the bookmark is relevant, classify as `monitor` and say which part. Do not stretch an `implement` into a partial fit."""

REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "classification": {"type": "string", "enum": ["ignore", "monitor", "implement"]},
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "decisionRationale": {"type": "string"},
        "stackJudgment": {"type": "string"},
        "recommendation": {"type": "string"},
        "signals": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 2,
        },
        "risks": {
            "type": "array",
            "items": {"type": "string"},
        },
        "monitorTriggers": {
            "type": "array",
            "items": {"type": "string"},
        },
        "implementationPaths": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "classification",
        "headline",
        "summary",
        "decisionRationale",
        "stackJudgment",
        "recommendation",
        "signals",
        "risks",
        "monitorTriggers",
        "implementationPaths",
    ],
}


def to_wiki_link(path: str) -> str:
    """Convert file path to Obsidian-style wiki link [[filename]].
    
    Examples:
        brain/reviews/infra/foo.md -> [[foo.md]]
        brain/specs/infra/bar.md -> [[bar.md]]
    """
    if not path:
        return path
    return f"[[{Path(path).name}]]"


def review_doc_path(reviews_root: Path, topic: str, title: str, bookmark_key: str) -> Path:
    return reviews_root / topic / f"{slugify(title)}-{bookmark_key}.md"


def build_review_md(record: dict[str, Any], analysis: dict[str, Any], review_status: str) -> str:
    tags = record.get("tags") or []
    tags_md = ", ".join(f"`{t}`" for t in tags) if tags else "_none_"
    signals_md = "\n".join(f"- {signal}" for signal in analysis.get("signals") or [])
    risks = analysis.get("risks") or []
    risks_md = "\n".join(f"- {risk}" for risk in risks) if risks else "- None called out"
    monitor_triggers = analysis.get("monitorTriggers") or []
    monitor_md = "\n".join(f"- {trigger}" for trigger in monitor_triggers) if monitor_triggers else "- None"
    impl_paths = analysis.get("implementationPaths") or []
    impl_md = "\n".join(f"- {path}" for path in impl_paths) if impl_paths else "- None proposed"
    provenance = record.get("reviewProvenance") or {}
    provenance_path = provenance.get("path") or "unknown"
    provenance_model = provenance.get("model") or provenance.get("agentId") or "default"
    reviewed_at = record.get("reviewedAt") or ""

    classification = str(analysis.get("classification") or "").strip().lower()
    decision_heading = {
        "implement": "Why This Warrants Implementation",
        "monitor": "Why This Stays On Monitor",
        "ignore": "Why This Is Parked",
    }.get(classification, {
        "monitoring": "Why This Stays On Monitor",
        "reviewed": "Why This Is Parked",
    }.get(review_status, "Decision"))

    return f'''# Review - {record["title"]}

- **Bookmark:** {to_wiki_link(record['path'])}
- **Topic:** `{record["topic"]}`
- **Source:** `{record["source"]}`
- **Link:** {record.get("link") or '_none_'}
- **Review Status:** `{review_status}`
- **Classification:** `{analysis["classification"]}`
- **Headline:** {analysis["headline"]}
- **Review Engine:** `{provenance_path}`
- **Review Model:** `{provenance_model}`
- **Reviewed At:** `{reviewed_at}`
- **Tags:** {tags_md}

## Summary

{analysis["summary"]}

## Bottom Line

{analysis["headline"]}

## {decision_heading}

{analysis["decisionRationale"]}

## Stack Judgment

{analysis["stackJudgment"]}

## Recommendation

{analysis["recommendation"]}

## Evidence And Signals

{signals_md}

## Risks / Unknowns

{risks_md}

## Monitor Triggers

{monitor_md}

## Possible Implementation Paths

{impl_md}
'''


def analyze_record(record: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "bookmark": {
            "title": record.get("title", ""),
            "topic": record.get("topic", "general"),
            "source": record.get("source", "unknown"),
            "link": record.get("link", ""),
            "tags": record.get("tags", []),
            "type": record.get("type", ""),
            "dateArchived": record.get("dateArchived", ""),
            "bodyExcerpt": record.get("bodyExcerpt", ""),
            "body": record.get("body", ""),
        },
        "workspaceContext": {
            **bookmark_workspace_context(record.get("topic", "general")),
            "ownerProfile": {
                "role": "chief-of-staff builder for Tom Stoffer",
                "currentBias": "useful workflow leverage over novelty",
                "antiGoals": [
                    "generic product ideation with no path into the existing workspace",
                    "implementation plans that are really placeholders",
                    "queueing work that does not beat the cost of attention",
                ],
            },
        },
    }
    raw = invoke_llm_json(REVIEW_PROMPT, payload, REVIEW_SCHEMA)
    classification = raw.get("classification")
    if classification is None:
        # Try alternate keys that some LLM backends return
        for alt_key in ("class", "category", "result", "judgment", "type", "label"):
            if alt_key in raw and raw[alt_key]:
                classification = raw[alt_key]
                break
    # If still None or dict, try to find classification nested deeper
    if classification is None or isinstance(classification, dict):
        if isinstance(classification, dict):
            classification = classification.get("value") or classification.get("classification") or classification.get("result")
        # Check if raw itself is the classification nested
        if classification is None or isinstance(classification, dict):
            for v in raw.values():
                if isinstance(v, str) and v.lower() in {"ignore", "monitor", "implement"}:
                    classification = v
                    break
                if isinstance(v, dict):
                    for vk in ("classification", "class", "result", "value"):
                        if vk in v and isinstance(v[vk], str) and v[vk].lower() in {"ignore", "monitor", "implement"}:
                            classification = v[vk]
                            break
    if classification is None:
        raise LLMOutputValidationError(f"LLM response missing classification field. Response: {str(raw)[:500]}")
    if isinstance(classification, dict):
        classification = classification.get("value") or classification.get("classification") or str(classification)
    classification = str(classification).strip().lower()
    if classification not in {"ignore", "monitor", "implement"}:
        # Try to normalize common variations
        if classification in {"implementation", "impl", "do", "yes", "implementable"}:
            classification = "implement"
        elif classification in {"watch", "monitoring", "track", "observe", "monitorable"}:
            classification = "monitor"
        elif classification in {"skip", "no", "not relevant", "irrelevant", "discard", "ignoreable"}:
            classification = "ignore"
        else:
            raise LLMOutputValidationError(f"classification must be one of ignore, monitor, implement, got: {classification}")
    return {
        "classification": classification,
        "headline": expect_string(raw.get("headline"), "headline"),
        "summary": expect_string(raw.get("summary"), "summary"),
        "decisionRationale": expect_string(raw.get("decisionRationale"), "decisionRationale"),
        "stackJudgment": expect_string(raw.get("stackJudgment"), "stackJudgment"),
        "recommendation": expect_string(raw.get("recommendation"), "recommendation"),
        "signals": expect_string_list(raw.get("signals"), "signals", min_items=1),
        "risks": expect_string_list(raw.get("risks"), "risks"),
        "monitorTriggers": expect_string_list(raw.get("monitorTriggers"), "monitorTriggers"),
        "implementationPaths": expect_string_list(raw.get("implementationPaths"), "implementationPaths"),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Generate review docs for bookmark candidates")
    p.add_argument("--reviews-root", default=str(REVIEWS_ROOT))
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(__import__("sys").stdin)
    candidates = data.get("candidates", [])
    reviews_root = (WORKSPACE / args.reviews_root).resolve()
    state = load_state(Path(STATE_PATH))
    items = state["items"]

    generated = []
    for record in candidates:
        # If skipReview is set, use existing analysis from state instead of re-reviewing
        if record.get("skipReview"):
            bookmark_key = record["bookmarkKey"]
            state_item = items.get(bookmark_key, {})
            existing_analysis = state_item.get("analysis", {})
            
            # Check if review file already exists on disk - if so, DON'T regenerate
            review_path = None
            if state_item.get("reviewDoc"):
                review_path = WORKSPACE / state_item["reviewDoc"]
            
            if review_path and review_path.exists():
                # Review file exists - use existing analysis, don't regenerate
                if existing_analysis:
                    analysis = existing_analysis
                    provenance = state_item.get("reviewProvenance", {"path": "existing", "model": "none"})
                    classification = str(existing_analysis.get("classification") or "").strip().lower()
                    if classification in {"ignore", "monitor", "implement"}:
                        review_status = review_status_from_classification(classification)
                    else:
                        review_status = state_item.get("reviewStatus", "reviewed")
                    print(f"  [SKIP REVIEW] Using existing review for {record.get('title', '')[:30]}", file=__import__("sys").stderr)
                    item = items.get(bookmark_key, {})
                    previous_status = item.get("reviewStatus")
                    item.update({
                        "analysis": analysis,
                        "reviewProvenance": provenance,
                        "reviewStatus": review_status,
                        "lastUpdatedAt": now_iso(),
                    })
                    items[bookmark_key] = item
                    log_transition(
                        bookmark_key,
                        previous_status,
                        review_status,
                        "existing review reused",
                        transitions_path=transition_log_path(Path(STATE_PATH)),
                    )
                    # Add to generated so it flows to generate_specs / approval prep again.
                    generated.append({
                        "bookmarkKey": bookmark_key,
                        "path": record["path"],
                        "topic": record.get("topic", "general"),
                        "reviewStatus": review_status,
                        "reviewDoc": state_item.get("reviewDoc", ""),
                        "title": record["title"],
                        "analysis": analysis,
                        "reviewProvenance": provenance,
                    })
                    continue
                else:
                    # No existing analysis - still skip but generate basic review
                    review_status = state_item.get("reviewStatus", "reviewed")
            else:
                # No review file on disk - fall through to LLM generation
                # (prompt will now handle duplicate detection properly)
                pass
        # Normal path - generate new review
        analysis = analyze_record(record)
        provenance = llm_provenance()
        review_status = review_status_from_classification(analysis["classification"])
        topic = record.get("topic") or "general"
        bookmark_key = record["bookmarkKey"]
        reviewed_at = now_iso()
        review_record = dict(record)
        review_record["reviewProvenance"] = provenance
        review_record["reviewedAt"] = reviewed_at
        review_path = review_doc_path(reviews_root, topic, record["title"], bookmark_key)
        ensure_parent(review_path)
        review_path.write_text(build_review_md(review_record, analysis, review_status), encoding="utf-8")

        item = items.get(bookmark_key, {})
        previous_status = item.get("reviewStatus")
        item.update({
            "bookmarkKey": bookmark_key,
            "path": record["path"],
            "topic": topic,
            "source": record["source"],
            "title": record["title"],
            "link": record.get("link", ""),
            "tags": record.get("tags", []),
            "type": record.get("type", ""),
            "dateArchived": record.get("dateArchived", ""),
            "bodyExcerpt": record.get("bodyExcerpt", ""),
            "reviewStatus": review_status,
            "reviewDoc": f"brain/reviews/{topic}/{review_path.name}",
            "analysis": analysis,
            "reviewProvenance": provenance,
            "specDocs": item.get("specDocs", []),
            "specProposals": item.get("specProposals", []),
            "approvalTopic": topic or "general",
            "taskIds": item.get("taskIds", []),
            "firstSeenAt": item.get("firstSeenAt") or now_iso(),
            "reviewedAt": reviewed_at,
            "lastUpdatedAt": reviewed_at,
        })
        items[bookmark_key] = item
        log_transition(
            bookmark_key,
            previous_status,
            review_status,
            f"classification={analysis['classification']}",
            transitions_path=transition_log_path(Path(STATE_PATH)),
        )
        generated.append({
            "bookmarkKey": bookmark_key,
            "path": record["path"],
            "topic": topic,
            "reviewStatus": review_status,
            "reviewDoc": item["reviewDoc"],
            "title": record["title"],
            "analysis": analysis,
            "reviewProvenance": provenance,
        })

    save_state(state, Path(STATE_PATH))
    payload = {"ok": True, "generatedAt": now_iso(), "count": len(generated), "reviews": generated}
    if args.json:
        dump_json(payload)
    else:
        print(f"generated {len(generated)} reviews")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
