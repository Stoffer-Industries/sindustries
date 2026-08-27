# Ash — QA-Verifier Agent (semantic judgment)

This directory holds the **pure-code** half of the Ash QA-verifier agent:
TypeScript that **semantically** judges whether a task's PR diff actually
satisfies the AC's intent — not whether the cited evidence exists or
the cited test passes. The agent **identity** (session, model, GitHub
PAT, tasks-api token, Telegram account, heartbeat/cron wiring, identity
docs) lives outside this repo at `~/.openclaw/workspace/agents/ash/`
and is provisioned by **Quinn** per the `[openclaw-needed]` comment
on task `f6a4d56a`.

Until Quinn's provisioning lands, this code is a placeholder. The
lobster-side `qa_agent` gate enforcement (PR #2 of task f6a4d56a) and
the migrated enum value (PR #1) are both already in `main`; the gate
holds tasks in `doing` until either Ash (when wired) runs verify.ts
or a human posts the approval.

## Scope (after PR #3 of task 5e35dc25)

This file is **semantic-only**. The mechanical checks (cited-file
existence, cited-test pass/fail, evidence-text matching against the PR
diff) now live in the lobster's `mechanical_evidence_failures` function
at `agents/workflows/feature-task/src/ac_parsing.rs:331` and run as
part of the `doing → acceptance` gate **before** the `qa_agent` row is
created. Ash's qa_agent approval is only requested after the lobster's
mechanical gate has passed, and is scoped to judging whether the diff
actually satisfies the AC's intent — not whether the cited file
exists or the cited test passes.

If the lobster's mechanical gate is failing on your task, the
`[feature-task-progress-checklist]` comment on the task already tells
you exactly what to fix — you don't need Ash to run for deterministic
feedback.

The recommended shape for Quinn's eventual semantic implementation
is an LLM call against the AC's bare description + the PR's patch
text with a strict `{ ok: true } | { ok: false; reason: string }` JSON
response, deterministically reproducible by setting `temperature=0`
and recording the model + prompt version. Alternative deterministic
approaches (e.g. extracted function/class symbols compared against AC
claim keywords) are acceptable when LLM budget is a concern.

Until Quinn's implementation is wired, the `defaultJudgeIntent`
placeholder returns `ok: false` for every AC so the task stays in
`doing` rather than reaching acceptance on a stub.

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

Exit codes: `0` = all ACs pass judgment, approval posted. `1` = at
least one AC failed, `[qa-agent-blocked]` comment posted. `2` = missing
input or env var.

## What it checks

Per the consolidated design in
`docs/specs/migrate-ash-mechanical-checks-tech-design.md` step 4, the
script walks each AC line in the PR body and calls `judgeIntent(ac,
patch)` for each one. The judgment function returns
`{ ok: true } | { ok: false; reason: string }`. On all ACs passing, the
script POSTs `/tasks/{id}/approvals` with `{type: "qa_agent"}` to
satisfy the gate. On any failure, it POSTs a `[qa-agent-blocked]`
comment naming the failing AC and its reason and does NOT satisfy the
gate — the lobster holds the task in `doing`.

The mechanical surface (file existence, test pass, evidence-text
match) is **not** checked here. Those checks are delegated to the
lobster's `mechanical_evidence_failures` and run before this file is
invoked.

## Tests

```bash
npm ci          # one-time, installs vitest + tsx
npm test        # runs the semantic-contract pin tests
```

The test fixtures pin the comment-shape contract that the lobster and
Tom's QA verdict both rely on:

- **All-pass case** — `verifySemantic` returns `ok: true`, posts
  `[qa-agent-verified]`, and calls `postApproval`. Uses a fake
  `judgeIntent` that returns `{ok: true}`.
- **One-fail case** — `verifySemantic` returns `ok: false`, posts
  `[qa-agent-blocked]` naming the failing AC and its reason, and does
  NOT call `postApproval`. Uses a fake `judgeIntent` that returns
  `{ok: false, reason: "..."}` for AC2.
- **Pre-conditions** — no PR URL, not-merged PR, and no-AC-tags cases
  each return `ok: false` with the right `[qa-agent-blocked]` reason
  and no approval.
- **Prompt shape** — `judgeIntent` is called with the bare AC
  description (trailing evidence annotation stripped) and the PR's
  patch text.

These tests do not depend on Quinn's real judgment implementation —
the fake `judgeIntent` returns a deterministic verdict. When Quinn
lands the real impl, the fake in the test stays as the
"happy-path" / "one-fail" coverage and Quinn's wiring is exercised
through the CLI integration path.

## Why this is in `agents/ash/` (not `services/`)

`agents/` is the canonical home for agent-shaped code in this repo.
When Quinn provisions Ash's identity at `~/.openclaw/workspace/agents/ash/`,
the `AGENTS.md` / `SOUL.md` / `WORKFLOW.md` / `HEARTBEAT.md` files
created there describe how the agent runs the script in this directory.
The .openclaw boundary stays separate from the code surface — the
script is in `codebases/sindustries`, the agent identity is in
`~/.openclaw/`.

## Related

- Tech design: `docs/specs/migrate-ash-mechanical-checks-tech-design.md`
- Lobster-side mechanical-evidence gate: `agents/workflows/feature-task/src/ac_parsing.rs:331`
- Lobster-side `verify_delivery` wiring: `agents/workflows/feature-task/src/main.rs:737`
- Task: `5e35dc25-aed5-4064-8f11-a99413d18612` (this PR's scope)
- Sibling task: `f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47` (Ash gate design + provisioning)
- `[openclaw-needed]` bootstrap ask: task comment `acc27231`
