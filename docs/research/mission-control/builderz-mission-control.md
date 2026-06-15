# Research: builderz-labs/mission-control

**Reviewed:** 2026-06-16  
**Repo:** https://github.com/builderz-labs/mission-control  
**Task:** 2283c2c4-7d9f-4621-8d50-aec23e1f3a3c  
**AC:**
- [x] Fetch/clone the repo  
- [x] Review README and features  
- [x] Review UI in docs/mission-control-overview.png  
- [x] Compare UI patterns against current Sindustries tasks app  
- [x] Note if useful for Stoffer Industries  

---

## Repo Overview

**builderz-labs/mission-control** is an open-source dashboard for AI agent orchestration. It is a standalone, self-hosted control plane for managing AI agent fleets — dispatching tasks, monitoring spend, coordinating multi-agent workflows, and enforcing quality gates — all from a single dashboard.

- **License:** MIT  
- **Stack:** Next.js 16 / React 19 / TypeScript 5.7 / SQLite (better-sqlite3, WAL mode) / Zustand / Recharts  
- **Status:** Alpha (APIs may change between releases)  
- **Scale:** 101 REST endpoints, 577 tests (282 unit + 295 E2E with Playwright), 32 dashboard panels  
- **Runs at:** port 3000 (vs Autensa/crshdn at port 4000)

**Important distinction:** This is NOT the same project as crshdn/mission-control (Autensa). Where Autensa is a product improvement engine focused on the Research→Swipe→Build→PR autonomous cycle, builderz-labs/mission-control is a **pure orchestration dashboard** — the equivalent of a control tower for whatever agents you already have.

---

## Architecture

```
mission-control (Next.js 16, port 3000)
├── src/proxy.ts          — Auth gate + CSRF + network access control
├── src/app/api/          — 101 REST endpoints
├── src/components/panels/ — 32 feature panels (single SPA shell)
├── src/lib/
│   ├── db.ts             — SQLite WAL mode
│   ├── auth.ts           — Session + API key auth, RBAC
│   ├── migrations.ts     — 39 schema migrations
│   ├── scheduler.ts      — Background task scheduler
│   ├── skill-sync.ts     — Bidirectional disk ↔ DB skill sync
│   ├── skill-registry.ts — Registry client + security scanner
│   ├── agent-evals.ts    — Four-layer eval framework
│   ├── security-events.ts— Security event logger + trust scoring
│   └── adapters/         — Framework adapters (OpenClaw, CrewAI, LangGraph, AutoGen, Claude SDK)
└── .data/                — Runtime data (SQLite DB, token logs)
```

SQLite is the only required storage. No Redis, no Postgres, no external services required. Gateway connection is optional via `NEXT_PUBLIC_GATEWAY_OPTIONAL=true`.

---

## UI Overview (docs/mission-control-overview.png)

The overview screenshot (referenced in README) shows a **compact dark-mode dashboard** with:

- **Left nav rail** — vertical icon nav with 32 panel destinations
- **Top header bar** — live system status indicators, active agent count, cost burn rate
- **Main area** — multi-panel layout, default view shows: agent fleet status grid, active task kanban, and live activity feed side-by-side
- **Agent cards** — status chip (idle/active/offline), heartbeat timestamp, current task title, model badge, trust score gauge
- **Task kanban** — 6 columns (inbox → assigned → in-progress → review → quality review → done), color-coded by priority, assignee avatars

Visual style: dense information layout, dark (#0a0a0a bg), monospace data values, subtle borders. Feels like a dev ops console rather than a project management tool.

The task panel screenshots show:
- `mission-control-tasks.png` — kanban with 6 columns, priority colored labels, drag-and-drop handles, inline sub-agent spawn button per card
- `mission-control-agents.png` — agent roster with role badges, model selector, heartbeat status, trust score bar
- `mission-control-memory-graph.png` — interactive graph visualization of agent memory relationships (sessions, memory chunks, linked knowledge files)
- `mission-control-cron.png` — recurring task scheduler UI with natural language input ("every morning at 9am") and cron preview

---

## Key Features

### 32 Dashboard Panels
Tasks, agents, skills, logs, tokens, memory, security, cron, alerts, webhooks, pipelines, and more — all from a single SPA shell with no page reloads.

### Task Board
Kanban with 6 columns, drag-and-drop, priority levels, assignments, threaded comments, and **inline sub-agent spawning**. Multi-project support with per-project ticket prefixes. This is more feature-complete than the current Sindustries tasks app (which is M4 React/Vite against our tasks-api).

### Skills Hub
Browse, install, and security-scan agent skills from:
- Local directories (`~/.agents/skills`, `~/.codex/skills`, project-local)
- External registries (ClawdHub, skills.sh)

Built-in security scanner checks for prompt injection, credential leaks, data exfiltration, obfuscated content, and dangerous shell commands before installation. Supports 5 skill roots including `~/.openclaw/skills`.

### Agent Eval Framework
Four-layer evaluation:
1. **Output evals** — task completion scoring against golden datasets
2. **Trace evals** — convergence/loop detection
3. **Component evals** — tool reliability with p50/p95/p99 latency
4. **Drift detection** — 10% threshold vs 4-week rolling baseline

### Security Audit & Trust Scoring
- Real-time posture scoring (0–100)
- Secret detection across agent messages
- MCP tool call auditing
- Injection attempt tracking
- Per-agent trust scores
- Hook profiles (minimal/standard/strict) per deployment

### Natural Language Recurring Tasks
"Every morning at 9am" → parsed to cron → stored in task metadata → template-clone pattern spawns dated child tasks. This is the equivalent of our CronCreate but surfaced in a UI with history.

### Claude Code Bridge
- Auto-discovers local Claude Code sessions from `~/.claude/projects/`
- Surfaces team tasks from `~/.claude/tasks/` and `~/.claude/teams/` on the dashboard
- Read-only (no writes to Claude Code state)

### Multi-Gateway Support
Framework adapters for: OpenClaw, CrewAI, LangGraph, AutoGen, Claude SDK, and generic fallback. Each normalizes registration, heartbeats, and task reporting to a common interface. Multiple gateways can be connected simultaneously.

### Real-Time
WebSocket + SSE push updates with smart polling that pauses when you're away. Zero stale data guaranteed.

### Role-Based Access Control
Viewer / Operator / Admin roles. Session cookies + API key auth + Google Sign-In with admin approval workflow.

### MCP Server
35+ tools exposed via MCP for Claude Code agents — agents can interact with Mission Control directly as an MCP tool without any custom API code.

---

## Docker Setup

```bash
# Zero-config Docker
docker compose up   # auto-generates credentials, persists across restarts

# Or prebuilt from GHCR
docker pull ghcr.io/builderz-labs/mission-control:latest
docker run --rm -p 3000:3000 ghcr.io/builderz-labs/mission-control:latest

# Production hardened
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d
```

First run: visit `http://localhost:3000/setup` to create admin account. Credentials are auto-generated and shown in Settings.

---

## Comparison: Builderz Mission Control vs Current Sindustries Tasks App

| Dimension | Sindustries tasks app (current) | builderz-labs/mission-control |
|-----------|--------------------------------|-------------------------------|
| Stack | React/Vite + tasks-api (Express/Prisma/Postgres) | Next.js 16 + SQLite |
| Task board | Kanban (M4 milestone, basic) | 6-column kanban with sub-agent spawning, threaded comments |
| Agent management | Not in UI (managed via OpenClaw gateway directly) | 32 panels including agent roster, heartbeat, trust scores |
| Cost tracking | None | Per-session token tracking, trend charts, model breakdowns |
| Security audit | None | Real-time posture score, secret detection, MCP auditing |
| Skills management | Not in UI (SKILL.md files on disk) | Skills Hub with security scanner + external registry browser |
| Memory browser | None | Interactive knowledge graph visualization |
| Recurring tasks | Via crons + CronCreate | Natural language scheduler with UI history |
| Claude Code integration | Native (we ARE Claude Code) | Read-only bridge surfaces sessions + tasks |
| Auth | None (internal tool) | RBAC: viewer / operator / admin + Google Sign-In |
| External deps | Postgres (required) | SQLite only (zero external deps) |
| API surface | ~10 endpoints | 101 REST endpoints (OpenAPI 3.1 spec) |
| Test coverage | Unit tests (M1) | 577 tests (282 unit + 295 E2E Playwright) |
| MCP server | Not available | 35+ tools via MCP server |

**Gap summary:** builderz-labs/mission-control is significantly more feature-complete than our current tasks app across every dimension except one: it uses SQLite while we use Postgres. For our current scale (internal single-tenant), SQLite WAL mode is more than sufficient.

---

## UI Patterns Worth Adopting

These specific patterns from the builderz dashboard are worth considering for the Sindustries tasks app:

1. **Inline sub-agent spawn from task card** — trigger a new agent session directly from a task card without leaving the board. We do this via CLI/skills; surfacing it in the UI would reduce context switching.

2. **Agent trust score + heartbeat on agent roster** — each agent card shows live heartbeat timestamp, trust score gauge, and current task. Currently we have no visibility into agent health without querying the gateway.

3. **Skills Hub with security scanner** — browsing and installing skills from a UI with pre-install security scan is meaningfully better than editing SKILL.md files manually. Worth pulling the security scanner logic even if not the full UI.

4. **Memory knowledge graph** — the interactive graph visualization of agent memory relationships is novel. Could help Tom understand what Lox/Rowan/Ivy are retaining across sessions.

5. **Natural language recurring tasks** — "every morning at 9am" as task input, parsed to cron behind the scenes. Simpler UX than writing cron expressions directly.

6. **32-panel SPA shell with nav rail** — the single-page app architecture with icon nav rail is appropriate for a dashboard of this scope. Our current tasks app has a narrower scope but the nav rail pattern scales better as we add features.

---

## Recommendation: **Adopt as dashboard layer OR selectively borrow patterns**

Two viable paths:

### Option A: Replace the Sindustries tasks app with builderz-labs/mission-control
**Pros:** Eliminates the need to build agent management, cost tracking, security audit, skills hub, and memory browser ourselves. Docker deploy is trivial. MCP server means agents get a richer API surface without custom code. Saves significant build time.  
**Cons:** Alpha software (schema may change). SQLite replaces Postgres — migration cost. We'd lose the tasks-api layer that our Python skills currently target. Some Sindustries-specific workflow logic (Lobster pipeline, bookmark review states) wouldn't map cleanly to Mission Control's task model without custom panels.

### Option B: Keep building our own tasks app, borrow specific patterns
**Pros:** Full control, Postgres retained, existing API contract preserved. Pick the patterns that matter (inline agent spawn, trust scores, natural language cron) and implement them incrementally.  
**Cons:** Significant build investment to reach feature parity. We'd be re-implementing things Mission Control already has.

**Overall verdict:** Option A is worth a serious evaluation. builderz-labs/mission-control is the most polished open-source agent dashboard available. For Stoffer Industries — which is primarily a platform for Tom's AI agents — having a single control plane (32 panels, agent fleet, cost tracking, skills hub, memory browser) out of the box is substantially more useful than continuing to build and maintain our own tasks app.

Recommended next step: **spin up builderz-labs/mission-control via Docker locally, connect it to the OpenClaw gateway, and use it alongside the existing tasks app for one week before committing to migration.**

---

## Blockers

None. The Docker deploy is zero-config and the repo is mature enough for local evaluation. If Tom decides to proceed to adoption:
- Plan a migration path from the existing tasks-api (Postgres → SQLite or run both temporarily)
- Review 39 schema migrations to understand what state Mission Control will own vs what stays in our tasks-api
- Confirm `NEXT_PUBLIC_GATEWAY_OPTIONAL=true` path covers all use cases that don't need real-time gateway events
