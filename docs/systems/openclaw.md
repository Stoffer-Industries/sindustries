# OpenClaw

**Type:** System reference
**Last updated:** 2026-06-30
**Owner:** Quinn (runtime config) · Tom (infrastructure decisions)
**Config:** `~/.openclaw/openclaw.json`
**Docs:** `~/.openclaw/tools/node-v22.22.0/lib/node_modules/openclaw/docs/`

---

## Purpose

OpenClaw is the agent runtime that powers Quinn, Rowan, Ivy, and Lox. It handles channel routing (Telegram, Signal), session lifecycle, cron scheduling, tool execution, model calls, and inter-agent messaging. It runs as a local gateway on Tom's machine.

Sindustries agents live in this repo. OpenClaw is what runs them.

---

## Architecture

```
Tom's machine
  openclaw gateway (node process)
    │
    ├── Channel adapters (Telegram, Signal)
    ├── Session manager (per-agent conversation contexts)
    ├── Cron scheduler (fires agent sessions on schedule)
    ├── Tool executor (exec, web_fetch, sessions_send, etc.)
    └── Model router (Anthropic / OpenAI)

  ~/.openclaw/
    openclaw.json      gateway config
    workspace/         Quinn's home (this repo symlinked from codebases/)
    tools/             OpenClaw CLI + built-in skills
    .env               secrets (API keys, tokens)

  ~/.openclaw/workspace/
    codebases/sindustries/   ← sindustries repo (checked out here)
    agents/                  ← agent home dirs (symlinked from sindustries)
      quinn/                 ← Quinn's agent dir
      rowan/                 ← Rowan's agent dir
      ivy/                   ← Ivy's agent dir
      lox/                   ← Lox's agent dir
    brain/                   ← iCloud-synced private data
```

**Key constraint:** `~/.openclaw/` is Quinn's responsibility. Rowan, Ivy, and Lox cannot write to it. When an agent needs an OpenClaw config change, they post `[openclaw-needed]` on the task; Quinn applies it during heartbeat.

---

## Agents and sessions

Each agent runs in its own OpenClaw session context. Session keys follow the pattern `agent:<name>`.

| Agent | Session key | Channel | Model |
|---|---|---|---|
| Quinn | `agent:quinn` (main) | Telegram (Tom's personal) | claude-sonnet-4-6 |
| Rowan | `agent:rowan` | Telegram (infra group) | claude-sonnet-4-6 |
| Ivy | `agent:ivy` | Internal only | claude-sonnet-4-6 |
| Lox | `agent:lox` | Telegram (infra group) | claude-sonnet-4-6 |

Sub-agents are spawned via `sessions_spawn`. They run in isolated contexts and return results via completion events. Quinn uses `sessions_yield` to wait for spawned sub-agents.

---

## Heartbeat

Quinn's heartbeat fires every 30 minutes via OpenClaw's cron scheduler. It runs the full `HEARTBEAT.md` checklist: bookmark state, tech design approvals, content task dispatch, PR review, `.openclaw` handoffs.

Cron jobs for other agents live in `agents/crons/prompts/` as `.md` files. The cron scheduler references these by path in `openclaw.json`.

---

## Channel routing

Messages arrive via Telegram. OpenClaw's channel adapter routes them to the correct agent session based on chat ID and topic ID.

| Chat | Topic | Routed to |
|---|---|---|
| Tom's DM | — | Quinn (main session) |
| Sindustries group | infra topic | Quinn (infra context) |
| Sindustries group | other topics | Rowan / Lox (per config) |

Authorized senders are configured in `openclaw.json` under `channels.telegram.allowFrom`. Only Tom's number (`6435140143`) is allowlisted.

---

## Brain (iCloud)

`~/.openclaw/workspace/brain/` is a symlink into iCloud Drive. It holds private data that should not live in the sindustries git repo:

- `brain/bookmarks/` — inbound X bookmarks and research
- `brain/bookmarks/specs/` — product specs derived from bookmark review
- `brain/tasks/specs/` — implementation specs linked to feature tasks
- `brain/state/` — pipeline state files (`bookmark-review-state.json`, `quinn-ops-state.json`, `lox-incident-state.json`)
- `brain/ops/notes/` — daily ops notes feeding the content pipeline
- `brain/content/` — weekly content review files

**Critical:** git worktrees for sindustries branches must not materialise a real `brain/` directory. The path must remain a symlink. Rowan's WORKFLOW.md documents this constraint.

---

## Config

Key fields in `openclaw.json` (use `config.schema.lookup` for authoritative docs):

| Field | Purpose |
|---|---|
| `agents.defaults.workspace` | Root workspace path |
| `agents.defaults.heartbeat.every` | Heartbeat interval (e.g. `"30m"`) |
| `channels.telegram.allowFrom` | Allowlisted sender IDs |
| `crons` | Scheduled agent jobs (path to `.md` prompt) |
| `plugins` | External integrations (brave search, etc.) |

Edit config via `openclaw config set <field> <value>` or by patching `openclaw.json` directly. Restart gateway after config changes: `openclaw gateway restart`.

---

## Runbook notes

**Gateway not responding:** `openclaw gateway status` → `openclaw gateway restart`.

**Session stuck:** `sessions_list` to inspect active sessions. Sub-agent sessions time out after inactivity; parent sessions are persistent.

**Cron not firing:** `cron list` to verify registration. Check `openclaw.json` crons entries match the `.md` paths in `agents/crons/prompts/`.

**Apply OpenClaw config change (from a task):** Quinn reads the `[openclaw-needed]` task comment, applies the change to `~/.openclaw/`, validates, posts `[openclaw-done]`.

**Brain symlink broken:** `ls -la ~/.openclaw/workspace/brain` — should point into `~/Library/Mobile Documents/`. Re-link if iCloud path changed.

---

## Related

- `~/.openclaw/tools/.../docs/` — full OpenClaw documentation
- `agents/definitions/quinn/HEARTBEAT.md` — Quinn heartbeat config
- `agents/crons/prompts/` — all cron job prompts
- `docs/systems/agent-orchestration.md` — how agents work together
- workspace `docs/infra/` — incident reviews and operational baselines
