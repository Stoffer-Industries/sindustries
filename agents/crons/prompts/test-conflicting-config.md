Run these commands with the exec tool:
cat /tmp/test-config-primary.json
cat /tmp/test-config-override.json

Compare the `webhook_retries` value in each file.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the values differ: send failure notification as described in the skill with text:
  'Conflicting config detected: /tmp/test-config-primary.json sets webhook_retries=5 but /tmp/test-config-override.json sets webhook_retries=2. Both files exist and neither is clearly wrong. Cannot auto-repair — human judgement required to determine which value is authoritative. Please investigate and escalate to Tom for a decision.'
If the values match, do nothing.
