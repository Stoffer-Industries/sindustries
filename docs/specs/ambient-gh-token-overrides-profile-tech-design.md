---
status: draft
task_id: b0d1b42e-9fc3-40f4-86d1-af9125c6454f
product_spec: brain/tasks/specs/in-progress/ambient-gh-token-overrides-profile-2026-09-14.md
shipped_pr: null
shipped_date: null
---

# Ambient GITHUB_TOKEN Overriding Per-Agent GH Config — tech design

## Product spec link

- Product spec: `brain/tasks/specs/in-progress/ambient-gh-token-overrides-profile-2026-09-14.md`
- Runbook (existing operator guidance): `infra/runbooks/github-ambient-token-override.md`
- Pattern-slug: `ambient-gh-token-overrides-profile` (factory-retro score 15 — highest-impact pattern in the 2026-09-14 pass)

## Product intent summary

Every agent process on the Mac mini inherits a bare `GITHUB_TOKEN` from `~/.openclaw/.env` (Quinn's classic PAT). Per `gh` CLI precedence rules, `GH_TOKEN` / `GITHUB_TOKEN` env vars **always** win over a `GH_CONFIG_DIR`-scoped `hosts.yml` profile, regardless of which `GH_CONFIG_DIR` is prefixed on the command. So any agent other than Quinn/Lox who runs `GH_CONFIG_DIR=~/.config/gh-<agent> gh ...` silently authenticates as `quinnstoffer` unless they first unset the ambient vars.

5 occurrences already in 7 days, all Rowan, all needing close/reopen or explicit unset workaround. The PR #658 self-review rejection (2026-09-13) is the loudest case — `gh pr review --approve` returned the same actor as PR author.

The fix must:

1. Preserve Quinn/Lox's documented write-op convention (`GITHUB_TOKEN=$QUINN_GITHUB_TOKEN gh ...` is part of their `agents/lox/AGENTS.md` / `agents/quinn/AGENTS.md` guidance and depends on `GITHUB_TOKEN` being ambient for them).
2. Make every other agent's `gh` invocation authenticate as that agent's own identity without per-command unset workarounds.
3. Be observable enough that the structural test ("no new occurrences for 7 days") is enforceable.

## Task / branch / workstream

- Task ID: `b0d1b42e-9fc3-40f4-86d1-af9125c6454f`
- Title: 🔧 Fix Ambient GITHUB_TOKEN Overriding Per-Agent GH Config Precedence
- Branch: `b0d1b42e-ambient-gh-token-overrides`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/b0d1b42e-ambient-gh-token-overrides`
- Repository: `sindustries`
- Workstream: Rowan owns AC1, AC2, AC3.

## Why this design exists as a separate PR

The recurring bug has been documented in retro-notes 4 times (09-10, 09-12, 09-13, 09-14) without graduating to a tracked task. Each recurrence forced a per-agent `unset GITHUB_TOKEN GH_TOKEN` workaround that costs 3–12 min per occurrence and has a non-zero risk of forgetting the unset on an identity-sensitive command (PR create, review, merge, push). The structural precedence bug is multi-agent and gateway-adjacent; this design documents the chosen structural fix so it can be reviewed once and then referenced for future occurrences.

## `.openclaw` boundary notes

This design proposes a fix that lives **at the gateway/process-spawn boundary**, not purely inside `sindustries`. Specifically:

1. **Inside this repo (sindustries PR):** a shared shim helper at `agents/lib/gh-with-agent-token.sh` plus per-agent documentation touch-ups (HEARTBEAT.md / SOUL.md / TOOLS.md / WORKFLOW.md per agent).
2. **Outside this repo (OpenClaw gateway PR — separate workstream):** per-agent token scoping at session-spawn so the shim has the correct input env to work with.

The PR for this task delivers (1) and a coordination comment for (2); it does not require (2) to land before this PR can merge, because the shim gracefully falls back to the existing per-command unset workaround if the per-agent token env var is unset. Once (2) lands in the gateway, this PR's shim becomes the long-term structural answer; until then, the shim still works (it just falls back to the existing documented workaround).

Rowan cannot write to `~/.openclaw/`; any direct edit to `~/.openclaw/.env` or OpenClaw session-spawn helper is out of scope. Quinn owns the gateway config touch-up (separate task; Quinn-orchestrated).

## Ownership boundary check

**Natural source of truth:** the per-agent credential scoping that happens at agent session-spawn (OpenClaw gateway layer), with the runtime enforcement layer living in a shared shell shim that every agent uses to invoke `gh`.

**Why a shared shim, not per-agent duplication:** the precedence rule (`GH_TOKEN`/`GITHUB_TOKEN` env beats `GH_CONFIG_DIR`) is `gh` CLI behavior, not agent behavior. Each agent's TOOLS.md duplicating the workaround would re-introduce the same drift vector (one agent forgets to update). A single shim with a single test surface removes the per-agent drift risk and makes AC2 (no manual unset needed for any agent) achievable.

**Why not the alternative (gateway-level filtering alone):** the gateway filter only fixes `gh` invocations inside the gateway's own process tree. Heartbeats run `gh` from many places (exec tool calls, ad-hoc shell scripts in agent sessions, third-party helpers like `feature-task/run.py` and `bookmarks/run.py`). Each of those would need its own gateway-level handler, which doesn't compose. The shim composes because it lives at the `gh` call site itself.

**Why not "just delete `GITHUB_TOKEN` from `~/.openclaw/.env`":** explicit non-goal per the existing runbook. Quinn/Lox's documented write-op convention (`GITHUB_TOKEN=$QUINN_GITHUB_TOKEN gh ...`) depends on `GITHUB_TOKEN` being ambient for their sessions. Removing it breaks their established workflow in exchange for a clean agent identity.

## Chosen approach

### Surface 1 — shared shim: `agents/lib/gh-with-agent-token.sh`

A POSIX-shell function file sourced by each agent's session-init that wraps `gh` invocations. The shim:

1. Detects the agent from `AGENT_ID` (or `$AGENT`-style env var) — fallback to reading the calling process's argv[0] basename when AGENT_ID is unset.
2. Looks up the per-agent token via `<AGENT>_GITHUB_TOKEN` (uppercased). For `rowan`, that's `ROWAN_GITHUB_TOKEN`; for `ash`, `ASH_GITHUB_TOKEN`; etc.
3. Constructs the invocation as:

   ```sh
   env -u GITHUB_TOKEN -u GH_TOKEN \
       GH_CONFIG_DIR="$HOME/.config/gh-${AGENT_ID}" \
       GH_TOKEN="$AGENT_GITHUB_TOKEN" \
       command gh "$@"
   ```

   This guarantees: (a) bare `GITHUB_TOKEN` is unset for the child process, so the per-agent `GH_TOKEN` wins; (b) `GH_CONFIG_DIR` is correctly scoped to the agent; (c) `GH_TOKEN` is the agent's own token.
4. Exposes the shim as a shell function called `gh` (and `gh-with-agent-token` as an alias for direct invocation if a script needs to bypass the function).
5. Logs a one-line stderr warning if the agent identity cannot be resolved (so an unexpected ambient `GITHUB_TOKEN` override is observable — backs AC3 observability).

### Surface 2 — per-agent documentation touch-ups

Each agent's `HEARTBEAT.md` / `WORKFLOW.md` / `TOOLS.md` / `AGENTS.md` (where the agent currently documents `GH_CONFIG_DIR=~/.config/gh-<agent> gh ...` usage) gets a short note: "Use `gh` (the shim). Do not invoke `command gh` or `env … gh` directly — the shim is the only correct path." Agents that already work correctly (Quinn, Lox) get an explicit note: "The shim intentionally treats `GITHUB_TOKEN` as authoritative for `quinn` and `lox` — no behavior change for you."

This is a docs-only change in each agent's workspace. The shim is the behavioral change; the docs ensure every agent picks up the new behavior uniformly.

### Surface 3 — coordination comment for the OpenClaw gateway fix

A single coordination comment on this task (and on the brain spec) noting that the **structural** fix is the gateway exposing per-agent tokens as `GH_TOKEN_<AGENT_ID>` scoped only to that agent's own session/process. Until the gateway change lands, the shim's per-agent token lookup degrades gracefully — it falls back to `command gh` after unset (the documented manual workaround). This makes the PR mergeable independently and gives the gateway team a clear target.

## Surface 4 — implementation PRs and split

- **PR 1 (this task, in scope):** shim + per-agent docs. Tests for the shim. Coordination comment. AC1 demonstrable via the new `gh` shim path; AC2 demonstrable via the test suite; AC3 demonstrable by 7-day retro-notes observation post-merge.
- **PR 2 (separate workstream, out of scope for this task but tracked in a Quinn-orchestrated follow-up):** OpenClaw gateway exposes per-agent tokens as `GH_TOKEN_<AGENT_ID>` scoped only to that agent's own session/process. The shim's lookup picks this up automatically when present; the fallback path remains for agents whose gateway hasn't yet rolled out.

## Data model / API contract changes

None. No Tasks API schema changes. No GitHub API contract changes. No new env vars are introduced inside `sindustries`; the shim reads existing per-agent `*_GITHUB_TOKEN` env vars that are already part of the env contract.

## Workflow, cron, and skill changes

- Each agent's session-init now sources `agents/lib/gh-with-agent-token.sh` before any `gh` invocations. Documented in `AGENTS.md` per agent.
- No cron changes; crons that run `gh` go through the same session-init so they pick up the shim transparently.
- No new AgentSkill is added; the shim is a runtime helper, not a skill.

## Test plan

### AC-by-AC verification matrix

| AC | Verification | Test layer | Notes |
|----|--------------|-----------|-------|
| AC1 — `gh pr create`/`gh pr review` authenticates as the agent's own identity without manual unset | Run `GH_CONFIG_DIR=~/.config/gh-rowan gh api user --jq .login` from the shim in a fresh Rowan session — must return `rowanstoffer`, not `quinnstoffer`. Repeat for `ash` / `ivy` (when their per-agent tokens are present). | Unit + manual E2E | Unit test shells out to `env -i` with the same env as a fresh agent session; manual E2E in a real Rowan heartbeat confirms no regression. |
| AC2 — ambient `GITHUB_TOKEN` no longer silently overrides `GH_CONFIG_DIR`-based identity | Run `GITHUB_TOKEN=ghp_fake_quinn GH_CONFIG_DIR=~/.config/gh-rowan gh api user --jq .login` from the shim — must return `rowanstoffer`, NOT `quinnstoffer`. Verifies the shim unsets the bare var. | Unit | Negative test: same command without the shim returns `quinnstoffer` (documented current behavior). |
| AC3 — no new `ambient-gh-token-overrides-profile` retro-notes pattern for 7 days post-fix | Retro-notes scan on day +8 must report zero new occurrences of the slug. Existing occurrences (5 documented) are not counted. | Retro-notes observation | Cannot be unit-tested; observational AC gated on PR merge + 7-day window. The runbook update in Surface 2 makes the slug greppable in `brain/ops/retro-notes/`. |

### Test layer fallback rationale

AC3 cannot be unit-tested because it is observational (a 7-day window). The slug is the durable test signal: if anyone writes a fresh retro-note with that pattern, the slug will appear in `brain/ops/retro-notes/<date>.md` and the existing `factory-retro` weekly scan will pick it up. This is consistent with how the recurring pattern was first detected.

## Open questions / risks

1. **Quinn/Lox session identity.** The shim must not regress Quinn's or Lox's existing write-op convention. Risk: if `AGENT_ID` detection is wrong for a Quinn or Lox session, the shim could unset their authoritative `GITHUB_TOKEN`. Mitigation: the shim has an explicit allow-list (`rowan`, `ash`, `ivy` etc.); Quinn and Lox are NOT in the allow-list and the shim passes through to `command gh` unchanged for them. This makes the shim behavior a no-op for Quinn/Lox and a behavior change only for the agents who actually have the bug.

2. **Cron jobs and external scripts.** Crons that run `gh` inherit whatever env was set when the cron was spawned. The shim only helps if the cron inherits `AGENT_ID` and `*_GITHUB_TOKEN`. Risk: a cron spawned without the agent's identity env vars falls back to the existing manual unset pattern. Mitigation: the runbook update explicitly tells cron authors to source `agents/lib/gh-with-agent-token.sh` before any `gh` invocation. Existing crons are out of scope for this PR; a follow-up coordination comment flags them.

3. **Test coverage of the shim itself.** Shell shims are notoriously hard to unit-test. Risk: a bug in the shim (e.g., a quoting issue with `env -u …`) defeats the whole purpose. Mitigation: the unit tests use `env -i PATH=/usr/bin:/bin /path/to/gh-with-agent-token.sh gh api user --jq .login` in a fully isolated env, and assert on the exit code + stdout. Three test cases: (a) agent identity resolves correctly; (b) bare `GITHUB_TOKEN` is unset; (c) Quinn/Lox fall through unchanged.

4. **Coordination with the gateway team.** The structural fix is in OpenClaw (separate repo, separate PR, Quinn-orchestrated). This PR doesn't depend on that, but AC3's 7-day window is only meaningful once the gateway fix lands — otherwise the shim's fallback path (existing unset) is what runs and the slug would still appear whenever an agent forgets the unset. Mitigation: AC3 is gated on both PRs landing + 7 days; the shim PR can land independently and the gateway PR is tracked as a follow-up coordination task.

5. **`feature-task/run.py` and `bookmarks/run.py`.** These already do `_load_dotenv_token('QUINN_GITHUB_TOKEN')` and export `GH_TOKEN` for their internal `gh` calls. Risk: the shim interacts oddly with these scripts if they re-export `GH_TOKEN` after the shim unsets `GITHUB_TOKEN`. Mitigation: the shim is invoked from the agent's session-init, which runs before any helper script; the helper scripts' explicit `GH_TOKEN` export then takes precedence inside their own process tree. Verified by reading the existing scripts; no behavior change expected.

## Implementation plan

1. Author the shim at `agents/lib/gh-with-agent-token.sh` with a 4–6 line header comment that names the problem and the runbook.
2. Add unit tests at `agents/lib/tests/test_gh_with_agent_token.sh` (or `tests/test_gh_with_agent_token.sh` if a non-`agents/lib` location is preferred — match existing convention).
3. Update `agents/rowan/HEARTBEAT.md`, `agents/ash/HEARTBEAT.md`, `agents/ivy/HEARTBEAT.md` with the shim usage note (3 lines each).
4. Update `agents/quinn/HEARTBEAT.md`, `agents/lox/HEARTBEAT.md` with the no-op-for-Quinn/Lox note (2 lines each).
5. Update the existing runbook `infra/runbooks/github-ambient-token-override.md` to mark the structural fix as in-progress (PR #TBD) with the shim as the interim workaround.
6. Post `[tech-design] <branch blob URL>` on task `b0d1b42e-9fc3-40f4-86d1-af9125c6454f` as the deliverable from this design doc.
7. Wait for Quinn's structured `tech_design` approval before any code merges.

## Why not `[tech-design-not-required]` waiver

The fix is structural (touches agent session-init, gateway coordination, cross-agent docs) and has two design decisions to make (shim location; Quinn/Lox allow-list behavior). A waiver would skip both. The design is small (~this doc) and reviewable in under 5 min, so the cost of the design round-trip is low and the value of explicit Quinn sign-off is high given the cross-agent blast radius.

## Related

- `brain/tasks/specs/in-progress/ambient-gh-token-overrides-profile-2026-09-14.md` — product spec (Tom-approved)
- `infra/runbooks/github-ambient-token-override.md` — existing operator guidance
- `brain/ops/retro-notes/2026-09-08.md`, `2026-09-10.md`, `2026-09-12.md`, `2026-09-13.md`, `2026-09-14.md` — full occurrence history
- PRs #584/585, #602/616/617, #645-654, #650/651, #658 — affected PRs across all 5 occurrences
