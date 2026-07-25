# Agent Operating Docs — Conventions

Each agent under `agents/definitions/<name>/` uses a consistent set of markdown files. When editing any of these files, keep the split clean — every file has one purpose. If a change doesn't fit an existing file's purpose, that's a signal it belongs elsewhere (or the file's purpose has drifted).

## The files and what each is for

| File | Purpose | Edit when |
|---|---|---|
| `AGENTS.md` | **Not in this repo.** The canonical Sindustries OpenClaw operations manual lives in the workspace repo at `~/.openclaw/workspace/AGENTS.md` (Stoffer-Industries/workspace). Each agent's workspace symlinks their AGENTS.md → workspace-root AGENTS.md, so OpenClaw's per-workspace auto-inject picks up the shared content for every agent. | **Shared rules** → edit `~/.openclaw/workspace/AGENTS.md` (workspace repo, single source of truth). **Agent-only rules** → put in SOUL (voice/values), TOOLS (tool conventions), HEARTBEAT (cadence), or WORKFLOW (execution) in this repo. AGENTS.md is intentionally *not* per-agent — the file's purpose is workspace-wide OpenClaw ops. |
| `SOUL.md` | Voice, values, character. Who this agent *is*. | Character or voice shifts. Never for procedural rules. |
| `IDENTITY.md` | Name, avatar, immutable identity facts. | Rarely — identity is stable. |
| `USER.md` | Facts about the humans this agent serves. | New context about the user. |
| `TOOLS.md` | Local notes about tools, tokens, worktrees, host-specific config. | Environment or credentials change. |
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
