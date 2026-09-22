---
status: draft
task_id: 43a9ac7b-7d1a-4ff3-9d0e-fb4ecc823f1e
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech design — Pilot structured skill blueprint on `pr-open` (task `43a9ac7b`)

> **Status:** Draft. Quinn review requested.
> **Date:** 2026-09-21
> **Author:** Rowan (Staff Engineer)
> **Source of truth:** task `43a9ac7b-7d1a-4ff3-9d0e-fb4ecc823f1e` on the Tasks API.

## Intent and scope

Convert `agents/skills/dev/pr-open/SKILL.md` to follow the canonical structured SKILL.md blueprint defined by parent task `197f7207` — five required sections (RULES, PROCESS, OUTPUT FORMAT, KNOWLEDGE FILES, ONBOARDING) plus a minimal IDENTITY pointer that defers to the agent's `AGENTS.md` for role framing. Preserve the skill's existing operational guidance verbatim (the pr-open command template, the `requested_reviewers` zero-check postcondition, the AC evidence annotations table, the workstream update procedure); restructure its presentation rather than rewrite it.

This is a bounded pilot for the blueprint. **No other skill is touched in this task** — that's AC3. The wider rollout is owned by parent task `197f7207` and is out of scope here.

The task is `dependencyBlocked` on `197f7207`. The blueprint definition in `197f7207` AC1 is stable enough to design against (the five section names are fixed in the AC text), but the final shape of those sections may evolve. If `197f7207` ships a meaningfully different blueprint, this design will need to be re-shaped; the diff between AC1 description and the eventual implementation is small enough that a re-shape is one doc rewrite, not a refactor.

## Delivery metadata

- **Task:** `43a9ac7b-7d1a-4ff3-9d0e-fb4ecc823f1e` — Pilot structured skill blueprint on `pr-open`
- **Parent task:** `197f7207-8341-4e42-9eab-73d494a9bbda` — Structured Skill Blueprints: A 5+1 Prompt Architecture for SKILL.md
- **Branch:** `task-43a9ac7b-skill-blueprint-pilot` (off `origin/main`)
- **Worktree:** `workspace/worktrees/task-43a9ac7b-skill-blueprint-pilot`
- **Repository:** `Stoffer-Industries/sindustries`
- **Single PR scope:** yes — one doc file, plus the system-spec update called out below.

## Constraint — preserve every operational fact (read first)

The current `pr-open/SKILL.md` carries operational content that agents depend on. The blueprint conversion **must not drop, paraphrase, or relocate** any of the following:

1. **The reviewer-request postcondition check** — `gh api repos/.../pulls/<n>/requested_reviewers --jq '(.users | length) + (.teams | length)'` and the explicit "do not treat PR-open as complete until this check passes" rule, including the REST-not-GraphQL scope reasoning and the draft→ready conversion as a second opening event.
2. **The PR body template** — `## Summary` / `## System Spec` / `## Test plan` structure, the `Co-Authored-By` trailer guidance, and the `--label` requirement (every PR gets at least one origin or task-type label).
3. **The AC evidence annotations table** — the four annotations in priority order (`🧪 testID`, `⚠️ not tested`, `📄 not code`, `🔗 pr`), the `file:` removal note, the multi-task combined-delivery subsection pattern (`### Task <id>` scoping), and the QA-bounce reminder.
4. **The reviewer routing warning** — "if the reviewer is not stated, stop and ask/escalate — do **not** guess a default reviewer."
5. **The `--assignee` must be the opener's identity rule** — and the related "do not retry with another agent's token" warning.
6. **The Rust workflow quality gates** pointer and the system-spec vs app-spec distinction (DoD item 3).

The blueprint conversion restructures; it does not summarise or rewrite. If a fact is best read as a rule (e.g. "always verify the reviewer request actually registered"), it goes in the RULES block with its full substance. If it is a step in a procedure, it goes in PROCESS. If it defines the shape of the PR body, it goes in OUTPUT FORMAT. If it names what the agent must read first, it goes in KNOWLEDGE FILES. The mapping is mechanical, not editorial.

## AC2 — the nested-parentheses failure mode (must be explicit in RULES)

The feature-task lobster parses `- [x] AC<n>: <text> (<annotation>)` lines by matching the first top-level `(` after the AC text. Nested parentheses break the parser:

- **Breaks:** `AC1: ... (🧪 testID: cal-render (desktop))` — the trailing `)` closes the annotation, leaving `desktop))` outside; subsequent ACs are misaligned.
- **Flat form (correct):** `AC1: ... (🧪 testID: cal-render - desktop)` or `AC1: ... (🧪 testID: cal-render)` if "desktop" is not part of the test ID.

The existing `pr-open` SKILL.md already says `file:` has been removed and that the parser tolerates Markdown code spans, but it does not warn about nested parens. **AC2 requires this rule to be in the RULES block** of the restructured skill, with a flat-parentheses example adjacent to it so the agent does not need to derive the rule from context.

## Ownership boundary

This is a **skill / doc / workspace boundary** change at the repo level — no new service, no new database, no new API, no new cron, no new cross-app contract.

- **Skill content:** owned by `agents/skills/dev/pr-open/SKILL.md` (this PR). No other skill is modified (AC3).
- **Skill frontmatter:** already conforms to the existing `name` + `description` schema; the IDENTITY pointer is a minimal `> See AGENTS.md for role framing.` line — no agent-specific prose is inlined.
- **System spec:** no `docs/systems/*.md` change is needed — `pr-open` is a skill, not a system behaviour. The skill's parent skill (`pr-process`) already documents the PR lifecycle.
- **App spec:** no `apps/<app>/SPEC.md` change — the skill is doc-only.
- **Validation tooling:** no change. Existing skill validation runs on every PR touching `agents/skills/**`; this PR will pass that validation by construction.

## `.openclaw` boundary notes

- **None.** All changes live in `Stoffer-Industries/sindustries` (this repo). No agent-side wiring, no skill changes outside `pr-open`, no cron changes, no `.openclaw/` writes.

## Implementation plan

### File/module scope (relative to repo root)

1. **Modified: `agents/skills/dev/pr-open/SKILL.md`** — restructure into the 5+1 sections:
   - **RULES** — always/never statements derived from real past corrections. Concrete contents:
     - "Never open a PR without a designated reviewer in `--reviewer`. If the reviewer is not stated, stop and ask — do not guess a default."
     - "Never retry `gh pr create` with another agent's token to work around a scope error. Fix the opener's token or escalate."
     - "Never treat PR-open as complete until the `requested_reviewers` REST check returns non-zero — applies at both `gh pr create` time and at draft→ready conversion."
     - "Never use `gh pr view --json reviewRequests` for the postcondition check — requires scopes the agent token intentionally does not have; use the REST endpoint instead."
     - "Never nest parentheses inside AC evidence annotations. The feature-task lobster matches the first top-level `(`; nested `)` truncates the annotation and misaligns subsequent ACs. Use `-` or `:` separators in test names instead: `(🧪 testID: cal-render - desktop)` not `(🧪 testID: cal-render (desktop))`."
     - "Never omit AC checkboxes from a feature-task PR body. Use `- [x]` not bullet, not `- [ ]`, not `✅` emoji. The lobster parses `- [x]` only."
     - "Never drop the AC sentence text before the evidence annotation. The lobster rejects paraphrased or shortened AC text."
     - "Always include `## System Spec` (or a one-line no-change reason) and the `apps/<app>/SPEC.md` check before opening — neither has an automated gate, so the agent must verify by hand."
     - "Always include a `Co-Authored-By` trailer identifying the opener."
   - **PROCESS** — the existing ordered procedure, in four phases: (a) Before You Open (branch pushed, tests pass, commit convention), (b) Rust quality gates check, (c) `gh pr create` invocation with the template, (d) Postcondition checks (reviewer registered, workstream updated, `[implementer-prs]` comment posted). Each phase ends on a verification step the agent can run.
   - **OUTPUT FORMAT** — the PR body template (Summary / System Spec / Test plan / Acceptance Criteria) and the AC evidence annotations table (priority-ordered). The QA-bounce reminder lives here as a footer note, since it explains what the OUTPUT FORMAT is checked against.
   - **KNOWLEDGE FILES** — priority-ordered list of what to read first:
     1. `agents/skills/dev/pr-process/SKILL.md` — reviewer routing, label table, merging rules.
     2. `agents/skills/dev/pr-address-feedback/SKILL.md` — referenced from `pr-process` for the addressing-comments loop.
     3. The task description on the Tasks API — for the AC list to mirror in the PR body.
     4. `docs/CONVENTIONS.md` — for the system-spec vs app-spec DoD item.
     5. (When feature-task PR) the task's `[implementer-prs]` precedent comment, if any.
   - **ONBOARDING** — the standard activation pattern: "To invoke, the caller must provide (a) the implementation branch name, (b) the implementation owner's GitHub login, (c) the blocking reviewer's GitHub login (or `null` if the workflow does not specify one), (d) the label set, (e) the task ID and AC list, (f) the system-spec path or no-change reason. The skill returns the `gh pr create` invocation plus the postcondition check."
   - **IDENTITY (minimal)** — single line: `> See agent's AGENTS.md for role framing; this skill is doc-only and inherits the agent's authority boundaries from that file.`

2. **No new files.** The skill is restructured in place; skill-loading paths and `name` frontmatter stay identical so existing callers (`agents/definitions/**/WORKFLOW.md`, `agents/skills/dev/pr-process/SKILL.md`) continue to resolve.

3. **No test files.** Skills are validated by the existing `agents/skills/**` check; the restructured content must produce the same frontmatter shape and the same `gh pr create` invocation shape (verified by the agent reading the file).

### Branch and PR

- Branch: `task-43a9ac7b-skill-blueprint-pilot` (already created off `origin/main`).
- Commit: `docs(skills): pilot structured SKILL.md blueprint on pr-open (task 43a9ac7b)`.
- PR: single-PR delivery, draft → ready-for-review when Quinn's structured `tech_design` approval is recorded and the parent dependency `197f7207` clears (so the task can promote to `ready`/`doing`).
- Reviewers: `quinnstoffer` (blocking code reviewer) and `Stoff81` (visibility).
- Label: `code-task` (matches `taskType: code`).

## Test plan — AC verification matrix

The AC verification matrix belongs in this doc only (per `agents/skills/dev/tech-design/SKILL.md`). It will **not** be repeated in the PR body.

| AC | Verification | Test layer | Notes |
|---|---|---|---|
| **AC1** — `pr-open` SKILL.md follows the canonical 5+1 blueprint (RULES, PROCESS, OUTPUT FORMAT, KNOWLEDGE FILES, ONBOARDING + minimal IDENTITY pointer) | Restructured file has six `## RULES / ## PROCESS / ## OUTPUT FORMAT / ## KNOWLEDGE FILES / ## ONBOARDING / ## IDENTITY` (or equivalent) headings, in that order, each non-empty; IDENTITY block is ≤ 2 lines and contains an explicit pointer to the agent's `AGENTS.md` (no inlined role prose). Existing operational content (reviewer postcondition, PR body template, AC annotations table, reviewer routing warning, `--assignee` opener rule, Rust gates pointer, system-vs-app spec distinction) is present and unchanged in substance. | Manual review (no automated assertion for skill restructuring yet — see OQ1). | The repo's existing skill validation runs on every PR touching `agents/skills/**`; this AC is the design-level definition of "passes validation," not an assertion in it. |
| **AC2** — Skill warns authors that nested parentheses in PR evidence annotations break the feature-task lobster parser, and gives a valid flat-parentheses example. | RULES block contains a "never nest parentheses inside AC evidence annotations" rule with an explicit `Breaks:` and `Flat form (correct):` pair. The flat example uses `-` or `:` as the in-test separator (e.g. `(🧪 testID: cal-render - desktop)`), not nested parens. | Manual review. | OQ2 below asks whether this should become a machine-checked rule. |
| **AC3** — Updated skill passes the repository skill validation/checks and does not alter unrelated skills. | The PR diff contains exactly one file under `agents/skills/**` (`pr-open/SKILL.md`). CI's existing skill check (whatever the repo runs on `agents/skills/**` files) passes. No other `agents/skills/**` file is touched. | Automated: CI skill check + `git diff --stat agents/skills/` showing only `pr-open/SKILL.md` changed. | The skill check is whatever runs today; if no skill check exists yet, AC3 is satisfied by the single-file diff and absence of unrelated changes. |

### Test approach summary

This task is doc-only. The verification is human-review of the restructured file plus the existing CI skill check. There are no Playwright tests, no unit tests, no integration tests — the skill's output is consumed by agents, not by application code.

If a future iteration wants machine-checked assertions (e.g. "the RULES block must exist and be non-empty"), that belongs in the parent task `197f7207`'s follow-up tooling, not here.

## Open questions and risks

- **OQ1 — Skill validation tooling.** The repo does not currently have a public skill-validation script that asserts "this SKILL.md has the six required headings." AC1 is satisfied by manual review today. Should the parent task `197f7207` add such a validator before this PR is ready-for-review, or is "manual review" the bar for the pilot? **Recommendation:** ship this PR with manual review; the validator is a follow-up owned by `197f7207`.
- **OQ2 — Machine-check the nested-parentheses rule.** AC2's nested-parens rule is currently asserted by human review. A small lint check on PR body lines that match `^- \[x\] AC\d+:` could reject lines containing nested parens inside the `(...)` annotation group. **Recommendation:** out of scope for this task — add as a follow-up skill-validation tool if the failure recurs.
- **OQ3 — Parent task dependency.** Task `43a9ac7b` is `dependencyBlocked` on `197f7207`. If `197f7207` lands and renames or reorders any of the five required sections (RULES / PROCESS / OUTPUT FORMAT / KNOWLEDGE FILES / ONBOARDING), this design needs a re-shape before implementation. The five section names are explicit in `197f7207` AC1 and unlikely to shift, but the agent should re-check the parent's description immediately before opening the PR.
- **OQ4 — Pilot scope.** The task title says "pilot on pr-open." If `197f7207` lands and the pilot is judged insufficient or the blueprint is rejected, this PR is wasted work. **Mitigation:** the doc-only nature of the change means the PR can be reverted at near-zero cost; the cost of doing the pilot is small compared to the cost of building the blueprint without any concrete reference.

## Out of scope

- Updating any other skill to the new blueprint (parent task `197f7207` owns that rollout).
- Adding or modifying skill-validation tooling (follow-up to `197f7207`).
- Adding a CI check for nested parentheses in PR body AC lines (follow-up if recurrence demands it).
- Touching `docs/systems/*.md` or `apps/*/SPEC.md` — the skill is a doc-only deliverable.

## Refs

- Task: `43a9ac7b-7d1a-4ff3-9d0e-fb4ecc823f1e`
- Parent task: `197f7207-8341-4e42-9eab-73d494a9bbda`
- Source of truth: this file on the implementation branch (URL posted as task comment).
- Existing skill: `agents/skills/dev/pr-open/SKILL.md` (on `origin/main` as of `624e717f`).
- Blueprint definition: `197f7207` AC1.
