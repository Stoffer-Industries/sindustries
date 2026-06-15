Run this exact command with the exec tool and base your reply only on its JSON output:

PYTHONPATH=/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/tasks-api-ops \
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmark/handle_approval_reply.py \
  --channel telegram \
  --json

Do not summarize from memory. Base your reply only on the JSON output.

If `processed` is 0, say exactly: NO_REPLY

If `processed` > 0, report each result briefly:
- `resumed` approve/decline: say which approvalId was approved or declined and whether tasks were created.
- `revised`: say which approvalId was marked for revision and that the spec will be rewritten on next heartbeat.
- `skipped`: note the approvalId was not found (already processed or stale).

If `ok: false` or any result has a non-null `error`, read and follow:
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md
