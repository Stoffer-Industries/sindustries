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

Report success or failure from the command result. On a non-zero exit, or output
containing `error`, `failed`, `exception`, `traceback`, or `no bookmarks`, follow
`../notify-soft-fails/SKILL.md` and send:

`Bookmark Ingestion cron failure: <brief summary of what went wrong from the output>`
