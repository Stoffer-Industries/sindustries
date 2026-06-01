#!/usr/bin/env python3
"""
Step 2 of sindustries-weekly-content lobster.

Reads weekly notes JSON from stdin, calls OpenClaw Gateway /tools/invoke with
llm-task, and prints only the classified review JSON for create_review_file.py.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

WORKSPACE = Path(__file__).resolve().parents[5]
OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"

PROMPT = (
    "Classify these SIndustries weekly ops notes into a structured content review. "
    "Input is JSON with a daily_notes array. Each note has format: "
    "- [date] **slug** - description | why: reason | ref: path. "
    "Classify each into tom_approval (first-person voice, strategic claims, "
    "revenue/customer references, public commitments) or quinn_approval "
    "(factual updates, stack changes, technical milestones, experiment status "
    "with evidence). Preserve the slug and key context in each bullet. "
    "Output ONLY valid JSON with no markdown fences. review_date must come from "
    "the input JSON."
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "tom_approval": {
            "type": "array",
            "items": {"type": "string"},
        },
        "quinn_approval": {
            "type": "array",
            "items": {"type": "string"},
        },
        "review_date": {"type": "string"},
    },
    "additionalProperties": True,
}


def openclaw_config() -> dict[str, Any]:
    if not OPENCLAW_CONFIG.exists():
        return {}
    try:
        return json.loads(OPENCLAW_CONFIG.read_text())
    except json.JSONDecodeError:
        return {}


def gateway_url(config: dict[str, Any]) -> str:
    if os.environ.get("OPENCLAW_URL"):
        return os.environ["OPENCLAW_URL"].rstrip("/")
    port = (
        os.environ.get("OPENCLAW_GATEWAY_PORT")
        or str(config.get("gateway", {}).get("port") or "18789")
    )
    return f"http://127.0.0.1:{port}"


def gateway_token(config: dict[str, Any]) -> str | None:
    return os.environ.get("OPENCLAW_TOKEN") or config.get("gateway", {}).get("auth", {}).get("token")


def invoke_llm_task(notes_payload: dict[str, Any]) -> dict[str, Any]:
    config = openclaw_config()
    url = f"{gateway_url(config)}/tools/invoke"
    body = {
        "tool": "llm-task",
        "action": "json",
        "args": {
            "prompt": PROMPT,
            "input": notes_payload,
            "schema": SCHEMA,
            "timeoutMs": 60000,
        },
        "sessionKey": "main",
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {gateway_token(config)}"} if gateway_token(config) else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=75) as response:
            wrapper = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"llm-task HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"could not reach OpenClaw Gateway for llm-task: {exc}") from exc

    return extract_llm_json(wrapper)


def extract_llm_json(wrapper: dict[str, Any]) -> dict[str, Any]:
    result = wrapper.get("result") if isinstance(wrapper.get("result"), dict) else wrapper
    details = result.get("details") if isinstance(result, dict) else None
    if isinstance(details, dict) and isinstance(details.get("json"), dict):
        return normalize_llm_json(details["json"])

    content = result.get("content") if isinstance(result, dict) else None
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    return normalize_llm_json(parsed)

    raise RuntimeError(f"llm-task response did not contain JSON output: {json.dumps(wrapper)[:500]}")


def normalize_llm_json(data: dict[str, Any]) -> dict[str, Any]:
    tom_items = list_items(data.get("tom_approval"))
    quinn_items = list_items(data.get("quinn_approval"))

    classifications = data.get("classifications")
    if isinstance(classifications, list):
        for item in classifications:
            if not isinstance(item, dict):
                continue
            bullet = classification_bullet(item)
            if not bullet:
                continue
            bucket = str(
                item.get("approval")
                or item.get("approval_type")
                or item.get("section")
                or item.get("bucket")
                or item.get("classification")
                or ""
            ).lower()
            if "tom" in bucket:
                tom_items.append(bullet)
            else:
                quinn_items.append(bullet)

    review_date = data.get("review_date")
    if not isinstance(review_date, str):
        review_date = ""

    return {
        "tom_approval": tom_items,
        "quinn_approval": quinn_items,
        "review_date": review_date,
    }


def list_items(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def classification_bullet(item: dict[str, Any]) -> str:
    for key in ("bullet", "summary", "text", "note"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value if value.lstrip().startswith("-") else f"- {value}"

    slug = item.get("slug") or item.get("title") or item.get("name")
    description = item.get("description") or item.get("context") or item.get("reason")
    ref = item.get("ref") or item.get("reference")
    parts = []
    if slug:
        parts.append(f"**{slug}**")
    if description:
        parts.append(str(description))
    if ref:
        parts.append(f"ref: {ref}")
    return f"- {' - '.join(parts)}" if parts else ""


def main() -> None:
    notes_payload = json.load(sys.stdin)
    if not notes_payload.get("daily_notes"):
        print(json.dumps({
            "tom_approval": [],
            "quinn_approval": [],
            "review_date": notes_payload.get("review_date", ""),
        }))
        return

    result = invoke_llm_task(notes_payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
