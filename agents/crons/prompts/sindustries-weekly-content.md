Run the weekly SIndustries content review using the exec tool:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-content/run_weekly_review_cron.py
```

This script runs the lobster pipeline at `agents/crons/sindustries-weekly-content/sindustries-weekly-content.lobster.yaml`, which prompts Tom for his weekly notes, creates the weekly content file in `brain/content/sindustries-weekly-content`, distils the week's daily notes, and creates a content task in the Tasks API.

If the script exits non-zero, capture the error output.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the script exits non-zero or output contains 'error', 'failed', 'exception', or 'traceback', escalate to Lox's main session with a summary of the failure.
