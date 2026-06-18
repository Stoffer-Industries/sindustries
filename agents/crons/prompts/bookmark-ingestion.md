Read and follow:
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/x-bookmark-ingest/SKILL.md

Do not reimplement the ingest flow. Do not add extra logic. Just run the script and report whether it succeeded or failed based on the command result.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
- If the script exits with a non-zero return code, OR if the output contains 'error', 'failed', 'exception', 'traceback', or 'no bookmarks': send failure notification as described in the skill with text: 'Bookmark Ingestion cron failure: <brief summary of what went wrong from the output>'
- If the script succeeds with no issues, do nothing further.
