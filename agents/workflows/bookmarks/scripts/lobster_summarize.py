#!/usr/bin/env python3
"""
Generates faithful summaries of bookmark candidates.

No classification, no stack judgment, no opinion on what to build.
Just: what does this bookmark actually describe?

Runs as a lobster exec step. Writes summary docs to brain/bookmarks/summaries/
(flat, no topic subfolder) and updates state with reviewStatus=summarized.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from common import (
    LLMOutputValidationError,
    REVIEWS_ROOT,
    STATE_PATH,
    WORKSPACE,
    dump_json,
    ensure_parent,
    expect_string,
    expect_string_list,
    invoke_llm_json,
    llm_provenance,
    load_state,
    log_transition,
    now_iso,
    save_state,
    slugify,
    transition_log_path,
)

WIKI_SCRIPT_ROOT = Path(__file__).resolve().parents[2] / "wiki"
if str(WIKI_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(WIKI_SCRIPT_ROOT))

from wiki_catalog import (
    configure_workspace as configure_wiki_workspace,
    event_key_for_payload,
    upsert_entry as wiki_upsert_entry,
)

SUMMARY_PROMPT = """You are summarising a saved bookmark for a personal research pipeline.

Your job is to extract what this bookmark actually describes in concrete terms.
No opinion on whether to implement it. No stack judgment. No classification.
Just: what is this, and why might it be interesting to revisit?

Extract:
- The core problem or need it addresses
- The technical approach, architecture, or workflow described
- The value proposition — what does it do well or differently?
- Key implementation details or requirements
- Who this is most relevant to (solo builders, large teams, specific domain)
- Any notable constraints or trade-offs

Write like a concise technical note for future reference. Dense and specific beats vague and general.
Do not judge signal quality or relevance. That judgment happens in curation, separately."""

_SUMMARIZED_OR_LATER = {
    "summarized", "spec_requested", "spec_created", "approval_pending",
    "revision_requested", "revision_staged", "reviewed", "declined",
    "monitoring", "tasked",
}

SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "problem": {"type": "string"},
        "approach": {"type": "string"},
        "valueProposition": {"type": "string"},
        "keyDetails": {"type": "array", "items": {"type": "string"}},
        "relevantTo": {"type": "string"},
        "constraints": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "problem", "approach", "valueProposition", "keyDetails", "relevantTo"],
}


def summary_doc_path(reviews_root: Path, topic: str, title: str, bookmark_key: str) -> Path:
    # flat — topic no longer appears in the file path
    return reviews_root / f"{slugify(title)}-{bookmark_key}.md"


def build_summary_md(record: dict[str, Any], summary: dict[str, Any], provenance: dict[str, Any]) -> str:
    tags = record.get("tags") or []
    tags_md = ", ".join(f"`{t}`" for t in tags) if tags else "_none_"
    details_md = "\n".join(f"- {d}" for d in summary.get("keyDetails") or [])
    constraints = summary.get("constraints") or []
    constraints_md = "\n".join(f"- {c}" for c in constraints) if constraints else "- None noted"
    provenance_path = provenance.get("path") or "unknown"
    provenance_model = provenance.get("model") or provenance.get("agentId") or "default"
    summarised_at = record.get("reviewedAt") or ""

    return f'''# Summary — {record["title"]}

- **Bookmark:** {record.get("path", "")}
- **Source:** `{record.get("source", "")}`
- **Link:** {record.get("link") or "_none_"}
- **Summary Engine:** `{provenance_path}`
- **Summary Model:** `{provenance_model}`
- **Summarised At:** `{summarised_at}`
- **Tags:** {tags_md}

## What Is This

{summary["headline"]}

## Problem / Need

{summary["problem"]}

## Approach

{summary["approach"]}

## Value Proposition

{summary["valueProposition"]}

## Key Details

{details_md}

## Relevant To

{summary["relevantTo"]}

## Constraints / Trade-offs

{constraints_md}
'''


def summarise_record(record: dict[str, Any]) -> dict[str, Any]:
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
    }
    raw = invoke_llm_json(SUMMARY_PROMPT, payload, SUMMARY_SCHEMA)

    return {
        "headline": expect_string(raw.get("headline"), "headline"),
        "problem": expect_string(raw.get("problem"), "problem"),
        "approach": expect_string(raw.get("approach"), "approach"),
        "valueProposition": expect_string(raw.get("valueProposition"), "valueProposition"),
        "keyDetails": expect_string_list(raw.get("keyDetails"), "keyDetails"),
        "relevantTo": expect_string(raw.get("relevantTo"), "relevantTo"),
        "constraints": expect_string_list(raw.get("constraints"), "constraints"),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Summarise bookmark candidates faithfully")
    p.add_argument("--reviews-root", default=str(REVIEWS_ROOT))
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(__import__("sys").stdin)
    candidates = data.get("candidates", [])
    reviews_root = (WORKSPACE / args.reviews_root).resolve()
    configure_wiki_workspace(WORKSPACE)
    state = load_state(Path(STATE_PATH))
    items = state["items"]

    generated = []
    for record in candidates:
        bookmark_key = record["bookmarkKey"]
        topic = record.get("topic") or "general"

        existing = items.get(bookmark_key, {})
        if record.get("skipReview") is True:
            generated.append({
                "bookmarkKey": bookmark_key,
                "path": record["path"],
                "topic": topic,
                "reviewStatus": existing.get("reviewStatus") or "summarized",
                "summaryDoc": existing.get("summaryDoc"),
                "title": record["title"],
                "summary": existing.get("summary"),
                "skipped": True,
            })
            continue

        # Skip if already summarised (or further along) and summary doc exists on disk
        if existing.get("reviewStatus") in _SUMMARIZED_OR_LATER and existing.get("summaryDoc"):
            summary_path = WORKSPACE / existing["summaryDoc"]
            if summary_path.exists():
                generated.append({
                    "bookmarkKey": bookmark_key,
                    "path": record["path"],
                    "topic": topic,
                    "reviewStatus": existing["reviewStatus"],
                    "summaryDoc": existing["summaryDoc"],
                    "title": record["title"],
                })
                continue

        summary = summarise_record(record)
        provenance = llm_provenance()
        summarised_at = now_iso()

        record_with_provenance = dict(record)
        record_with_provenance["reviewedAt"] = summarised_at
        record_with_provenance["reviewProvenance"] = provenance

        doc_path = summary_doc_path(reviews_root, topic, record["title"], bookmark_key)
        ensure_parent(doc_path)
        doc_path.write_text(build_summary_md(record_with_provenance, summary, provenance), encoding="utf-8")

        summary_doc_rel = f"brain/bookmarks/summaries/{doc_path.name}"
        wiki_upsert_entry(
            "summary",
            summary_doc_rel,
            record["title"],
            summary["headline"],
            event_key=event_key_for_payload(
                "summary-ingest",
                {
                    "source": summary_doc_rel,
                    "title": record["title"],
                    "summary": summary["headline"],
                },
            ),
        )

        previous_status = existing.get("reviewStatus")
        existing.update({
            "bookmarkKey": bookmark_key,
            "path": record["path"],
            "topic": topic,
            "source": record.get("source", ""),
            "title": record["title"],
            "link": record.get("link", ""),
            "tags": record.get("tags", []),
            "type": record.get("type", ""),
            "dateArchived": record.get("dateArchived", ""),
            "bodyExcerpt": record.get("bodyExcerpt", ""),
            "reviewStatus": "summarized",
            "summaryDoc": summary_doc_rel,
            "summary": summary,
            "reviewProvenance": provenance,
            "specDocs": existing.get("specDocs", []),
            "specProposals": existing.get("specProposals", []),
            "taskIds": existing.get("taskIds", []),
            "firstSeenAt": existing.get("firstSeenAt") or now_iso(),
            "reviewedAt": summarised_at,
            "lastUpdatedAt": summarised_at,
        })
        items[bookmark_key] = existing
        log_transition(
            bookmark_key,
            previous_status,
            "summarized",
            "summarized",
            transitions_path=transition_log_path(Path(STATE_PATH)),
        )
        generated.append({
            "bookmarkKey": bookmark_key,
            "path": record["path"],
            "topic": topic,
            "reviewStatus": "summarized",
            "summaryDoc": existing["summaryDoc"],
            "title": record["title"],
            "summary": summary,
        })

    save_state(state, Path(STATE_PATH))
    payload = {"ok": True, "summarisedAt": now_iso(), "count": len(generated), "summaries": generated}
    if args.json:
        dump_json(payload)
    else:
        print(f"summarised {len(generated)} bookmarks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
