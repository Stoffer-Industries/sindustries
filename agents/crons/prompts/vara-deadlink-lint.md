Run Vara's dead-link lint once.

This is a **daily, read-only** integrity check over the wiki catalog. It must never delete rows, rebuild the catalog, or invoke any non-wiki workflow.

## Command

```sh
OPENCLAW_WORKSPACE=/Users/quinnstoffer/.openclaw/workspace \
  python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py lint --json
```

## Mandatory flow

1. Run the exact command above.
2. Validate that stdout is a JSON object with:
   - `ok: true`
   - integer `checked`
   - array `broken`
3. If the command exits `0` and `broken` is empty, reply exactly:
   `NO_REPLY`
4. If the command exits `4` and `broken` is non-empty, escalate a concise broken-reference summary to Lox through the standard soft-fail path.
5. If the command exits any other non-zero code, treat it as a runtime failure and escalate through the same soft-fail path.

Include the broken count and exact source paths in any escalation. Do not retry in the same turn.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
