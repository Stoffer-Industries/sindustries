Run the weekly SIndustries content review using the exec tool:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-review/run_weekly_review_cron.py
```

This script runs the lobster pipeline at `agents/crons/sindustries-weekly-review/sindustries-weekly-review.lobster.yaml`, which prompts Tom for his weekly notes, distils the week's daily notes, and writes the output to `brain/content/sindustries-weekly-content`.

Once the script completes successfully, create a content task in the Tasks API with a link to the weekly notes output:

```
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py create \
  --title "Weekly content review — <date>" \
  --type content \
  --description "Weekly SIndustries content notes ready for review: brain/content/sindustries-weekly-content/<date>.md" \
  --priority normal
```

If the script exits non-zero, capture the error output.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the script exits non-zero or output contains 'error', 'failed', 'exception', or 'traceback', escalate to Lox's main session with a summary of the failure.
