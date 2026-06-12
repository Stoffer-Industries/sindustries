---
name: bookmark-curate
description: Run the bookmark curation pass — scores summarized bookmarks for relevance against active focus topics and queues qualifying ones for spec generation. Use during heartbeat BOOKMARK CURATION step, or when asked to curate bookmarks, check what's queued for spec, or shift focus areas.
---

# Bookmark Curation

Scores `summarized` bookmarks (and stale `monitoring` items due for re-curation) against active focus topics. Items scoring at or above the relevance threshold for an active topic are promoted to `queued_for_spec`. Others remain `monitoring` with an updated `lastCuratedAt` timestamp.

## Primary command

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/curate.py --json
```

Output includes:
- `processed`: how many items were scored this run
- `remaining`: how many still need curation (picked up next heartbeat)
- `queued_for_spec`: bookmark keys promoted for spec generation
- `monitoring`: bookmark keys that scored below threshold

## Dry run (no state changes)

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/curate.py --json --dry-run
```

Use dry run to preview what would be queued without committing changes.

## Focus config

Active topics, relevance threshold, re-curation window, and batch size live in:

```
brain/state/focus-config.json
```

Default values:
```json
{
  "activeTopics": ["brain", "infra"],
  "relevanceThreshold": 7,
  "recurationDays": 14,
  "batchSize": 5
}
```

Edit `activeTopics` to shift which areas get prioritised. Change `relevanceThreshold` to tighten or loosen the bar for spec promotion.

## Guidance

- Run up to one batch (batchSize items) per heartbeat. If `remaining > 0`, more items will be picked up next cycle.
- Items in `monitoring` with no `lastCuratedAt` are treated as needing curation (old items before this pipeline).
- A `monitoring` item re-qualifies for curation after `recurationDays` days — relevance naturally changes as focus areas shift.
- After curation, `queued_for_spec` items are picked up by the SPEC DISPATCH heartbeat step.
- To manually inspect what needs curation, use the bookmark-state-analyzer skill filtered by status: `--status summarized` or `--status monitoring`.
