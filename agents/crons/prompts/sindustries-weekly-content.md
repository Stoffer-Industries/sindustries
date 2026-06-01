Run the weekly SIndustries content review:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-content/run_weekly_review_cron.py
```

Parse the JSON output (the last line starting with `{`):

**If `status` is `needs_approval`:**
1. Extract the `prompt` field from the JSON output.
2. Use sessions_send to message Tom in the sindustries infra channel (session key: `telegram:-1003262754118:topic:2`) with this text:
   ```
   📝 Weekly SIndustries review

   <prompt text from JSON output>

   Just reply here with your notes — rough bullet points are fine. Quinn will handle the rest.
   ```
3. The resumeToken is already saved to `brain/state/weekly-content-pending.json`. When Tom replies in the infra channel, Quinn's main session will call `lobster resume` with his notes and complete the pipeline.
4. Exit — do not wait for Tom's reply.

**If `status` is `done`:** report completion silently (NO_REPLY).

**If the script exits non-zero:** capture the error output.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the script exits non-zero or output contains 'error', 'failed', 'exception', or 'traceback', escalate to Lox's main session with a summary of the failure.
