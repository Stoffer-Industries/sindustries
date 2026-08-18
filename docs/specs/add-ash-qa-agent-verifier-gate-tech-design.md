---
status: draft
task_id: f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47
product_spec: n/a (internal tooling)
shipped_pr: null
shipped_date: null
---

# Add Ash: QA-Agent Verifier Gate Tech Design

## Links

- Task: `f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47` (`Add Ash: automated QA-verifier agent gate between doing and acceptance`)
- Task API: `http://localhost:4001/api/v1/tasks/f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47`
- Today's failure log (motivation): 2026-08-18 manual QA pass 6/12 — every failure mechanically verifiable but the lobster never reads the diff

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `add-ash-qa-agent-gate` (from `origin/main`)
- Worktree: `~/workspace/worktrees/add-ash-qa-agent-gate`
- Primary code surfaces:
  - `services/tasks-api/prisma/schema.prisma` (extend `ApprovalType` enum)
  - `services/tasks-api/prisma/migrations/<ts>_extend_approval_types/` (one migration)
  - `services/tasks-api/src/config/requiredApprovals.ts` (default mappings + owners)
  - `services/tasks-api/src/routes/tasks/_mapper.ts` (derive `workflowGates` from all outstanding approvals, not just one handoff)
  - `services/tasks-api/src/routes/tasks/_validation.ts` (validate new approval types at API boundary)
  - `services/tasks-api/src/routes/tasks.ts` (revocation / drift handling for renamed types)
  - `services/tasks-api/scripts/required-approvals-migrate.ts` (one-shot migration: rename `qa` → `accepted` for existing rows)
  - `agents/skills/ops/tasks-api/tasks_api_client.py` (extend `--type` choices)
  - `agents/workflows/feature-task/src/main.rs` (lobster gate transition logic)
  - `agents/workflows/feature-task/src/ac_parsing.rs` (extract evidence tags for the verification script)
  - `agents/workflows/feature-task/test/<...>.rs` (gate-transition tests, renamed-gate tests)
  - `agents/ash/src/verify.ts` (Ash verification script — Quinn registers the agent, Rowan writes the script under `agents/ash/` only as a placeholder until Quinn provisions the agent; see `.openclaw` boundary below)
  - `docs/systems/tasks-api.md` (update workflow-gates section to describe the two-gate model)

## Product intent (one-paragraph)

Today's lobster only checks PR-body shape (checkboxes ticked, evidence tag present, CI green). It never reads the codebase to confirm the claims are true. Today's manual QA pass (Tom) caught 6/12 — every failure was mechanically verifiable. We're introducing Ash, a Principal Quality Engineer agent, whose job is exactly that mechanical verification, and a new `qa_agent` workflow gate that the lobster requires satisfied before promoting a task from `doing → acceptance`. Tom's existing acceptance-stage sign-off becomes a separate `accepted` gate (renamed from today's `qa`), so the two checks (mechanical-by-agent vs human-by-Tom) are visibly distinct in the data model and the UI.

## Ownership boundary check

The natural source of truth for this change is **shared package / cross-app contract** — `services/tasks-api`'s `ApprovalType` enum + `TaskApproval` rows are already the structured-approval backbone (see `tasks-api-native-approvals-tech-design.md`), and the lobster already gates on `task_approval_granted(task, "qa")`. Adding a new gate by extending that same enum + wiring a new transition predicate is the durable boundary; introducing a separate "Ash gate" model would create a second source of truth for the same lifecycle concept.

Concretely:

- `ApprovalType` enum gets two new values (`qa_agent`, `accepted`) and the legacy `qa` value is removed via the same migration that renames existing rows.
- The lobster's `qa_ac_verified_structured` predicate (used for `done`-closure audit) is renamed `accepted_structured` and checks `task_approval_granted(task, "accepted")`.
- A new lobster predicate `qa_agent_verified` checks `task_approval_granted(task, "qa_agent")` and gates `doing → acceptance`.
- A new lobster step `create_qa_agent_gate` creates an outstanding `qa_agent` TaskApproval row idempotently when a task enters `doing` (or when its PR merges while in `doing`).
- `mapTask.workflowGates` is generalised from "one outstanding handoff" to "all outstanding approval-type rows for this task, joined with their configured owner" — this surfaces Ash's gate AND Tom's `accepted` gate simultaneously in the UI.

No interim shims. The migration runs once at deploy and renames rows atomically (no period where `qa` and `accepted` coexist).

## `.openclaw` boundary notes

AC5 explicitly delegates Ash's agent identity to Quinn: Rowan must **not** attempt to register Ash inside `~/.openclaw/` directly. Instead Rowan:

1. Writes a placeholder `agents/ash/` directory in the worktree containing only `verify.ts` (the verification script — pure code, no agent identity) and a `README.md` pointing at Quinn.
2. Posts an `[openclaw-needed]` task comment listing exactly what Quinn must apply at the workspace level (session identity, model pin, GitHub identity, TASKS_API approval token, heartbeat/cron wiring, IDENTITY.md with `creature: wolf` and `title: Principal Quality Engineer`).
3. The verification script is invoked by an external trigger (Quinn's heartbeat or a new cron) **after** the agent identity is provisioned. Rowan's PR can land without Ash running; the migration and lobster gate work without Ash; Ash's first satisfied gate happens on the next task that merges.

Rowan does **not** create the `.openclaw/agents/ash/` directory, does **not** add Ash to any agents config, does **not** create a `ROWAN`-equivalent `~/.config/gh-ash` directory, and does **not** rotate any per-agent token. Anything touching `~/.openclaw/` stays outside this PR.

## Implementation plan

### 1. Tasks API schema (`services/tasks-api/prisma/schema.prisma`)

Extend the existing `ApprovalType` enum:

```prisma
enum ApprovalType {
  spec
  tech_design
  qa_agent    // NEW — Ash's mechanical verification gate
  accepted    // RENAMED from qa — Tom's human sign-off at acceptance
  // qa (legacy) — REMOVED via migration; no default value remains
}
```

The legacy `qa` value is **removed** in the same migration that renames existing rows to `accepted`. No backwards-compatibility period (Postgres enum value drops are reversible via `ALTER TYPE ... ADD VALUE` if we ever need to roll back the migration — see Risks).

### 2. Migration (`services/tasks-api/prisma/migrations/<ts>_extend_approval_types_qa_agent_accepted/`)

Two-step migration in one `migration.sql`:

```sql
-- Step 1: extend the enum with the two new values BEFORE we rename rows
ALTER TYPE "ApprovalType" ADD VALUE 'qa_agent';
ALTER TYPE "ApprovalType" ADD VALUE 'accepted';

-- Step 2: rename existing rows from qa -> accepted
UPDATE "TaskApproval" SET type = 'accepted' WHERE type = 'qa';

-- Step 3: drop the legacy enum value (Postgres requires dropping the default if any)
ALTER TYPE "ApprovalType" DROP VALUE 'qa';
```

Preflight: `SELECT type, count(*) FROM "TaskApproval" GROUP BY type` before the migration; expect a non-empty `qa` bucket and empty `qa_agent` + `accepted` buckets. After: `qa_agent` empty, `accepted` equals old `qa` count, `qa` zero.

Document the rollback path in the migration's comment block: re-adding `'qa'` to the enum (Postgres 12+ supports `ALTER TYPE ... ADD VALUE`) plus an UPDATE in the opposite direction is sufficient; no destructive column drops.

### 3. Default config (`services/tasks-api/src/config/requiredApprovals.ts`)

- Extend `DEFAULT_APPROVAL_OWNERS`:
  ```ts
  spec: 'Tom',
  tech_design: 'Quinn',
  qa_agent: 'Ash',
  accepted: 'Tom',
  // qa removed
  ```
- Extend `DEFAULT_REQUIRED_APPROVALS.mappings`:
  ```ts
  feature: ['spec', 'tech_design', 'qa_agent', 'accepted'],
  code:    ['tech_design', 'qa_agent', 'accepted'],
  content: ['spec', 'qa_agent', 'accepted'],
  research: [],
  ```
- Update the `validApprovalTypes` set in `routes/tasks/_constants.ts` to match.

### 4. Mapper (`services/tasks-api/src/routes/tasks/_mapper.ts`)

Today `workflowGates` derives from the singular `task.workflowHandoffRoleId` field — only one outstanding gate is surfaced at a time. With two gates live per task, we generalise:

```ts
const workflowGates: Array<WorkflowGateSummary> = [];
for (const approvalType of requiredApprovalTypes) {
  const owner = gateOwnersByType[approvalType];
  const approved = task.approvals?.some(
    (a) => a.type === approvalType && a.state === 'approved' && !a.revokedAt
  );
  if (!approved) {
    workflowGates.push({
      roleId: `${approvalType}_gate`,       // e.g. qa_agent_gate, accepted_gate
      owner,
      gate: approvalType,                    // 'qa_agent' | 'accepted'
      reason: reasonByType[approvalType],    // static per-type string
      state: 'outstanding' as const,
    });
  }
}
```

This replaces the `workflowHandoffRoleId`-derived gate entirely. The `Task.workflowHandoffRoleId` / `workflowHandoffGate` / `workflowHandoffReason` columns stay (used internally by the lobster for current-attention handoff) but no longer drive the API response surface.

### 5. Tasks API route validation (`services/tasks-api/src/routes/tasks/_validation.ts`)

Extend `validApprovalTypes` check to `['spec', 'tech_design', 'qa_agent', 'accepted']`. Reject `'qa'` with `400 INVALID_APPROVAL_TYPE` (defensive — external callers shouldn't be sending it after migration, but the migration runs at deploy time so a stale caller could race).

### 6. Tasks API approval revocation drift handling (`services/tasks-api/src/routes/tasks.ts`)

The current spec-approval revocation path (`description !== undefined` branch) needs a parallel branch for `qa_agent` and `accepted`: if `description` changes and either of those approvals is already `approved`, revoke it. Reuse the same `taskApproval.update` shape; add the two new types to the drift check. This keeps the existing promise that "approval state tracks the thing it approves" without growing the code surface significantly.

### 7. Tasks API client (`agents/skills/ops/tasks-api/tasks_api_client.py`)

Update the `approve --type` argparse choices from `['spec', 'tech_design', 'qa']` to `['spec', 'tech_design', 'qa_agent', 'accepted']`. No other change.

### 8. Lobster changes (`agents/workflows/feature-task/src/main.rs`)

- **New predicate** `qa_agent_verified(task) -> bool`: returns `task_approval_granted(task, "qa_agent")`. Distinct from the existing `qa_ac_verified_structured` (which becomes `accepted_structured`).
- **Rename existing predicate** `qa_ac_verified_structured` → `accepted_structured` and have it check `task_approval_granted(task, "accepted")`. Update every call site. Three call sites confirmed by grep (lines 970, 1294, 4780/4802 in `main.rs`).
- **New gate-creation step** `create_qa_agent_gate_if_missing(task)`: idempotent `POST /tasks/{id}/approvals` with `{type: "qa_agent", owner: "Ash", state: "outstanding"}` — but since the API only persists approved/revoked states, instead use the structured `POST /tasks/{id}/approvals` with `{type: "qa_agent", owner: "Ash"}` (default state = approved) and immediately revoke it: `DELETE /tasks/{id}/approvals/qa_agent`. This leaves a `TaskApproval` row with `state: "revoked"` and `revokedAt` set, which the audit trail treats as "created outstanding, not yet approved" — same pattern the spec-approval revocation path already uses.
  - **Alternative (preferred):** extend the API to allow creating an `outstanding` `TaskApproval` row. The current enum only has `approved` and `revoked`; adding `outstanding` is one enum value + a one-line write path. This is cleaner — no revoked-as-proxy-for-outstanding hack. Surface this as a small extension to the tasks-api in the same PR. (If Quinn pushes back on the API surface change, fall back to the revoke-as-outstanding pattern; flag in PR description.)
- **Trigger point** for `create_qa_agent_gate_if_missing`: when the lobster observes a state transition to `doing` for this task, OR when it observes a merged PR for a task still in `doing`. The lobster already detects both — wire the gate-creation into the existing transition handling for `open → doing` and into the merge-detection path.
- **Transition gate**: `doing → acceptance` calls `transition_or_block(...)` already; add a precondition that `qa_agent_verified(task) == true`. If false, write a `[qa-agent-blocked]` comment (per AC3 — see step 9 for content) and return without transitioning. The existing fingerprint-dedup logic in `transition_or_block` is reused so we don't spam comments.
- **`accepted` gate creation**: when the lobster promotes a task to `acceptance`, call `create_accepted_gate_if_missing(task)` — same shape as `create_qa_agent_gate_if_missing` but with `type: "accepted"`. The API's `mapTask` will then surface this as an outstanding gate owned by Tom, blocking `done` until Tom approves.

### 9. Ash verification script (`agents/ash/src/verify.ts` + Ash agent runs it)

This script is pure code and lives in the worktree at `agents/ash/src/verify.ts`. It is NOT invoked by the lobster (the lobster only creates them and gates on them); it is invoked by Ash's heartbeat / cron after Quinn provisions Ash's agent identity.

Inputs (per task, supplied via CLI args):

- `--task-id <uuid>`
- `--tasks-api-base-url <url>` (defaults to `http://localhost:4001/api/v1`)
- `--task-author <Ash>` (the per-agent TASKS_API_APPROVAL_TOKEN env var name)
- `--pr-url <url>` (the merged PR for this task)

Algorithm:

1. Fetch the task via `GET /tasks/{id}` and the PR via GitHub REST `GET /repos/{owner}/{repo}/pulls/{n}`.
2. Parse the PR body for AC evidence tags using the existing `parse_evidence` regex from `agents/workflows/feature-task/src/ac_parsing.rs:118-122` (or its equivalent if the lobster exposes one as a library — check at impl time). For each `- [x] AC<N>: ... (testID|not tested|not code|pr: <value>)` pair, capture the type + value.
3. For each `(testID: <name>)`: spawn `pnpm test --filter <name>` (or equivalent `pnpm --filter <package> test -- <name>` based on `name` shape) inside the workspace and assert exit 0. Log the failure with the AC label, test name, and exit code.
4. For each `(not tested: <file-path>)`: assert the file exists at `<repo-root>/<path>` relative to the workspace. For each `(pr: <file-path>)`: same existence check + extract the cited lines from the merged diff (`gh pr diff <url>`) and assert the cited lines exist in the diff.
5. Cross-check: for each AC's evidence-text block, run a small LLM-style claim-vs-diff check (or a deterministic structural check — see Open Questions below).
6. On all checks pass: POST `/tasks/{id}/approvals` with `{type: "qa_agent", owner: "Ash"}` to satisfy the gate. Log `[qa-agent-verified] task=<id> pr=<url>`.
7. On any failure: POST `/tasks/{id}/comments` with `[qa-agent-blocked]\nAC<N>: <claim that failed>\n<reason>` and **do not** satisfy the gate. The lobster's transition gate will hold the task in `doing`.

Edge cases:

- No PR URL on the task → skip the verification, post `[qa-agent-blocked] No PR URL found in task.`, do not satisfy.
- PR not merged → skip, post `[qa-agent-blocked] PR <url> is not merged.`, do not satisfy.
- Auth failure on the API → post `[qa-agent-blocked] Tasks API auth failed: <err>` and exit non-zero. Do not satisfy.

### 10. End-to-end tests (AC1, AC2, AC3, AC4 testIDs)

- **AC1 testID (gate-transition test):** `agents/workflows/feature-task/test/qa_agent_gate.rs`
  - Case A: task in `doing` with no `qa_agent` approval row → lobster does NOT promote to `acceptance`; posts `[qa-agent-blocked]` with reason "qa_agent gate is outstanding".
  - Case B: task in `doing` with `qa_agent` approval `state: approved` → lobster promotes to `acceptance` and creates `accepted` approval row.
- **AC2 testID (renamed-gate test):** `services/tasks-api/test/approval-types.test.ts`
  - Migration test: pre-migration DB with `qa` rows; after migration runs, those rows are `accepted`, no `qa` rows exist, `qa_agent` enum value exists.
  - Default-config test: `DEFAULT_REQUIRED_APPROVALS.mappings.code` includes both `qa_agent` and `accepted`.
- **AC3 testID (verification script test):** `agents/ash/test/verify.test.ts`
  - Missing-test case: PR body cites `testID: tests/foo.test.ts — "passes when foo"`, but `tests/foo.test.ts` doesn't exist → script posts `[qa-agent-blocked]` naming the missing test file; does NOT POST the approval.
  - Missing-artifact case: PR body cites `pr: apps/tasks/src/newFeature.tsx — "introduces X"` but the file isn't in the diff → script posts `[qa-agent-blocked]` naming the missing artifact; does NOT POST the approval.
  - Fabricated-evidence case: PR body claims AC4 has a test at line 50 but the diff only adds a doc file → script posts `[qa-agent-blocked]` naming the fabricated claim; does NOT POST the approval.
- **AC4 testID (end-to-end test):** `agents/workflows/feature-task/test/end_to_end_qa_agent_gate.rs` or an integration test under `services/tasks-api/test/integration/`
  - Setup: a `doing` task with a merged PR whose ACs are all honestly evidenced.
  - Action: invoke the lobster's `doing → acceptance` transition once with no `qa_agent` approval (must hold), then invoke Ash's verify script (must POST the approval), then invoke the lobster's `doing → acceptance` transition again (must promote to `acceptance` and surface `accepted` as outstanding for Tom).
  - Assert: task ends in `acceptance`, `workflowGates` contains exactly one entry — `{gate: "accepted", owner: "Tom", state: "outstanding"}`.

### 11. `[openclaw-needed]` comment (AC5)

Posted in the **same heartbeat** as the `[tech-design]` comment — a separate comment so the lobster and Quinn's discovery surface both see the ask independently. Content:

```
[openclaw-needed]
Register Ash as a real OpenClaw agent. Same bootstrap pattern as Rowan (see `~/.openclaw/workspace/agents/rowan/`). Required:
1. Workspace directory `~/.openclaw/workspace/agents/ash/` with AGENTS.md, SOUL.md, IDENTITY.md (creature: wolf, title: Principal Quality Engineer), USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, WORKFLOW.md.
2. GitHub identity: a fine-grained PAT for Ash with `repo` + `workflow` scopes, stored in `~/.openclaw/.env` as `ASH_GITHUB_TOKEN`. New `~/.config/gh-ash` directory.
3. Tasks API per-agent token: `ASH_TASKS_API_APPROVAL_TOKEN` provisioned by Quinn and added to `services/tasks-api`'s `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` JSON list with `actor: "Ash"`.
4. Heartbeat / cron wiring: an Ash heartbeat session bound to a cron that wakes every N minutes (recommend 15) and runs the verification script against any `doing` task with a merged PR whose `qa_agent` gate is outstanding. Pick the cadence after observing one full sweep.
5. Telegram account `ash` registered under `channels.telegram.accounts.ash` so the agent can post task comments under its own identity.
6. IDENTITY.md avatar: a wolf avatar (openclaw-wolf.png or similar).

This PR does NOT register Ash — that's outside `codebases/sindustries`. The PR only adds the `agents/ash/src/verify.ts` script + tests; Ash's first satisfied gate happens after Quinn completes steps 1-6.
```

### 12. System docs (`docs/systems/tasks-api.md`)

Update the workflow-gates section to document the two-gate model:

- `qa_agent` gate: created when task enters `doing`, owned by Ash, satisfied by Ash's verification script.
- `accepted` gate: created when task enters `acceptance`, owned by Tom, satisfied by Tom's `[qa-ac-verified] true` comment + structured approval.
- Map `mapTask.workflowGates` to surface both gates simultaneously, not just one outstanding handoff.

Also document the Ash agent at a high level (link to the worktree's `agents/ash/src/verify.ts` source); cross-reference the `[openclaw-needed]` bootstrap.

## Data model changes

| Change | Surface | Risk |
|--------|---------|------|
| `ApprovalType` enum: +2 values (`qa_agent`, `accepted`), -1 value (`qa`) | `services/tasks-api/prisma/schema.prisma` | Enum value drops are reversible via `ALTER TYPE ADD VALUE` (Postgres 12+) — see Risks |
| `TaskApproval` rows with `type: 'qa'` → `type: 'accepted'` | Same migration as above | Data-only update, no row loss |
| `Task.workflowHandoffRoleId` / `workflowHandoffGate` / `workflowHandoffReason` columns retained but no longer drive `mapTask.workflowGates` | `services/tasks-api/src/routes/tasks/_mapper.ts` | Internal lobster handoff signal preserved; external API surface changes |
| New `ApprovalState.outstanding` (alternative approach to step 8) | `services/tasks-api/prisma/schema.prisma` | TBD — fallback if Quinn rejects the API change |
| `agents/ash/src/verify.ts` new file | new directory in repo | None — pure code, isolated |

## API contract changes

- `POST /api/v1/tasks/{id}/approvals` now accepts `type ∈ {spec, tech_design, qa_agent, accepted}`. Existing clients sending `qa` get `400 INVALID_APPROVAL_TYPE` after migration.
- `GET /api/v1/tasks/{id}` and `GET /api/v1/tasks` responses' `workflowGates[]` may contain **multiple entries** instead of at most one. Clients that assumed single-entry must handle the array shape (UI already iterates as a list per `apps/tasks/src/...` — verify at impl time, update if any code path assumes `workflowGates[0]`).
- `DELETE /api/v1/tasks/{id}/approvals/{type}` works for `qa_agent` and `accepted` exactly like the existing three types.

## Workflow / cron / skill changes

- **Lobster cron:** unchanged — the existing sweep picks up the new predicates without config change.
- **Ash cron (new, Quinn-owned):** a per-agent heartbeat for Ash that fires every ~15 minutes (TBD after observing one full sweep), invokes `agents/ash/src/verify.ts` against each `doing` task with a merged PR and outstanding `qa_agent` gate. **Quinn sets this up — Rowan only documents the required behaviour.**
- **Tech-design skill:** unchanged.
- **PR-process skill:** unchanged.

## Test plan / AC verification matrix

| AC | Test layer | Test file | Notes |
|----|-----------|-----------|-------|
| AC1 — `qa_agent` gate created on `doing`, gates `doing → acceptance` | unit (lobster) | `agents/workflows/feature-task/test/qa_agent_gate.rs` | Two cases: outstanding gate holds transition, approved gate allows it |
| AC2 — `accepted` gate fires when task enters `acceptance` | integration (tasks-api) | `services/tasks-api/test/approval-types.test.ts` | Migration assertion + default-config assertion |
| AC3 — Ash verification catches missing test, missing artifact, fabricated claim | unit (verify script) | `agents/ash/test/verify.test.ts` | Three cases, each asserts `[qa-agent-blocked]` comment posted and approval NOT posted |
| AC4 — Passing PR reaches `acceptance` with `qa_agent` satisfied and `accepted` outstanding | e2e (lobster + tasks-api) | `agents/workflows/feature-task/test/end_to_end_qa_agent_gate.rs` or `services/tasks-api/test/integration/` | Full task lifecycle |
| AC5 — `[openclaw-needed]` comment posted with Quinn's bootstrap steps | manual / heartbeat | verified at PR review time | One comment, exact format above |

## Open questions / risks

1. **Should `ApprovalState` grow an `outstanding` value, or use `revoked` as the proxy?** The revoke-as-outstanding pattern reuses existing code but is semantically odd (revoked implies someone approved-then-unapproved). Adding `outstanding` is one enum value + one write path. Recommendation: ask Quinn in the PR description which approach he prefers before merging. Default to the `outstanding` value approach unless Quinn objects in review.

2. **Evidence-text claim-vs-diff check** — the structural checks in step 9 (test exists, file exists, line in diff) are deterministic and high-confidence. The "evidence text cross-checked against the real diff for overstated or fabricated claims" AC is fuzzier. Implementation options:
   - (a) Deterministic structural check only — covers AC3(a) and AC3(b) reliably; AC3(c) is only checked if the cited line numbers / claims are testable structurally.
   - (b) LLM call to a cheap model — covers AC3(c) but introduces a per-gate cost and async timing.
   - (c) Hybrid — deterministic first, LLM fallback if structural checks pass but obvious gaps remain.
   - Recommendation: start with (a). AC3(c) is already partially covered by (a) (fabricated test names won't exist; fabricated file paths won't exist). If Tom's 6/12 review showed failures that pure structural checks would miss, escalate before expanding scope. Flag in PR description.

3. **Postgres enum value drop ordering** — `ALTER TYPE ... DROP VALUE 'qa'` requires that no rows reference the value. The migration does `UPDATE ... SET type = 'accepted' WHERE type = 'qa'` first, then drops. If the migration runs in a transaction and the UPDATE is slow on a large `TaskApproval` table, the lock duration matters. Estimated impact: at ~hundreds of rows, sub-second. If `TaskApproval` grows to thousands, consider running the UPDATE outside the migration as a one-shot data migration, then the enum drop in a second migration.

4. **`mapTask.workflowGates` callers** — need to confirm (at impl time) that no UI code assumes `workflowGates[0]`. The audit shows the existing `_mapper.ts` writes `workflowGates` as an array already, but UI components in `apps/tasks/src/` may destructure the first element. Audit before merge.

5. **Cron cadence for Ash** — 15 minutes is a guess. The first week will tell us. If Ash's heartbeat fires too often, we get duplicate `[qa-agent-verified]` comments; the lobster fingerprint dedup already suppresses that on the lobster side, but the tasks-api comment emission is unguarded. Verify at impl time.

6. **Quinn's `ASH_TASKS_API_APPROVAL_TOKEN` provisioning** — same pattern as `ROWAN_TASKS_API_APPROVAL_TOKEN` (see MEMORY.md 2026-08-15). Surface this in the `[openclaw-needed]` comment so Quinn knows the exact server-side credential list update required.

7. **Idempotency of `create_qa_agent_gate_if_missing`** — the lobster sweep may fire many times before Ash runs. Each invocation creates the gate row; the row should only exist once. Use an `upsert` pattern: try `GET /tasks/{id}/approvals/qa_agent` first; if 404, create and revoke (or create outstanding). Add a unit test.

## Rollback

- **Tasks API migration rollback:** re-add `'qa'` to the enum (`ALTER TYPE ... ADD VALUE 'qa'`), then `UPDATE "TaskApproval" SET type = 'qa' WHERE type = 'accepted'` for the originally-`qa` rows. Requires a way to identify "originally qa" rows — either snapshot before the migration or accept the broader revert (touches Tom-approved `accepted` rows too, which is acceptable if we're rolling back the entire feature).
- **Lobster rollback:** revert the `qa_agent_verified` predicate and `create_qa_agent_gate_if_missing` calls; the lobster falls back to checking only `accepted`, exactly like today.
- **Ash agent removal:** remove Ash's cron + workspace directory + per-agent tokens. The `qa_agent` TaskApproval rows become orphaned (no predicate checks them), but they're harmless until the next migration removes the enum value.

## Implementation order

1. Land the Tasks API migration + default config + mapper in a single PR (no behavioural change — only the data model + API surface). This is the smallest possible cut and lets Quinn review the enum + approval type changes in isolation.
2. Land the lobster predicate + transition gate + gate-creation steps in a second PR (behavioural change — tasks now require `qa_agent` to reach `acceptance`).
3. Quinn provisions Ash (out-of-band, per `[openclaw-needed]`).
4. Land Ash's verification script + tests in a third PR (no behavioural change until Quinn's cron is wired).
5. Quinn wires Ash's cron (out-of-band).
6. Ash's first satisfied gate happens organically on the next task that merges.