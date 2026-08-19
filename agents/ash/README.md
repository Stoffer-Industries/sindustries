# Ash — QA-Verifier Agent (placeholder code)

This directory holds the **pure-code** half of the Ash QA-verifier agent:
TypeScript that mechanically verifies a task's PR-body evidence tags
against the merged diff. The agent **identity** (session, model, GitHub
PAT, tasks-api token, Telegram account, heartbeat/cron wiring, identity
docs) lives outside this repo at `~/.openclaw/workspace/agents/ash/`
and is provisioned by **Quinn** per the `[openclaw-needed]` comment
on task `f6a4d56a`.

Until Quinn's provisioning lands, this code is a placeholder. The
lobster-side `qa_agent` gate enforcement (PR #2 of task f6a4d56a) and
the migrated enum value (PR #1) are both already in `main`; the gate
holds tasks in `doing` until either Ash (when wired) runs verify.ts
or a human posts the approval. The structural verification in this
file is what Ash will run.

## When this runs

Per `docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md` §9,
Ash's heartbeat (Quinn's cron, ~15 min cadence) discovers tasks in
`doing` with a merged PR whose `qa_agent` gate is outstanding and
invokes `verify.ts` against each one. Quinn's cron wires this up after
the agent identity is provisioned.

## CLI

```bash
# Required env vars (set by Quinn's provisioning):
export ASH_TASKS_API_APPROVAL_TOKEN=<Ash's per-agent token>
export ASH_GITHUB_TOKEN=<Ash's fine-grained PAT>

# Required CLI args:
npx tsx src/verify.ts \
  --task-id <uuid> \
  --tasks-api-base-url http://localhost:4001/api/v1 \
  --pr-url https://github.com/Stoffer-Industries/sindustries/pull/<n>
```

Exit codes: `0` = all checks pass, approval posted. `1` = at least one
AC failed, `[qa-agent-blocked]` comment posted. `2` = missing input or
env var.

## What it checks

Per AC3 of task `f6a4d56a`, the script verifies three things about the
PR-body AC evidence tags:

1. **(testID: {file_path})** — the cited test file must exist in the
   merged PR diff. (Dynamic test execution is a future enhancement —
   structural check is the highest-confidence signal we can do
   deterministically today.)
2. **(not tested: {file_path})** — the cited file must exist in the
   merged PR diff.
3. **(pr: {#N or url or file_path})** — sibling PR references are
   accepted by structure; file paths must exist in the diff.
4. **(not code: {reason})** — non-code ACs are accepted by structure.

On all checks pass, the script POSTs `/tasks/{id}/approvals` with
`{type: "qa_agent", owner: "Ash"}` to satisfy the gate. On any failure,
it POSTs a `[qa-agent-blocked]` comment naming the specific claim that
failed and does NOT satisfy the gate — the lobster holds the task in
`doing`.

## Tests

```bash
pnpm install   # one-time, installs vitest + tsx
pnpm test      # runs the three AC3 cases plus the happy-path / pre-conditions
```

The test fixtures cover the three AC3 cases called out in the tech
design:

- **Missing-test case** — `verify.test.ts` → `verify() — AC3 missing-test case`
- **Missing-artifact case** — `verify.test.ts` → `verify() — AC3 missing-artifact case`
- **Fabricated-evidence case** — `verify.test.ts` → `verify() — AC3 fabricated-evidence case`

Each case asserts that the outcome is `ok: false`, the comment text
begins with `[qa-agent-blocked]`, the failure reason names the specific
claim that failed, and `postApproval` was NOT called.

## Why this is in `agents/ash/` (not `services/`)

`agents/` is the canonical home for agent-shaped code in this repo.
When Quinn provisions Ash's identity at `~/.openclaw/workspace/agents/ash/`,
the `AGENTS.md` / `SOUL.md` / `WORKFLOW.md` / `HEARTBEAT.md` files
created there describe how the agent runs the script in this directory.
The .openclaw boundary stays separate from the code surface — the
script is in `codebases/sindustries`, the agent identity is in
`~/.openclaw/`.

## Related

- Tech design: `docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md`
- Task: `f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47`
- PR #1 (schema/migration): https://github.com/Stoffer-Industries/sindustries/pull/471
- PR #2 (lobster gate): https://github.com/Stoffer-Industries/sindustries/pull/474
- `[openclaw-needed]` bootstrap ask: task comment `acc27231`
