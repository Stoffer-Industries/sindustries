---
name: bookmark-curate
description: Run the bookmark curation pass — Quinn scores summarized bookmarks for relevance against all focus topics and routes qualifying ones toward spec generation. Use during heartbeat BOOKMARK CURATION step, or when asked to curate bookmarks, check what's queued for spec, or adjust the scoring config.
---

# Bookmark Curation

Quinn (heartbeat) scores `summarized` bookmarks (and stale curations due for refresh) against all known topics. The highest-scoring topic becomes the item's primary topic. If the score meets the relevance threshold, the item moves toward spec generation. This is the only step that makes judgment calls — ingest and summarize are judgment-free.

The work is split into three discrete steps. Heartbeat orchestrates; nothing here writes state directly.

## Step 1 — List candidates (filter only, no LLM)

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/list_curate_candidates.py --json
```

Output includes:
- `count`: how many items are in this batch
- `remaining`: how many still need curation (picked up next heartbeat)
- `batch`: array of candidate objects with `bookmarkKey`, `title`, `topic`, `reviewStatus`, `curationAgeDays`, `reviewDoc`, and `summary`
- `config.topics`: all scoreable topics
- `config.relevanceThreshold`: the score cutoff

If `count == 0`, skip the scoring step and run step 3 (validate is a no-op when the artifact is absent).

## Step 2 — Score the batch (Quinn's job)

For each candidate, Quinn reads the `summary` (and the `reviewDoc` file if the summary is thin) and scores relevance 0–10 against **every topic** in `config.topics`. Scoring rubric:

- 0: completely unrelated
- 3: loosely adjacent, tangential connection
- 5: relevant but not directly actionable now
- 7: clearly relevant — meaningfully touches this area
- 9–10: directly actionable right now

Pick the highest-scoring topic as `topic` and its score as `score`. Capture all per-topic scores in `relevanceScores`. A bookmark moves forward if `score >= relevanceThreshold`, regardless of which topic won.

Write the decisions to `brain/state/curate-output.json` (overwrite — curate is single-batch):

```json
{
  "producedAt": "<ISO timestamp>",
  "config": { "topics": [...], "relevanceThreshold": 7, "recurationDays": 14, "batchSize": 5 },
  "processed": <count>,
  "remaining": <from list step>,
  "decisions": [
    {
      "bookmarkKey": "<key>",
      "topic": "<highest-scoring topic>",
      "score": <float>,
      "reasoning": "<one or two sentences>",
      "relevanceScores": [{ "topic": "...", "score": N, "reasoning": "..." }],
      "threshold": 7,
      "createdAt": "<ISO timestamp>"
    }
  ],
  "errors": []
}
```

## Step 3 — Apply state (lobster-side state machine)

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/validate_curate_output.py --json
```

Reads the artifact, validates format, writes `item.curation` for each decision, logs a `curation refreshed` transition, and renames the artifact to `.processed`. Idempotent — safe to re-run.

## Focus config

Topic list, relevance threshold, re-curation window, and batch size live in:

```
brain/state/focus-config.json
```

```json
{
  "topics": ["brain", "infra", "crypto", "app-tasks", "app-assistant", "outreach", "design", "personal", "general"],
  "relevanceThreshold": 7,
  "recurationDays": 14,
  "batchSize": 5
}
```

Edit `topics` to add or remove scoreable buckets. Change `relevanceThreshold` to tighten or loosen the bar for spec promotion. `recurationDays` controls when stale curations re-qualify for a refresh.

## Guidance

- Run up to one batch per heartbeat. If `remaining > 0`, more items will be picked up next cycle.
- Items with no curation at all are treated as needing curation regardless of age.
- After curation, items scoring at or above threshold are picked up by the SPEC DISPATCH heartbeat step.
- To inspect what needs curation: `analyze_state.py --status summarized` or `--status monitoring`.
