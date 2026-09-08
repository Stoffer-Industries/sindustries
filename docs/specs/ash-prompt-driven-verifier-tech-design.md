# Tech Design — Ash: prompt-driven agent verification, no text-comparison code (task 0b16dc37)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/0b16dc37-cc81-483a-a30a-893884aef6f1 (full UUID on Tasks API)
**Branch:** `0b16dc37-ash-prompt-driven-verifier` (off `origin/main`)
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-08

---

## Problem

`agents/ash/src/verify.ts` is the only place in the system where Ash's `qa_agent` gate can produce structured approvals today. Two things live in that file:

1. **Mechanical-evidence utilities** — `extractAcLines()`, `stripTrailingEvidence()`, the PR fetcher (`defaultFetchPr`). These are pure helpers that surface PR diff + AC text for downstream judgment.
2. **A bespoke judge function** — `defaultJudgeIntent(ac, patch)` returning `Promise<JudgeIntentResult>`. As of today it is a placeholder returning `{ ok: false, reason: "semantic judgment not yet implemented (Quinn owns)..." }` on every AC. Quinn's PR #572 (deterministic v1 token-overlap heuristic, 2026-09-05) was rejected by Tom on 2026-09-08 because it reintroduces mechanical text/token matching inside Ash — exactly the pattern task `5e35dc25` (acceptance, PR #502 merged) just moved out of Ash and into the lobster's `mechanical_evidence_failures` function.

The combination blocks every task that needs Ash's qa_agent approval. The current Ash heartbeat pass (per `~/.openclaw/workspace/agents/ash/memory/2026-09-08.md` at 14:11, 19:36, 20:30, 21:21 NZT) works around the block by patching `attentionOwners` back to the delivery assignee and posting a precise blocker comment, but it never satisfies the gate — so those tasks stay in `doing` until something else moves them.

Tom's direction (per task description, 2026-09-08): "this needs no bespoke judging code at all. Ash should operate as a normal agent — surfaced her own gate-owner tasks from the task queue the same way Rowan/Lox pick up assigned work — and use her own reasoning/tool calls (reading the diff, running cited tests, reading code) to judge whether an AC is actually operational, rather than being invoked through a narrow CLI function with a custom judge implementation."

`agents/definitions/ash/{HEARTBEAT,WORKFLOW,SOUL}.md` already describe Ash as a first-class OpenClaw agent with her own heartbeat, queue, and tool environment; the agent *identity* is in place, the *judgment mechanism* is the gap.

## Goals (and non-goals)

**In scope**
- Strip the bespoke judge code out of `agents/ash/src/verify.ts`. Delete `defaultJudgeIntent`, the `judgeIntent` parameter on `Deps`, the `judgeIntent` invocation in `verifySemantic`, and the CLI entry (`runCli`, `import.meta.url === file://argv[1]` branch, env-var wiring). What remains is a small utility module (`extractAcLines`, `stripTrailingEvidence`, a `fetchPrSummary` helper) that Ash's agent loop imports for context loading.
- Replace the CLI invocation pattern with an in-agent reasoning loop: Ash's `HEARTBEAT.md` step 3 (currently: "run verify.ts via Quinn's cron") becomes "use the agent's own tool calls to read the PR diff, the cited tests, and the cited files, then reason over the AC's bare description against the evidence." Ash already has `read`, `exec`, `web_fetch`, and `gh api` available via her existing agent wiring.
- Define an explicit `[qa-agent-deferred]` task-comment convention for capability gaps. When an AC requires a capability Ash lacks (e.g. exercising a deployed app, browser control, manual production smoke), Ash posts a deferred report listing exactly which ACs were verified vs deferred, the reason per deferral, and a link to the feature spec describing the capability that would close the gap. She does not block `qa_agent` approval on a capability gap.
- Add a discoverable capability-gap tracking mechanism. Ash can post a follow-up task (or update an existing one) when she sees the same gap twice across different tasks; the goal is that capability gaps become first-class work items over time rather than silently recurring deferrals.
- Update `agents/definitions/ash/{HEARTBEAT.md, WORKFLOW.md, SOUL.md}` so the reasoning-and-deferral pattern is the canonical answer (prompts/SOUL/WORKFLOW, not code). The `DoD.md` already covers the structured-approval + routing semantics; this design changes only the judgment surface.
- Tests: keep `agents/ash/test/verify.test.ts` covering the surviving utilities (regex extraction, trailing-evidence stripping, PR fetch stub). Add a new `agents/ash/test/judgment-pattern.test.ts` that documents the reasoning/deferral pattern as code-adjacent guidance (comment + example walk-through), not as testable behavior — judgment is an LLM property, not a code property.

**Out of scope**
- Reintroducing any code-based text/token matching inside Ash. PR #572's direction is explicitly rejected; do not propose a v2 heuristic.
- The lobster's pre-`qa_agent` mechanical-evidence gate (`agents/workflows/feature-task/src/ac_parsing.rs:331`, `mechanical_evidence_failures`). Already shipped via task `5e35dc25` PR #502 (in `acceptance`); this design is a downstream consumer only.
- LLM-call budget controls / per-AC token accounting. Out of scope; Ash's existing agent runtime already records token usage, and the `[qa-agent-deferred]` convention lets Tom cap scope manually if budget becomes a concern.
- Replacing Ash's task-queue-driven discovery (`agent_task_queue.py --assignee Ash --json`). The current discovery pattern is correct; only the judgment step changes.
- Renaming or removing `ASH_TASKS_API_APPROVAL_TOKEN` / `ASH_GITHUB_TOKEN` env vars. The PR fetch utility still uses `ASH_GITHUB_TOKEN`, and the structured `qa_agent` approval still uses Ash's tasks-api credential — both stay. (Tom's note in `agents/ash/README.md` about Quinn provisioning these remains accurate.)
- Quinn's `[openclaw-needed]` provisioning comment on task `f6a4d56a` for agent identity bootstrap. Already provisioned for the agent identity; this design only changes judgment wiring, not credentials.

## Source-of-truth docs

- `agents/ash/src/verify.ts` — strip judge code; keep utility functions.
- `agents/ash/test/verify.test.ts` — keep tests for surviving utilities.
- `agents/definitions/ash/HEARTBEAT.md` — step 3 becomes "reasoning loop + deferred-report path", not "run CLI".
- `agents/definitions/ash/WORKFLOW.md` — remove "run the verifier in `agents/ash/src/verify.ts`" step; replace with the reasoning loop description.
- `agents/definitions/ash/SOUL.md` — keep role framing (Principal Quality Engineer) but add the "judge intent via reasoning, defer on capability gap" line explicitly.
- `agents/definitions/ash/DoD.md` — add a bullet covering capability-gap deferral reporting.
- `docs/specs/migrate-ash-mechanical-checks-tech-design.md` — pre-existing design for task `5e35dc25`; this design is the second half of that split.
- `docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md` — original verifier-gate design; references `verify.ts` as the verifier, which this design supersedes for the judgment surface only.
- `.openclaw` boundary: Ash's agent identity lives at `~/.openclaw/workspace/agents/ash/`. No new files there; only `~/.openclaw/workspace/agents/ash/HEARTBEAT.md` is updated, and it stays inside the agent's own runtime directory (no sync back into `codebases/sindustries/agents/definitions/ash/`).

## Architecture / approach

The change has two layers — code (the utility-only refactor) and prompts/orchestration (the reasoning-and-deferral pattern). They land together in one PR.

### Layer 1 — `agents/ash/src/verify.ts` becomes a utility module

After the refactor, the file's public surface is three exports:

```ts
// AC line extraction — same regex as the lobster's evidence parser
// (agents/workflows/feature-task/src/ac_parsing.rs:127) so both
// surfaces see identical AC strings.
export function extractAcLines(prBody: string): AcEvidence[];

// Trailing evidence annotation stripping — mirrors the lobster's
// strip_trailing_evidence regex so the agent loop can hand the bare
// AC description to its judgment prompt without losing structure.
export function stripTrailingEvidence(text: string): string;

// PR fetch — returns the body, file list, and raw patch text so the
// agent can either embed the patch directly or read cited files via
// its own read/exec tools. The patch is the canonical surface used
// by the reasoning step.
export async function fetchPrSummary(
  prUrl: string,
  token: string,
): Promise<PrSummary>;
```

Removed exports and internals:

- `defaultJudgeIntent` — deleted.
- `Deps.judgeIntent` — removed from the type.
- `verifySemantic` — deleted (was the orchestration loop that called the judge).
- `runCli` and the `import.meta.url === file://argv[1]}` CLI guard — deleted.
- `defaultPostComment`, `defaultPostApproval` — deleted (the agent loop uses its own tool calls to post via the Tasks API; no env-var-driven token wiring needed in the module).
- The `parseArgs` / `node:util` import — deleted.

The `package.json` `verify` script (`tsx src/verify.ts`) is also removed since the file is no longer a CLI entry. The `test` script (vitest) stays.

### Layer 2 — Ash's prompts/orchestration describe the reasoning loop

**`HEARTBEAT.md` step 3** (currently: "run the verifier in `agents/ash/src/verify.ts` and inspect cited tests, artifacts, and diff claims") becomes:

> When Ash is the current actor for a `qa_agent` gate:
> 1. Fetch the full task via the Tasks API.
> 2. Fetch the linked merged PR's body, file list, and patch via `gh api` (Ash's `ASH_GITHUB_TOKEN` is already in her agent env).
> 3. Use `extractAcLines` + `stripTrailingEvidence` from `agents/ash/src/verify.ts` to get the bare AC descriptions (these are imports, not invocations — Ash runs them inside her own reasoning context).
> 4. For each AC, reason over the AC's bare description + the PR patch + the cited test results + the cited files (read via the agent's `read`/`exec` tools). Reach a verdict: `verified` / `blocked` / `deferred`.
> 5. On `verified` for all ACs: post the structured `qa_agent` approval via the Tasks API (Ash's `ASH_TASKS_API_APPROVAL_TOKEN` is in her agent env). A `[qa-agent-verified]` comment records the per-AC reasoning summary.
> 6. On any `blocked` AC: post `[qa-agent-blocked] AC<N>: <reason>` listing each blocked AC's reason. Do **not** post the structured approval.
> 7. On a `deferred` AC: post `[qa-agent-deferred] AC<N>: <reason>` for that AC and continue the loop for the rest. If at least one AC was verified and none were blocked, post the structured `qa_agent` approval AND a `[qa-agent-deferred]` comment summarising the deferred subset.
> 8. If the same capability gap has been deferred across two distinct tasks, propose a follow-up feature task (create via Tasks API) describing the capability spec and link it from both deferred reports.

**`WORKFLOW.md`** §"When Ash is actionable" — the step "run the verifier in `agents/ash/src/verify.ts`" is replaced with "reason over the AC descriptions + PR diff + cited tests via the agent's own tool calls; defer on capability gap, block on evidence failure, verify on clean run."

**`SOUL.md`** — add one sentence: "I judge intent via reasoning over the PR diff, cited tests, and cited code; I defer with a precise reason when a capability gap prevents verification, and I never block on a gap I can name and route around."

**`DoD.md`** — append: "Capability gaps are reported via `[qa-agent-deferred]` task comments with a reason and (when known) a spec link; recurring gaps become follow-up tasks, not silent deferrals."

### `[qa-agent-deferred]` convention (cross-cutting)

| Comment | When | Effect on gate |
|---|---|---|
| `[qa-agent-verified]` | All ACs verified | structured `qa_agent` approval posted |
| `[qa-agent-blocked]` | One or more ACs blocked by evidence failure | no approval; routes to delivery assignee |
| `[qa-agent-deferred]` | One or more ACs require a capability Ash lacks | structured `qa_agent` approval posted if remaining ACs are clean; deferred ACs listed with reason + spec link |

The lobster (per `agents/workflows/feature-task/src/main.rs`) does not need to change for the new comment shape — the lobster's `qa_agent` gate is satisfied by the structured approval row, not the comment text. Comments are evidence/audit only. The `[qa-agent-deferred]` comment is for Ash's own audit trail and for Tom's acceptance pass.

### Capability-gap → follow-up task

When Ash sees the same deferred reason for a given capability gap across two distinct tasks, she creates a feature task (or research task) via the Tasks API describing the capability and linking the originating deferred reports. The task is assigned to Rowan (or whoever owns the capability work — Rowan's default for code-side capabilities). Ash does not auto-create tasks on the first deferral; the two-strike rule avoids task spam on a transient gap (e.g. a deployment temporarily down).

## Service boundary and data ownership

- **Owner:** `agents/ash/src/verify.ts` is a leaf module under `agents/ash/src/`. Only the `agents/ash` package consumes it. No other package in the repo imports from `agents/ash/src/verify.ts` today (verified via `grep -rn 'from.*agents/ash' codebases/sindustries/ --include='*.ts' --include='*.tsx'` — no matches outside `agents/ash/test/verify.test.ts`).
- **No data model changes.** The PR summary shape (`PrSummary`) is unchanged; only the function name moves from `defaultFetchPr` → `fetchPrSummary` (and the comment updates accordingly).
- **No API contract changes.** The Tasks API endpoints Ash calls (`POST /tasks/:id/approvals`, `POST /tasks/:id/comments`) are unchanged.
- **No new packages, no new dependencies.** `agents/ash/package.json` keeps the same `tsx`, `vitest`, `typescript`, `@types/node` set. The `verify` script is removed from the `scripts` block.
- **No `.openclaw` boundary implications for code.** Ash's agent identity lives at `~/.openclaw/workspace/agents/ash/`; only that file's HEARTBEAT.md is updated and it stays inside the agent's own runtime directory. No new env vars, no new credentials, no cron registration changes.
- **Cross-app contract:** none. `verify.ts` is not exported from `agents/ash`'s `package.json` `exports` field today; the refactor does not introduce one.

## Milestones

All milestones land on a single PR — the code-side refactor is tightly coupled to the prompt/orchestration update, and slicing them across two PRs would create a broken intermediate state (no judge → can't verify → all Ash tasks block; no updated HEARTBEAT.md → Ash doesn't know the new pattern).

- **WS1 — Refactor `verify.ts` to utilities only.** Delete `defaultJudgeIntent`, `verifySemantic`, `runCli`, the CLI guard, `Deps.judgeIntent`, `defaultPostComment`, `defaultPostApproval`. Rename `defaultFetchPr` → `fetchPrSummary`. Trim `package.json` `scripts.verify`. Update `agents/ash/README.md` to match.
- **WS2 — Update Ash's prompts/orchestration.** `agents/definitions/ash/HEARTBEAT.md` step 3, `WORKFLOW.md` "When Ash is actionable", `SOUL.md` (one-line addition), `DoD.md` (one bullet append).
- **WS3 — Update `agents/ash/test/verify.test.ts`** to cover only the surviving utilities. Add a `judgment-pattern.test.ts` doc-test describing the reasoning/deferral pattern (no live LLM call — it asserts that the agent's HEARTBEAT/WORKFLOW describe the pattern correctly and that the utility module exposes the expected surface).
- **WS4 — Live validation against a real merged PR.** Pick one of the merged PRs currently qa-agent-blocked in the queue (e.g. PR #506 on task `de19b186` once Ash's routing fix lands) and run Ash's heartbeat against it end-to-end. Confirm: `[qa-agent-verified]` posts + structured approval lands + task transitions `doing → acceptance`. Document the chosen task + PR in the PR body's "Test plan" section.

## Risk and mitigations

- **Risk: LLM hallucination produces a false-positive `verified` verdict.** A hallucinated approval lets a broken PR through Tom's acceptance.
  Mitigation: (a) the agent's temperature is already 0 in Ash's runtime config (deterministic); (b) the `[qa-agent-verified]` comment records the per-AC reasoning summary so a reviewer can audit each verdict; (c) the lobster's mechanical-evidence gate (task `5e35dc25` PR #502, in `acceptance`) runs *before* Ash sees the task, so any AC with a failing cited test or fabricated cited file never reaches Ash; (d) Tom's `accepted` approval is the terminal human gate — the lobster will not auto-complete without it.

- **Risk: PR diff exceeds Ash's context budget.** Some PRs (cross-service refactors, big spec migrations) have multi-MB diffs.
  Mitigation: `fetchPrSummary` already returns the per-file `files[]` list alongside the raw `patch`. Ash's reasoning step can choose to load only the files cited in the AC evidence annotations plus the PR body — she doesn't have to embed the entire patch. If the cited subset still exceeds budget, she routes `[qa-agent-deferred]` on every AC citing the budget reason (a single-shot deferral, not a permanent gap).

- **Risk: capability gap explosion (every task has at least one deferred AC).** If Ash starts deferring routinely, the gate becomes meaningless.
  Mitigation: the two-strike rule (only create a follow-up task on the second deferral of the same gap) keeps the work queue clean. Tom reviews the deferred reports at his `accepted` pass and decides whether the gate needs tightening or the capability needs building. The structured `qa_agent` approval still posts if at least one AC was verified and none were blocked — the gate does not require every AC verified, only that the deliverable's intent was met on the parts Ash could exercise.

- **Risk: the `[qa-agent-deferred]` convention is not recognized by downstream consumers.** The lobster only reads the structured approval row, not comments — but Quinn/Tom may use comment grep for triage.
  Mitigation: document the convention in `agents/definitions/ash/HEARTBEAT.md` (already done in WS2) and in the PR body of this work. No new machine readers today; the convention is for human review + Ash's own audit trail.

- **Risk: Ash is rerun on the same PR and gets a different verdict (LLM non-determinism).** Even with `temperature=0`, model upgrades can change verdicts.
  Mitigation: the structured approval row is idempotent; if Ash approves and re-runs and now blocks, the new `[qa-agent-blocked]` comment signals a regression to Tom and the approval row remains (Tom's `accepted` gate is the only thing that can mark the task `done`). Model-version pinning lives in Ash's runtime config (out of scope here).

- **Risk: Quinn's `[openclaw-needed]` provisioning for `f6a4d56a` left some env vars un-set, breaking `fetchPrSummary`.**
  Mitigation: the utility module reads `ASH_GITHUB_TOKEN` only when called; if it's missing, `fetchPrSummary` throws synchronously, and Ash's heartbeat will surface that as `[qa-agent-blocked] Auth/IO failure: ...` — same fail-loud pattern the prior CLI used. No silent failure mode introduced.

## Test plan

1. **AC1 (Ash picks up qa_agent-gate work from task queue):** live — pick a current qa_agent-blocked task, run Ash's heartbeat against it (WS4), confirm she iterates the per-AC loop from the new HEARTBEAT step 3 and posts either `[qa-agent-verified]`, `[qa-agent-blocked]`, or `[qa-agent-deferred]`.
2. **AC2 (Ash's prompts define her job; she posts approval):** code review of `agents/definitions/ash/HEARTBEAT.md` step 3 + `WORKFLOW.md` "When Ash is actionable" + `SOUL.md` line addition — must describe the reasoning loop and the structured-approval-post path without referring to a CLI invocation. `judgment-pattern.test.ts` asserts the new pattern is present in those files.
3. **AC3 (Bespoke text/token-matching code is removed):** `git grep -nE 'defaultJudgeIntent|judgeIntent|verifySemantic|runCli|token|overlap|heuristic' agents/ash/src/verify.ts` returns zero matches for any token/heuristic logic (the function *names* `extractAcLines` / `stripTrailingEvidence` / `fetchPrSummary` are still present). `agents/ash/test/verify.test.ts` covers only the surviving utilities (regex extraction, evidence stripping, PR fetch stub); `judgment-pattern.test.ts` documents that no judgment logic lives in code.
4. **AC4 (Capability gap → deferred report + spec link):** live — fabricate a capability gap on a synthetic AC (e.g. "manually click this button on the deployed app") and confirm Ash's heartbeat posts `[qa-agent-deferred]` for that AC with a reason and a (created-or-existing) spec link. Run inside the WS4 live validation.
5. **AC5 (Capability gap visibility over time):** code review of HEARTBEAT step 3 clause 8 (two-strike rule) + a small unit test in `judgment-pattern.test.ts` that asserts the two-strike task-creation hook is mentioned in Ash's prompts (no live API call). Live validation: simulate the same gap across two tasks and confirm Ash proposes the follow-up task on the second one.

## Open questions

- **Q1.** Should the `extractAcLines` / `stripTrailingEvidence` utilities move out of `agents/ash/src/` into a shared package like `agents/lib/` so the lobster and Ash share one canonical AC parser? *Recommendation:* no — the lobster already has its own canonical AC parser in Rust (`agents/workflows/feature-task/src/ac_parsing.rs:127`) and the cross-language boundary is more friction than the duplication is risk. Keep `agents/ash/src/verify.ts` as the TS-side surface. Open if Quinn disagrees after reading the AC2 verification cell.

- **Q2.** Should the `[qa-agent-deferred]` convention also be a lobster-recognised gate signal (e.g. a third state between `verified` and `blocked`)? *Recommendation:* no — the lobster's gate is binary (approved or not) and Tom's `accepted` pass already covers the "approved with caveats" case. Adding a tri-state gate adds complexity for no observable benefit; Tom can read the `[qa-agent-deferred]` comment at his pass. Open if Quinn wants the lobster to surface deferred-AC summaries at the next state transition.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 (Ash picks up qa_agent-gate work from queue, no CLI invocation) | HEARTBEAT.md step 3 + WORKFLOW.md "When Ash is actionable" describe the reasoning loop. WS4 live run against a current qa_agent-blocked task passes through Ash's heartbeat without invoking any CLI. `agents/ash/package.json` `scripts.verify` is removed. |
| AC2 (Ash's prompts/SOUL/WORKFLOW define her job; she posts approval) | SOUL.md addition + HEARTBEAT step 3 clauses 5–7 + WORKFLOW.md "When Ash is actionable" replacement are present and self-consistent. `judgment-pattern.test.ts` asserts each surface exists with the expected phrasing. WS4 live run: Ash posts the structured `qa_agent` approval via the Tasks API on a clean run. |
| AC3 (`defaultJudgeIntent` and any token/heuristic code removed from `agents/ash/src/verify.ts`) | `git grep -n 'defaultJudgeIntent\|judgeIntent\|verifySemantic\|runCli\|token-overlap\|heuristic' agents/ash/src/verify.ts` returns zero matches for the judgment surface (only the function names `extractAcLines`, `stripTrailingEvidence`, `fetchPrSummary` remain). `agents/ash/test/verify.test.ts` covers only the surviving utilities. |
| AC4 (Capability gap → deferred report with reason + spec link, no block) | HEARTBEAT step 3 clause 7 + DoD.md appended bullet describe the `[qa-agent-deferred]` convention. WS4 live run with a synthetic capability-gap AC confirms `[qa-agent-deferred]` posts and the structured `qa_agent` approval still lands (because the gap doesn't block the gate). |
| AC5 (Capability gap → discoverable follow-up task on second deferral) | HEARTBEAT step 3 clause 8 describes the two-strike rule. `judgment-pattern.test.ts` asserts the rule's phrasing is present in HEARTBEAT.md. Manual WS4 simulation (re-defer the same gap on a second task) confirms Ash proposes a follow-up task via the Tasks API on the second deferral. |
