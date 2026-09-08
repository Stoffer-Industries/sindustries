# Ash — QA-Verifier Agent (utility module)

This directory holds the **utility** half of the Ash QA-verifier agent:
TypeScript helpers that Ash's reasoning loop imports for context loading.
The agent **identity** (session, model, GitHub PAT, tasks-api token,
Telegram account, heartbeat/cron wiring, identity docs) lives outside
this repo at `~/.openclaw/workspace/agents/ash/` and is provisioned by
Quinn per the bootstrap pattern used for Rowan.

The lobster-side `qa_agent` gate enforcement (task `f6a4d56a`) and the
migrated enum value are both already in `main`; the gate holds tasks in
`doing` until Ash (when wired) runs her reasoning loop or a human posts
the approval.

## Scope (after task 0b16dc37)

This file is **utility-only**. The bespoke `defaultJudgeIntent` placeholder
that lived here until 2026-09-08 has been removed; Ash's judgment now
runs through her own reasoning loop (see
`agents/definitions/ash/{HEARTBEAT,WORKFLOW}.md`), not through a CLI
invocation of this file. Three exports remain:

- `extractAcLines(prBody)` — walks `- [x] AC<N>: <text>` lines and strips
  trailing `(testID|not tested|not code|pr: <value>)` evidence annotations
  so the bare AC description reaches Ash's reasoning prompt without
  test-ID noise. Mirrors the lobster's canonical AC parser at
  `agents/workflows/feature-task/src/ac_parsing.rs:127`.
- `stripTrailingEvidence(text)` — same regex as above, exposed standalone
  for callers that need to strip evidence from a PR description without
  walking ACs.
- `fetchPrSummary(prUrl, token)` — fetches the PR body, file list, and
  raw patch via the GitHub REST API. Ash's reasoning tools consume this
  via the agent's own `read` / `exec` calls; the file does not embed the
  patch in an LLM prompt.

The mechanical surface (cited-file existence, cited-test pass/fail,
evidence-text matching against the PR diff) lives in the lobster's
`mechanical_evidence_failures` function at
`agents/workflows/feature-task/src/ac_parsing.rs:331` and runs as part
of the `doing → acceptance` gate **before** Ash's `qa_agent` approval is
requested. If the lobster's mechanical gate is failing on your task,
the `[feature-task-progress-checklist]` comment on the task already
tells you exactly what to fix — Ash will only see tasks where the
mechanical gate has already passed.

## Why this is in `agents/ash/` (not `services/`)

`agents/` is the canonical home for agent-shaped code in this repo.
When Quinn provisions Ash's identity at `~/.openclaw/workspace/agents/ash/`,
the `AGENTS.md` / `SOUL.md` / `WORKFLOW.md` / `HEARTBEAT.md` files
created there describe how Ash's reasoning loop uses this module. The
.openclaw boundary stays separate from the code surface — the
utilities are in `codebases/sindustries`, the agent identity is in
`~/.openclaw/`.

## When this runs

Per the prompt-driven verification design (`docs/specs/ash-prompt-driven-verifier-tech-design.md`),
Ash's reasoning loop runs as part of her heartbeat session — not via a
CLI invocation. The agent's own tool calls read the PR diff + cited
tests + cited files, and reach a `verified` / `blocked` / `deferred`
verdict per AC. On `verified` for all ACs, she posts the structured
`qa_agent` approval via the Tasks API. On any `blocked` AC she posts
`[qa-agent-blocked]` and routes back to the delivery assignee. On a
`deferred` AC (capability gap) she posts `[qa-agent-deferred]` and
continues; the structured approval still posts if the remaining ACs
are clean. If the same capability gap recurs across two distinct
tasks, Ash proposes a follow-up feature task on the second strike.

## Tests

```bash
npm ci          # one-time, installs vitest + tsx
npm test        # runs the utility tests + the judgment-pattern doc-test
```

The two test surfaces cover:

- **`test/verify.test.ts`** — unit tests for the surviving utilities:
  AC-line extraction (regex shape, evidence stripping, unchecked-AC
  skip, empty-input), `stripTrailingEvidence` (with/without annotations),
  and `fetchPrSummary` (token presence, three-endpoint fetch, URL
  parsing).
- **`test/judgment-pattern.test.ts`** — doc-test asserting that
  `agents/definitions/ash/{HEARTBEAT,WORKFLOW,SOUL,DoD}.md` describe
  the reasoning loop, the `[qa-agent-deferred]` convention, the
  two-strike rule, and that `verify.ts` no longer exports any bespoke
  judgment code (`defaultJudgeIntent`, `verifySemantic`, `runCli`,
  `judgeIntent`).

These tests do not exercise Ash's judgment itself — judgment is an
LLM property, not a code property, and runs through the agent's own
reasoning loop outside this module.

## Related

- Tech design: `docs/specs/ash-prompt-driven-verifier-tech-design.md`
- Lobster-side mechanical-evidence gate: `agents/workflows/feature-task/src/ac_parsing.rs:331`
- Lobster-side `verify_delivery` wiring: `agents/workflows/feature-task/src/main.rs:737`
- Task: `0b16dc37-cc81-483a-a30a-893884aef6f1` (this PR's scope)
- Sibling task: `f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47` (Ash gate design + provisioning)
