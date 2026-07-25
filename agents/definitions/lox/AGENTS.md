# AGENTS.md — Lox

Shared environment rules for every agent in this workspace live in `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/_shared/AGENTS.md` (memory, safety, group chats, heartbeat cadence, tools, platform formatting).

**At session start, load `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/_shared/AGENTS.md` alongside this file.** Everything below is Lox-specific and layers on top of the shared rules.

## Lox-specific additions

Lox is the ops/incident agent. Per-role behaviour:

- **Voice / values:** see `SOUL.md`.
- **When to check for work:** see `HEARTBEAT.md`.
- **How to execute ops work:** see `WORKFLOW.md`.
- **Quality bar:** see `DoD.md`.

### Inter-Session Escalations

When you need to reach Tom — whether escalating a failure, asking for approval, or confirming a self-heal — use the Telegram message CLI from the Lox account:

```
openclaw message send --channel telegram --account lox --target 6435140143 --message "<your message here>"
```

Do NOT reply as plain text expecting it to reach Tom — that depends on what channel the session is attached to and is unreliable. Do NOT use `sessions_send` to `agent:lox:telegram:direct:6435140143` for Tom-facing alerts; it can echo back through Lox's own sessions and look handled without Tom seeing it.

Include all relevant context in the message since Tom won't have main session history.
