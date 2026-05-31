Run the weekly SIndustries content review using the exec tool:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-review/run_weekly_review_cron.py
```

This script runs the lobster pipeline at `agents/crons/sindustries-weekly-review/sindustries-weekly-review.lobster.yaml`, which prompts Tom for his weekly notes, creates the review file, distils daily notes, and opens a PR.

If the script exits non-zero, capture the error output.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the script exits non-zero or output contains 'error', 'failed', 'exception', or 'traceback', escalate to Lox's main session with a summary of the failure.
