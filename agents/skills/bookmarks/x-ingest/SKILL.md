---
name: x-bookmark-ingest
description: "Ingest X bookmarks into the workspace bookmark pipeline."
---

# X Bookmark Ingest

Run from this skill directory:

```bash
python3 scripts/run_x_ingest.py
```

Use `--force` to process pending bookmarks without fetching, and `--max-items N`
to limit the X fetch.

For bookmarks that link to an HTML page rather than another tweet, ingest also
captures a best-effort plain-text copy of the linked article in the raw bookmark
markdown. Fetch or extraction failures fall back to the existing tweet-only
bookmark format.
When a bookmarked tweet quotes a tweet that contains a Twitter article, the
article body is also captured via the X API.

Report success or failure from the command result. On a non-zero exit, or output
containing `error`, `failed`, `exception`, or `traceback`, follow
`../../ops/notify-soft-fail/SKILL.md` and send:

`Bookmark Ingestion cron failure: <brief summary of what went wrong from the output>`

**Do NOT treat the success-path stdout `No pending bookmarks.` (from `process.cjs:459` when `pending.length === 0`) as a soft failure.** That message is the healthy no-op — the fetch succeeded, no new bookmarks have been queued since the last run, and the pending queue is empty. The `failed` keyword already covers the real fetch-failure path (`Failed to fetch bookmarks: ...` from `fetch.cjs:205`). See `infra/runbooks/notify-soft-fail-keyword-false-positive.md` for the regression context (false-positive class observed 2026-08-10 when 'no bookmarks' was in the trigger keyword list — substring-matched the success-path stdout).
