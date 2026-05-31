Run this exact command with the exec tool and base your reply only on its JSON output:
python3 /Users/quinnstoffer/.openclaw/workspace/scripts/cron/run_bookmark_review_cron.py

Do not summarize from memory. If the command reports needs_approval, say that approval is needed. If it reports no_approval_needed, say that. If the command fails, report the failure exactly.

# notify-soft-fails
After running:
- If the script exits with a non-zero return code, OR if the output contains 'error', 'failed', 'exception', or 'traceback' — use the sessions_send tool to send a message to session key 'agent:lox:main' with the text:
  'Bookmark Review Lobster cron failure: <brief summary of what went wrong>'
- If the script succeeds, do nothing further.
