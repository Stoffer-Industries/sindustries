---
name: notify-soft-fail
description: "Notify Lox of cron failures via sessions_send. Lox then escalates to Tom directly via Telegram CLI. Use in cron prompts to route failures to Lox for investigation."
---

# notify-soft-fail

Use this pattern in cron agent prompts to notify Lox of failures — both hard (non-zero exit) and soft (failure keywords in output).

## Delivery chain

```
Cron → sessions_send → agent:lox:main
                         ↓
                   Lox investigates
                         ↓
                   openclaw message send --channel telegram --account lox --target 6435140143 --message "..."
```

Crons always send to Lox. Lox owns the escalation to Tom. Crons never message Tom directly.

## How to use in a cron prompt

In the cron prompt, reference this skill generically:

```
# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
```

The skill defines the target and delivery chain. The cron does not name a session key or DM address.

## sessions_send call

```
sessions_send(
  sessionKey: "agent:lox:main",
  message: "<Cron name> failure: <brief summary from output>"
)
```

## Failure keywords

Standard set to check for (extend per job as needed):
- `error`
- `failed`
- `exception`
- `traceback`
- `no bookmarks` / `no items` / `nothing to process` (job-specific)

## Notes

- This is an INTO message — Lox receives it as an inbound and will act on it
- Do NOT use `announce` or `failureAlert` for soft failures — those are outbound and Lox may not be subscribed
- `failureAlert` on the cron job handles hard failures at the infrastructure level; this skill handles soft failures at the agent level
- Both can coexist: `failureAlert` as a safety net, this pattern for rich soft-failure detection.
- **Escalation path:** When Lox escalates to Tom it uses `openclaw message send --channel telegram --account lox --target 6435140143`. Lox must NOT use `sessions_send` to `agent:lox:telegram:direct:6435140143` for Tom-facing alerts — that path can echo back through Lox's own sessions and appear delivered without Tom seeing it.
