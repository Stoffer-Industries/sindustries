Run these commands with the exec tool:
test -f /tmp/bookmark-ingest.lock && cat /tmp/bookmark-ingest.lock || echo 'NO_LOCK'

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the output contains a lock timestamp (not NO_LOCK), that is an unacceptable error — escalate to Lox's main session.

If NO_LOCK, do nothing.
