# Agent Operating Docs — Conventions

This directory is the source of truth for agent definitions. CI syncs these
tracked files into each agent's OpenClaw workspace; never treat a workspace-only
copy as canonical. Ash is a first-class definition alongside Ivy, Lox, Quinn,
Rowan, and Vara.

Each agent under `agents/definitions/<name>/` uses a consistent set of markdown files. When editing any of these files, keep the split clean — every file has one purpose. If a change doesn't fit an existing file's purpose, that's a signal it belongs elsewhere (or the file's purpose has drifted).

Every first-class agent directory, including `agents/definitions/ash/`, carries
`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `WORKFLOW.md`,
and `DoD.md` as appropriate to its runtime role.

## The files and what each is for

| File | Purpose | Edit when |
|---|---|---|
| `AGENTS.md` | **Not in this repo.** The canonical Sindustries OpenClaw operations manual lives in the workspace repo at `~/.openclaw/workspace/AGENTS.md` (Stoffer-Industries/workspace). `openclaw-edge`'s `sync-agent-definitions.sh` copies it into every other agent's workspace root on each sync pass — those are plain synced copies, not filesystem symlinks — so OpenClaw's per-workspace auto-inject picks up the shared content for every agent. | **Shared rules** → edit `~/.openclaw/workspace/AGENTS.md` (workspace repo, single source of truth). **Agent-only rules** → put in SOUL (voice/values), TOOLS (tool conventions), HEARTBEAT (cadence), or WORKFLOW (execution) in this repo. AGENTS.md is intentionally *not* per-agent — the file's purpose is workspace-wide OpenClaw ops, and anything agent-specific added there gets copied verbatim into every other agent's workspace, so it never belongs there. |
| `SOUL.md` | Voice, values, character. Who this agent *is*. | Character or voice shifts. Never for procedural rules. |
| `IDENTITY.md` | Name, avatar, immutable identity facts. | Rarely — identity is stable. |
| `USER.md` | Facts about the humans this agent serves. | New context about the user. |
| `TOOLS.md` | Local notes about tools, tokens, worktrees, host-specific config. | Environment or credentials change. **Sindustries git work always happens in a personal worktree** — never in the Edge-managed `codebases/sindustries` checkout (see each agent's WORKFLOW.md Worktrees section and workspace `AGENTS.md`). |
| `HEARTBEAT.md` | **When** the agent checks for work each pass, and **what triggers action**. Polling cadence + per-pass priority rules. | Cadence changes, new triggers, new per-pass campaigns. |
| `WORKFLOW.md` | **How** the agent executes work — task-state rules, PR standards, escalation triggers. The execution playbook. | Execution steps change, new task states, new PR conventions. |
| `DoD.md` | Definition of Done — quality bar for calling a task complete. | Quality bar changes. |

## The core split: HEARTBEAT vs WORKFLOW

The two files that most easily blur into each other. Keep them distinct:

- **`HEARTBEAT.md`** = the polling loop. What the agent looks for on each pass, what triggers action, and per-pass cadence rules (priority ordering, idempotence checks, when to skip a section). Does **not** restate how to execute — it points to WORKFLOW.md.
- **`WORKFLOW.md`** = the execution playbook. Per-state rules (ready / doing / acceptance), PR conventions, tech-design gates, escalation triggers, `.openclaw` boundaries, DoD-adjacent quality rules that shape the execution. Does **not** describe polling cadence — that's HEARTBEAT.md.

**Test:** if you're editing HEARTBEAT.md and adding "here's how to do X," the change belongs in WORKFLOW.md (or a skill). If you're editing WORKFLOW.md and adding "on each heartbeat pass, check Y first," it belongs in HEARTBEAT.md.

## When to move logic into a skill instead

A block belongs in `agents/skills/**/SKILL.md`, not in HEARTBEAT.md or WORKFLOW.md, when:

- More than one agent could reuse it, or
- The block is a self-contained primitive (single input → single output) with no per-agent framing, or
- The block is large enough that inlining it obscures the agent's per-state flow.

The agent doc then *references* the skill. The skill owns the how; the agent doc owns the when/why.

**Test:** if the same block would sensibly live under any other agent's `WORKFLOW.md`, extract it to a skill.

## When editing any of these files

1. Confirm the file's purpose (from the table above) matches the change.
2. If the change spans two files' purposes, split it — put each part in the right file.
3. If you're moving content out of a file, put a short pointer in the old location so readers landing there aren't lost.
4. Prefer `See <other-file>` over restating.
5. Add a "Scope of this file" line at the top of HEARTBEAT.md and WORKFLOW.md if it isn't already there — makes intent obvious to the next editor.

## Related

- `agents/skills/` — reusable primitives called by these agent docs.
- `agents/workflows/` — Rust-based lobster workflows that read agent output (`[ivy-prs]`, `[ivy-tweets-queued]`, `[tech-design]`, etc.) and drive task state.

## Where operational runbooks live

**Operational runbooks do not live in this repo.** As of PR #583 (2026-09-08) the prior `infra/runbooks/` (3 files) and `docs/runbooks/` (7 files) directories were deleted; operational runbooks now live in `~/.openclaw/workspace/docs/infra/runbooks/` (a workspace-local path that is **not** part of any repo).

`codebases/sindustries/` is the Edge-managed canonical checkout — its `main` branch is fast-forwarded to `origin/main` by the `openclaw-edge` webhook on every push, and a 5-minute launchd guard reverts any local drift. Runbooks (which are inherently host/operator-specific) have no business there: any local file in that checkout blocks the mirror or gets reset out from under you. Use the workspace path above instead.

Per Tom 2026-09-08: *"move all runbooks to workspace and dont put any more in sindustries going forward."*

When an agent doc references a runbook, point at the workspace path
(e.g. `~/.openclaw/workspace/docs/infra/runbooks/<name>.md`). When
updating an agent doc, treat any lingering `infra/runbooks/...` or
`docs/runbooks/...` link as a stale reference and remove or relocate it
in the same change.
