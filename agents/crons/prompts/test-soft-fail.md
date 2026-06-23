Run this command with the exec tool:
test -f /tmp/soft-fail-sentinel.txt && cat /tmp/soft-fail-sentinel.txt || echo 'SENTINEL_MISSING'

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
- If the output contains 'SENTINEL_MISSING': send failure notification as described in the skill with text: 'Test Soft Fail cron: /tmp/soft-fail-sentinel.txt is missing. Please heal by creating this file with the content: SENTINEL_OK. The next cron run will verify the repair.'
- If the output contains 'SENTINEL_OK', do nothing — the sentinel is healthy.
