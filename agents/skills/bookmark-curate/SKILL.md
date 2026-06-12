---
name: bookmark-curate
description: Run the bookmark curation pass — Quinn scores summarized bookmarks for relevance against active focus topics and queues qualifying ones for spec generation. Use during heartbeat BOOKMARK CURATION step, or when asked to curate bookmarks, check what's queued for spec, or shift focus areas.
---

# Bookmark Curation

Quinn (heartbeat) scores `summarized` bookmarks (and stale `monitoring` items due for re-curation) against active focus topics. Items scoring at or above the relevance threshold for an active topic are promoted to `queued_for_spec`. Others remain `monitoring` with an updated `lastCuratedAt` timestamp.

The work is split into three discrete steps. Heartbeat orchestrates; nothing here writes state directly.

## Step 1 — List candidates (filter only, no LLM)

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/list_curate_candidates.py --json
```

Output includes:
- `count`: how many items are in this batch
- `remaining`: how many still need curation (picked up next heartbeat)
- `batch`: array of candidate objects with `bookmarkKey`, `title`, `topic`, `reviewStatus`, `lastCuratedAt`, `reviewDoc`, and `summary`

If `count == 0`, skip the scoring step and run step 3 (validate is a no-op when the artifact is absent).

## Step 2 — Score the batch (Quinn's job)

For each candidate in `batch`, Quinn reads the `summary` (and the `reviewDoc` if the summary is thin) and reasons about relevance to each active topic in the focus config. Scoring rubric:

- 0: completely unrelated
- 3: loosely adjacent, tangential connection
- 5: relevant but not directly actionable now
- 7: clearly relevant — meaningfully touches this area
- 9–10: directly actionable right now

Don't inflate vague connections. The previous LLM call was a thin wrapper — Quinn has the full bookmark context and can reason more accurately.

Pick the highest-scoring topic as `primaryTopic`. If `primaryScore >= relevanceThreshold` and the topic is in `activeTopics`, decide `queued_for_spec`; else `monitoring`. For `queued_for_spec` items, set `approvalTopic` to the primary topic (the approval gate bucket).

Write the decisions to `brain/state/curate-output.json` (overwrite — curate is single-batch).

## Step 3 — Apply state (lobster-side state machine)

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/validate_curate_output.py --json
```

This reads the artifact, validates format, applies `queued_for_spec` / `monitoring` transitions, logs them to `bookmark-transitions.jsonl`, and renames the artifact to `.processed`. Idempotent — safe to re-run.

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

Edit `activeTopics` to shift which areas get prioritised. Change `relevanceThreshold` to tighten or loosen the bar for spec promotion. `recurationDays` controls when `monitoring` items re-qualify for curation. `batchSize` caps how many items per heartbeat cycle.

## Guidance

- Run up to one batch (batchSize items) per heartbeat. If `remaining > 0`, more items will be picked up next cycle.
- Items in `monitoring` with no `lastCuratedAt` are treated as needing curation (old items before this pipeline).
- A `monitoring` item re-qualifies for curation after `recurationDays` days — relevance naturally changes as focus areas shift.
- After curation, `queued_for_spec` items are picked up by the SPEC DISPATCH heartbeat step.
- To manually inspect what needs curation, use the bookmark-state-analyzer skill filtered by status: `--status summarized` or `--status monitoring`.
