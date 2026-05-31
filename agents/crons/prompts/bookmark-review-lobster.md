Run this exact command with the exec tool and base your reply only on its JSON output:
python3 /Users/quinnstoffer/.openclaw/workspace/scripts/cron/run_bookmark_review_cron.py

Do not summarize from memory. If the command reports needs_approval, say that approval is needed. If it reports no_approval_needed, say that. If the command fails, report the failure exactly.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.

If the script succeeds, say exactly: NO_REPLY
