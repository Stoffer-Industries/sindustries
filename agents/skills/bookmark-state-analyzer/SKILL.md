---
name: bookmark-state-analyzer
description: Analyze bookmark workflow state from brain/state/bookmark-review-state.json using a compact local script instead of rereading the full JSON. Use when asked what bookmark states exist, how many items are in each review status/topic, what needs follow-up, whether approvals/specs/tasks are pending, or when you want a token-cheap summary of bookmark pipeline state.
---

# Bookmark State Analyzer

Use the bundled analyzer script to summarize bookmark workflow state without loading the full `brain/state/bookmark-review-state.json` into model context.

## Primary command

Run:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/analyze_state.py
```

This prints a compact human-readable summary with:
- total bookmark count
- counts by `reviewStatus`
- counts by topic
- counts by approval status
- attention buckets (`specs`, `tasks`, `approval pending`, likely follow-up)
- recent updates

## Machine-readable mode

When you need structured output, run:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/analyze_state.py --json
```

Use this instead of reading the large JSON file directly when the user asks for status, counts, pending work, or a quick health check.

## Filters

Filter by topic:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/analyze_state.py --topic brain
```

Filter by review status:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/analyze_state.py --status spec_created
```

Combine filters when narrowing the report.

## Guidance

- Prefer the analyzer for summaries, counts, and triage.
- Read the raw JSON only when you need fields the analyzer does not expose.
- If the user asks for a new bucket or metric repeatedly, extend `codebases/sindustries/agents/workflows/bookmark/analyze_state.py` rather than repeatedly loading the full state file.
- Treat `queued_for_spec`, `spec_created`, and `approval_pending` as likely follow-up states unless the workflow semantics change.
