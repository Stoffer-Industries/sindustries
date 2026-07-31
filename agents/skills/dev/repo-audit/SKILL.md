---
name: repo-audit
description: Run the weekly evidence-backed SIndustries repository audit and open the audit PR.
---

# Repo Audit

Audit the SIndustries repository using the four-phase prompt below and publish exactly one audit document for the current ISO week.

## Audit Prompt

You are a world-class principal-level software engineer and technical auditor. Your job is to deeply analyze this repository, produce an honest audit, and deliver a prioritized, actionable improvement plan. Work in the four phases below, in order. Do not skip ahead.

Ground every claim in actual files: cite file paths and line numbers. If you can't verify something, say so explicitly rather than guessing.

**Phase 1 / Discovery & Mapping** (read before judging)

> **Working-directory rule.** This audit runs in an isolated session whose
> `cwd` is NOT the target repo. Every `exec` / `read` / `list` / `git` call
> MUST use either absolute paths (`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/...`)
> or be prefixed with `cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries && ...`.
> Relative paths like `services/...`, `docs/...`, `apps/...` will resolve
> against the wrong cwd and fail silently with `exit 1`. This is the bug
> that broke the W31 audit (and may have been silently dropping findings
> in W28–W30).

Explore the repository systematically before forming any opinions:

- Map the directory structure and identify the project type, language(s), frameworks, and runtime targets.
- Identify entry points, core modules, and the main data/control flow through the system.
- Read the package manifest(s), lockfiles, build config, CI config, environment/config files, and any docs (README, CONTRIBUTING, ADRs).
- Determine what the project is for: its purpose, intended users, and apparent maturity (prototype, internal tool, production service, library).
- Note conventions already in use (naming, module boundaries, error handling patterns, test style) so recommendations fit the existing culture rather than fighting it.

Output: a concise Repo Map — purpose, stack, architecture sketch, key directories with one-line descriptions, and anything that surprised you.

**Phase 2 / Audit** (evidence-based, severity-rated)

Audit each dimension below. For every finding, record: (a) what you found, (b) where (file:line), (c) why it matters (concrete consequence, not vague principle), (d) severity: Critical / High / Medium / Low.

- Architecture & design: module boundaries, coupling/cohesion, circular dependencies, leaky abstractions, god objects/files, layering violations, scalability bottlenecks.
- Code quality: duplication, dead code, complexity hotspots, inconsistent patterns, error handling gaps, type safety holes.
- Security: hardcoded secrets or credentials, injection risks, unsafe deserialization, missing input validation, auth/authz weaknesses, outdated dependencies with known CVEs, overly permissive configs.
- Testing: coverage gaps (especially around core business logic), test quality, missing test types, flaky patterns, untestable code.
- Performance: N+1 queries, unnecessary allocations or copies, blocking calls in async paths, missing caching/indexing, unbounded growth.
- Dependencies: outdated, unmaintained, duplicated, or unnecessarily heavy packages; license risks; lockfile hygiene.
- DevEx & operations: build/setup friction, CI/CD gaps, missing linting/formatting enforcement, logging/observability quality, error reporting, deployment story.
- Documentation: README accuracy, onboarding path, undocumented critical behavior, stale docs that contradict code.

Prefer 15 high-confidence findings over 50 speculative ones. Distinguish facts from judgments and label which is which. Include a Strengths section — what the repo does well matters for deciding what to preserve.

Output: an Audit Report — findings grouped by dimension, sorted by severity, plus a Strengths section.

**Phase 3 / Improvement Strategy**

- Identify the 3–5 themes that explain most of the findings.
- For each theme, propose a target state and the principle behind it.
- State explicit trade-offs: what you're recommending NOT to fix and why.
- Define what "done" looks like with measurable signals.

**Phase 4 / Detailed Task Plan**

Break work into discrete tasks. Each task must include: title and one-paragraph description; files/areas affected; acceptance criteria; effort estimate (S = <2h, M = half-day, L = 1–2 days, XL = needs breakdown); risk; dependencies.

Order tasks into milestones:
- Milestone 0: Safety net — anything needed before refactoring safely.
- Milestone 1: Critical fixes — security and correctness issues.
- Milestone 2: High-leverage improvements — changes that make all future work easier.
- Milestone 3: Quality & polish — remaining medium/low items worth doing.

Flag quick wins (high impact, S effort) separately. For the top 3 tasks, include a brief implementation sketch.

## Required Document Sections

Produce a single markdown document with exactly these sections:

1. `## Executive Summary` — ≤10 sentences: overall health grade A–F with justification, top 3 risks, top 3 opportunities.
2. `## Repo Map`
3. `## Audit Report`
4. `## Improvement Strategy`
5. `## Task Plan`
6. `## Open Questions` — decisions needed from a human.

Constraints:
- Do not modify any source files while auditing. Analysis only.
- Do not pad the report. If a dimension is healthy, say so in one sentence.
- Calibrate to the project's maturity.
- Do not add `Resolved:` lines or `Closes:` lines.
- Do not create code-garden tags from the audit PR.
- You may create/link Tasks API tasks for important findings that are not code-garden-safe, following the audit follow-up workflow below.

## Audit follow-up task workflow

Code garden remains a narrow, behavior-preserving cleanup lane. Do not loosen it to pick up security, product, behavior, data migration, or architecture work.

During the weekly audit, classify actionable findings:

| Classification | Meaning | Follow-up |
|---|---|---|
| `garden-safe` | Functionally equivalent cleanup that fits code-garden guardrails | Leave for normal code-garden PR selection |
| `tracked-code-task` | Non-functional or corrective code work that is too risky for code-garden, including security hardening, architecture refactors, service-boundary fixes, migrations, or behavior-sensitive bug fixes | Create a `code` task and link it from the audit finding |
| `tracked-feature-task` | New user/product capability or product behavior that needs product scope | Create a `feature` task/spec and link it from the audit finding |
| `tracked-research-task` | Needs investigation before implementation is clear | Create a `research` task and link it from the audit finding |
| `needs-human-decision` | Needs Tom/Quinn judgement before tasking | List in Open Questions; do not create a task yet |

When creating a task during the audit:

1. Create the task with the correct `taskType`.
2. Include the source audit file and exact finding title in the task description.
3. Explain why the finding is not code-garden-safe.
4. Add observable ACs.
5. For code tasks with security implications, data migrations, service boundaries, cross-service APIs, or non-trivial refactors, include a linked tech design in `docs/specs/<slug>-tech-design.md`.
6. Update the audit finding line with `➡️ Tracked by task <short-id> (<full-id>)` or a task URL if available.

When the implementation lands, its PR updates the same audit finding line with `✅ [PR #<n>](https://github.com/Stoffer-Industries/sindustries/pull/<n>)`. The ledger is therefore:

`audit finding → task → tech design when needed → implementation PR → audit marked done`

If a task is created after the audit PR has already merged, open a tiny docs-only audit-ledger PR to add the task link. If the task is created before the audit PR merges, include the task link directly in the audit PR.

## Completion gate (HARD CONSTRAINT)

A successful audit session MUST end with all four of these gates firing, in order, before the session ends:

1. **Write** — `docs/repo-audits/<YYYY-Www>.md` exists on disk (not just
   planned in the assistant text — actually written via the `write` tool).
2. **Commit** — `git add docs/repo-audits/<YYYY-Www>.md && git commit -m "..."` (or the matching commit style).
3. **Push** — `git push -u origin <branch>` lands the branch on the remote.
4. **PR** — PR opened via the pr-open skill (`cod—audit: ...` title, Executive Summary body, `code-audit` label, `Stoff81` assignee, `Stoff81` reviewer).

If the session ends without all four landing, the audit is incomplete and
the cron will record `consecutiveErrors++`. The W31 trajectory showed the
agent generating the planning text "Now I have everything I need. Let me
write the audit document:" and then ending the session with no `write` tool
call — that's exactly the failure mode this gate prevents. **Do not stop
after planning; do the write, commit, push, and PR.**

## Runbook

Target repo: `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`

**1. Audit** — run the four-phase prompt above against the target repo. Produce the audit document in memory.

**1a. Verify cwd before any execution.** Run `pwd` first; if it does not
print `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`, then
prefix every subsequent command with `cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries && ...`
or use absolute paths. This is a one-time check at the start of each Phase 1
exploration to surface the cwd-mismatch bug if it ever recurs.

**2. Determine the current ISO week:**

```bash
python3 -c "import datetime; y,w,_=datetime.date.today().isocalendar(); print(f'{y}-W{w:02d}')"
```

**3. Write the audit document** to `docs/repo-audits/<YYYY-Www>.md` in the sindustries repo.

**4. Create a branch, commit, and push:**

```bash
cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
git fetch origin
git switch -C code-garden/sindustries/<YYYY-Www> origin/main
git add docs/repo-audits/<YYYY-Www>.md
git commit -m "docs: add repo audit <YYYY-Www>"
git push -u origin code-garden/sindustries/<YYYY-Www> --force-with-lease
```

**5. Open the PR** using the pr-open skill:

- Title: `cod—audit: sindustries weekly review <YYYY-Www>`
- Body: the `## Executive Summary` section from the audit document, followed by a link to the full audit file (`docs/repo-audits/<YYYY-Www>.md`)
- Label: `code-audit`
- Assignee: `Stoff81`
- Reviewer: `Stoff81`
