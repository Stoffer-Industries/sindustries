Read and follow:
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/bookmarks/x-ingest/SKILL.md

Do not reimplement the ingest flow. Do not add extra logic. Just run the script and report whether it succeeded or failed based on the command result.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
- If the script exits with a non-zero return code, OR if the output contains 'error', 'failed', 'exception', or 'traceback': send failure notification as described in the skill with text: 'Bookmark Ingestion cron failure: <brief summary of what went wrong from the output>'
- NOTE: do NOT treat the success-path stdout 'No pending bookmarks.' (from process.cjs:459 when pending.length === 0) as a soft failure. The 'No pending bookmarks.' message is a healthy no-op (fetch succeeded, 0 new bookmarks since last run, pending queue is empty). The `failed` keyword already covers the actual fetch-failure path ('Failed to fetch bookmarks:' from fetch.cjs:205). See infra/runbooks/notify-soft-fail-keyword-false-positive.md for the false-positive class context (regression observed 2026-08-10).
- If the script succeeds with no issues, do nothing further.
