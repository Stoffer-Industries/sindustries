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
- Do not create Tasks API tasks, code-garden tags, `Resolved:` lines, or `Closes:` lines.

## Runbook

Target repo: `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`

**1. Audit** — run the four-phase prompt above against the target repo. Produce the audit document in memory.

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
- Reviewer: `tomstoffer`
