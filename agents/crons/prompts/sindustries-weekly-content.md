Run the weekly SIndustries content review:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-content/run_weekly_review_cron.py
```

This collects the week's ops notes, distils them via LLM, writes the weekly review file to `brain/content/sindustries-weekly-content/`, and creates a content task in the Tasks API.

If the script exits non-zero, capture the error output.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the script exits non-zero or output contains 'error', 'failed', 'exception', or 'traceback', escalate to Lox's main session with a summary of the failure.
