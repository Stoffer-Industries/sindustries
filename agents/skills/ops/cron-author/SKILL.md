---
name: cron-author
description: "Author, edit, or review cron job prompts stored as .md files in sindustries/agents/crons/prompts/."
---

# Cron Author

Cron prompts live as plain markdown files. The gateway cron metadata (schedule, delivery, agentId) stays in the API — only the prompt content lives in the file.

## File location

```
codebases/sindustries/agents/crons/prompts/<name>.md
```

Use kebab-case names that match the cron's purpose, e.g. `test-soft-fail.md`, `bookmark-ingest.md`.

## Cron payload

When creating or updating a cron via the `mcp__openclaw__cron` tool, set the payload message to:

```
Read and execute the instructions in /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/prompts/<name>.md
```

The agent reads the file at runtime. To change what a cron does, edit the `.md` file — no API update needed.

## Prompt file structure

Plain markdown. No frontmatter. Write the instructions as you would any agentTurn prompt.

```markdown
Run this command with the exec tool:
<command>

Check the output and take appropriate action.

# notify-soft-fails
...
```

## notify-soft-fails

Any cron that can encounter a soft failure (missing file, stale lock, config mismatch, auth error, unexpected output) **must** end with a notify-soft-fails block. This is not optional — every production cron prompt must have one.

Add this block verbatim at the end of the prompt file:

```
# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
```

Full pattern reference: `skills/ops/notify-soft-fail/SKILL.md`

## Workflow

1. Create or edit the `.md` file in `codebases/sindustries/agents/crons/prompts/`
2. If creating a new cron, add it via `mcp__openclaw__cron` with `payload.message` pointing to the file
3. To update an existing cron's prompt, just edit the file — takes effect on next run
4. To update metadata (schedule, delivery, model), use `mcp__openclaw__cron` action `update`
