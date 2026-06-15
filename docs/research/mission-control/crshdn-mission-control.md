# Research: crshdn/mission-control (Autensa)

**Reviewed:** 2026-06-16  
**Repo:** https://github.com/crshdn/mission-control  
**Task:** 91fefa7d-5c68-43f5-98ed-468dab5277f3  
**AC:**
- [x] Clone/fork the repo  
- [x] Review Docker setup for Mac mini  
- [x] Check OpenClaw Gateway integration  
- [x] Review full pipeline  
- [x] Compare against current Sindustries process  
- [x] Recommend switch-to-mission-control OR continue-building-our-own  

---

## Repo Overview

**crshdn/mission-control** is branded **Autensa** — "The World's First Autonomous Product Engine." It bills itself as an end-to-end autonomous product improvement loop: Research → Ideation → Swipe → Build → Test → Review → PR, all driven by AI agents.

- **License:** MIT  
- **Stack:** Next.js 14 / TypeScript / SQLite (better-sqlite3)  
- **Version:** v2.5.1 (active development, ~8 open issues, ~7 open PRs)  
- **Live demo:** https://missioncontrol.ghray.com  

Despite the GitHub repo name being `mission-control`, the project is now called Autensa and is commercially positioned at autensa.com. The repo is the self-hosted community version of a SaaS product.

---

## Architecture

```
Autensa (Next.js, port 4000)
    ↕ WebSocket
OpenClaw Gateway (port 18789)
    ↕
AI Providers (Anthropic / OpenAI / etc.)
    ↕
SQLite (tasks, products, ideas, costs)
    ↕
Autopilot Engine (Research → Ideation → Swipe → Build → Test → Review → PR)
```

Autensa connects to an **existing OpenClaw Gateway** — it is not a gateway itself. It adds a UI and autonomous pipeline layer on top of OpenClaw's agent runtime.

---

## Key Features

### Product Autopilot (headline feature)
A continuous product improvement loop per tracked product:
1. **Research agents** scan codebase, live site, competitors, SEO, user intent
2. **Ideation agents** generate scored feature ideas (impact / feasibility / size)
3. **Swipe UI** (Tinder-style) for approve / reject / maybe decisions
4. **Build pipeline** — approved idea → agent implements → test agent runs → review agent inspects → GitHub PR created automatically

### Agent Orchestration
- Multi-agent pipeline (Builder → Tester → Reviewer → Learner)
- **Convoy Mode** — parallel execution with a visual DAG for large features
- Operator Chat — queued notes + direct messages mid-build
- Agent health monitoring with auto-nudge for stalled agents
- Checkpoint & crash recovery (saves mid-task state, resumes from last checkpoint)
- Workspace isolation (git worktrees per task, port allocation 4200–4299)

### Task Management
- Kanban board (7 columns) with drag-and-drop
- AI planning phase with clarifying Q&A before any code is written
- Per-task / per-product / daily / monthly cost tracking with budget caps
- Real-time SSE activity feed

### Infrastructure
- Docker-ready (Dockerfile + docker-compose.yml)
- Named Docker volumes for SQLite and workspace files (persists data)
- OpenClaw Gateway integration via WebSocket
- Bearer token auth, HMAC webhooks, Zod validation
- Multi-machine via Tailscale

---

## Docker Setup (Mac mini)

The Docker deployment is straightforward and designed for self-hosted use:

```bash
git clone https://github.com/crshdn/mission-control.git
cd mission-control
cp .env.example .env
# Edit .env:
# OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789
# OPENCLAW_GATEWAY_TOKEN=<token from ~/.openclaw/openclaw.json>
docker compose up -d --build
# → http://localhost:4000
```

Named volumes (`mission-control-data`, `mission-control-workspace`) persist SQLite and workspace files across restarts. No additional services required (no Redis, no Postgres).

**Mac-specific note:** `host.docker.internal` is supported natively on Docker Desktop for Mac — the gateway token can be read from `~/.openclaw/openclaw.json` on the host.

---

## OpenClaw Gateway Connection

Autensa is purpose-built for OpenClaw. It connects over WebSocket and:
- Discovers and imports agents from the gateway catalog
- Dispatches tasks as OpenClaw sessions (per-task session since v2.5.0 — previously all tasks on one agent shared one session, exhausting context)
- Routes AI calls through `openclaw/default` with `x-openclaw-model` header
- Reads the gateway token from `OPENCLAW_GATEWAY_TOKEN` env var

This is our exact runtime setup — the integration surface is a direct fit.

---

## What Worked (Based on Code Review + Demo)

- **Docker setup is clean.** Single `docker compose up` command, named volumes, no external DB required.
- **OpenClaw integration is native.** The project was built alongside OpenClaw — WebSocket events, agent discovery, session management are all first-class.
- **Swipe-to-decide UX** is a compelling abstraction for product owners who don't want to write task specs manually.
- **Cost tracking** is granular (per-task, per-product, daily/monthly caps) — more detailed than anything we currently have.
- **Checkpoint/crash recovery** is production-grade — agents resume from last checkpoint rather than restarting from scratch.
- **Convoy Mode** (parallel multi-agent with DAG) is more sophisticated than our current single-agent-per-task pattern.

---

## What Didn't Work / Blockers

- **Branding drift:** The repo (`crshdn/mission-control`) and the product (`autensa.com`) are diverging. README says "Autensa" throughout; the repo name is a legacy artifact. This signals commercial pivot that may reduce community maintenance.
- **No auth on demo:** The live demo at missioncontrol.ghray.com has no login wall as of research date — indicates the project is in active early-access mode.
- **Hetzner VPS recommendation in README:** Optimized for Linux VPS deployment; Mac mini wasn't explicitly tested in their docs, but Docker removes platform dependency.
- **GitHub scope requirements:** Autopilot's PR creation requires a GitHub PAT with `repo` scope (write access to the target repository). For our workflow this is fine, but worth noting for private repos.
- **v2.5.1 is marked stable but still has 8 open issues** — some around session management and gateway sync. Community bug-fix PRs are landing but this is not hardened SaaS.

---

## Comparison to Current Sindustries Process

| Dimension | Sindustries (current) | crshdn/mission-control (Autensa) |
|-----------|----------------------|----------------------------------|
| Task entry | Manual via Tasks API / tasks app | Manual task dispatch OR autonomous via Product Autopilot |
| Agent dispatch | Python skills + Lobster pipeline | WebSocket dispatch via OpenClaw gateway (native) |
| Agent tracking | tasks-api (Postgres + Prisma) | SQLite (built-in, no Postgres required) |
| Orchestration | Single agent per bookmark/content task | Multi-agent (Builder→Tester→Reviewer→Learner), Convoy Mode |
| Cost visibility | None currently | Per-task, per-product, daily/monthly caps |
| Crash recovery | None | Checkpoint-based resume |
| PR creation | Manual / ad-hoc | Automated (Supervised / Semi-Auto / Full-Auto tiers) |
| Swipe/ideation | Not applicable | Full Tinder-style ideation pipeline |
| OpenClaw integration | Via Python client + session sends | Native WebSocket (purpose-built) |

**Key gap:** Sindustries currently has no cost tracking, no automated PR pipeline, and no multi-agent orchestration with crash recovery. Autensa provides all three.

**Key advantage (Sindustries):** Our Tasks API (Postgres + Prisma) is more robust for multi-agent coordination and external integration than Autensa's SQLite store. Our Lobster pipeline for bookmark ingestion has domain-specific logic that Autensa's generic autopilot wouldn't replicate without significant configuration.

---

## Recommendation: **Selective adoption — do NOT switch wholesale**

Autensa is not a replacement for the Sindustries task process. It's an autonomous product ideation engine with a task board bolted on. Our process (bookmark → review → spec → task → agent) is more intentional and domain-specific.

However, specific Autensa patterns are worth adopting:

1. **Cost tracking** — The per-task cost model is directly applicable. Adopt the pattern (token logging per dispatch) even if not adopting Autensa itself.
2. **Checkpoint/crash recovery** — Agents that resume from last checkpoint rather than restarting. Implement in our Lobster dispatch layer.
3. **Per-task OpenClaw session isolation** — Autensa v2.5.0 fixed "context accumulation across tasks" by giving each task its own session. We should verify our dispatch does the same.
4. **Convoy Mode concept** — Parallel multi-agent with dependency tracking is worth exploring once we have more than one active agent per task.

**If Tom wants a full autonomous product engine pointed at the Sindustries website/repo**, Autensa is the best available open-source option and would deploy cleanly on the Mac mini via Docker. That's a different use case to our current workflow tooling.

---

## Install Steps (for future Docker deploy on Mac mini)

```bash
# 1. Clone
git clone https://github.com/crshdn/mission-control.git
cd mission-control

# 2. Configure
cp .env.example .env
# Set in .env:
#   OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789
#   OPENCLAW_GATEWAY_TOKEN=$(cat ~/.openclaw/openclaw.json | jq -r '.gateway.token')
#   AUTOPILOT_MODEL=anthropic/claude-sonnet-4-6

# 3. Start
docker compose up -d --build

# 4. Open
open http://localhost:4000
```

Data persists in named Docker volumes. Upgrade: `docker compose pull && docker compose up -d`.

---

## Blockers for Tom to Resolve

None critical for evaluation — Docker deploy is straightforward. If pursuing Product Autopilot mode (autonomous PR creation), Tom would need to:
- Provide a GitHub PAT with `repo` scope for the target sindustries repo
- Decide automation tier (Supervised recommended for production repos)
