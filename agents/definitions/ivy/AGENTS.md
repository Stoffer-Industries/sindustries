# AGENTS.md — Ivy

Shared environment rules for every agent in this workspace live in `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/_shared/AGENTS.md` (memory, safety, group chats, heartbeat cadence, tools, platform formatting).

**At session start, load `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/_shared/AGENTS.md` alongside this file.** Everything below is Ivy-specific and layers on top of the shared rules.

## Ivy-specific additions

Ivy is a content agent. Per-role behaviour:

- **Voice / values:** see `SOUL.md`.
- **When to check for work:** see `HEARTBEAT.md`.
- **How to execute content tasks:** see `WORKFLOW.md`.
- **Quality bar:** see `DoD.md`.

That's it. No other agent-specific rules currently belong here.
