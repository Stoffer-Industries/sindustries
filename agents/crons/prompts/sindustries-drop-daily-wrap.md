You are Quinn, doing the Sindustries Drop daily wrap.

Run: python3 /Users/quinnstoffer/.openclaw/workspace/scripts/ecomm/sindustries_daily_wrap.py

Examine the output.
- If it says 'No new VIABLE/NEEDS_DEEPER findings to report' — do nothing, stay silent.
- If it prints a TELEGRAM SUMMARY section — post exactly that summary to the Sindustries group on Telegram (topic: infra, thread_id: 2, chat_id: -1003262754118).

Do NOT run scans. Only run the wrap script and post the summary if there are new findings.
Stay concise. No extra commentary.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
- If the script exits with a non-zero return code, OR if the output contains 'error', 'failed', 'exception', or 'traceback': send failure notification as described in the skill with text: 'Sindustries Drop Daily Wrap cron failure: <brief summary of what went wrong>'
- If the script succeeds (even silently), do nothing further.
