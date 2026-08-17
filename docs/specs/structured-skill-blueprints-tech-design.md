---
status: draft
task_id: 197f7207-8341-4e42-9eab-73d494a9bbda
product_spec: brain/tasks/specs/in-progress/self-prompting-workflows-for-recurring-assistant-tasks-6a0a51276a782f08.md
shipped_pr: null
shipped_date: null
---

# Structured Skill Blueprints — Tech Design

## Links and delivery identity

- Product spec: `brain/tasks/specs/in-progress/self-prompting-workflows-for-recurring-assistant-tasks-6a0a51276a782f08.md`
- Task: `197f7207-8341-4e42-9eab-73d494a9bbda` (`🔧 Structured Skill Blueprints: A 5+1 Prompt Architecture for SKILL.md`)
- Bookmark: `6a0a51276a782f08`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `feature/197f7207-structured-skill-blueprints`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/feature/197f7207-structured-skill-blueprints`
- Canonical checkout (do not edit): `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`
- Tech design: `docs/specs/structured-skill-blueprints-tech-design.md`

## Product intent

Establish a single canonical SKILL.md template and refactor `spec-author` as the reference implementation. Every skill in the workspace ends up structured around five required sections — RULES, PROCESS, OUTPUT FORMAT, KNOWLEDGE FILES, ONBOARDING — plus a minimal IDENTITY pointer that defers role framing to the agent's `AGENTS.md`. Corrections surfaced during execution flow back into the skill's RULES block through a documented feedback loop owned by a new `skill-creator` skill, so rules stay current with real usage rather than invented intent.

The hard part is the feedback loop, not the data structure. Without an operable "capture correction" path in `skill-creator`, AC7 and AC4 remain aspirational; the rest of the template becomes decorative.

## Current-state and dependency check

Skill files currently live under `codebases/sindustries/agents/skills/` and follow ad-hoc conventions. Quick survey of the canonical checkout (relative to `agents/skills/`):

- Total skills present: each top-level subdirectory (e.g., `product/`, `ops/`, `dev/`, `content/`, `strategy/`, `bookmarks/`, `vara/`, `capture-product-feedback/`, `code-garden/`) contains one or more `SKILL.md` files.
- Identity paragraphs are duplicated in most skills rather than referenced via an IDENTITY pointer to the agent's `AGENTS.md`. For example, `agents/skills/product/spec-author/SKILL.md` currently opens with a long prose description of the spec-author role that overlaps with the originating agent's identity content.
- Anti-patterns sections are present in `spec-author` but are not formalised as ALWAYS/NEVER constraint statements.
- No skill today contains an explicit ONBOARDING block describing how a caller invokes it.
- A few skills list "read before starting" files inline in prose rather than as a standalone KNOWLEDGE FILES section.
- No `skill-creator` skill exists yet. It must be created here to make the feedback loop operable.

The only durable dependencies are:

1. The existing `spec-author` SKILL.md at `agents/skills/product/spec-author/SKILL.md` — to be refactored to the template.
2. Each agent's `AGENTS.md` (e.g., `agents/definitions/<agent>/AGENTS.md`) — read by the agent, not edited by this task.
3. The skill index/audit mechanism (handled outside this PR; we are not introducing a new index, just the per-skill structure).

No code service, API contract, database schema, or runtime change is involved.

## Ownership boundary

### Natural source of truth

This is a **shared-package / cross-app contract** change at the workspace conventions layer — the agent runtime and skill authors across all agents converge on a single SKILL.md shape. It is not UI-local state, API-owned state, database-backed domain data, nor a workflow/cron change.

- The template is owned by the `agents/skills/` tree in the sindustries repo.
- `spec-author` is the reference implementation per AC2.
- The new `skill-creator` skill owns the "capture correction" path required by AC7.
- Agent identity stays in each agent's `AGENTS.md`; this spec only changes how skills reference it (the IDENTITY pointer).

### Delivery cut

This is small enough to deliver in one implementation PR, but the commits should land in reviewable order:

1. Add the SKILL.md template (new file under `agents/skills/`).
2. Add the new `skill-creator` skill with the feedback-loop capture mechanism (AC7).
3. Refactor `spec-author` SKILL.md to the new template as the reference implementation (AC2/AC3/AC4/AC5/AC6 verified end-to-end against this skill).

There is no interim client-only shim here: every skill is a convention, and the durable boundary *is* the convention document. An interim partial-template rollout would invite drift between skills written to the new template and skills still on the old shape, with no clean way to enforce reconciliation.

The rollout of all remaining skills to the new template is deferred to natural rotation (per the product spec's Non-Goals). This PR delivers the template, the skill-creator, and `spec-author` only.

### `.openclaw` boundary notes

All work happens inside the sindustries repo. No external automation, cron, or workflow change is required to ship this. The `skill-creator` feedback-loop capture path is itself a skill invocation handled by the same agent runtime that loads every other skill; no OpenClaw runtime change is needed.

## Template and implementation file scope

### File 1 (new): `agents/skills/TEMPLATE.md`

Documents the canonical 5+1 structure. Heading order, each block's purpose, plus the rule that IDENTITY is a 1–2 line pointer to the agent's `AGENTS.md` and never restates identity. This file is the contract; `skill-creator` references it directly.

Section order, all required:

1. **IDENTITY** — 1–2 lines. Pointer to the agent's `AGENTS.md` only. No restatement of role, voice, history.
2. **RULES** — `## ALWAYS` and `## NEVER` bullet blocks. Encodes constraints derived from real past corrections (not invented rules).
3. **PROCESS** — Ordered steps the agent follows. Numbered or named phases. Sourced from how the skill has actually been invoked.
4. **OUTPUT FORMAT** — Markdown template, schema, or shape definition the agent must produce. Makes the artefact shape explicit and reviewable.
5. **KNOWLEDGE FILES** — Bullet list, in priority order, of files the agent must read before producing output. First action is always to load context, not reason from the invocation payload.
6. **ONBOARDING** — Standard activation message pattern: what the caller must provide (inputs, paths, keys) and the form. Removes the need for custom briefing prose per invocation.

### File 2 (new): `agents/skills/skill-creator/SKILL.md`

Implements the feedback-loop capture mechanism that makes AC7 operable. Written to the new template so it is also self-dogfooding. Key new sections beyond a normal skill:

- **PROCESS** — A "capture correction" subroutine. When a skill's output is corrected during execution (spec revisions, approval feedback, PR review comments), the agent:
  1. Surfaces the correction with context (source, date, originating skill).
  2. Decides whether it is rule-worthy (recurring vs. one-off, general vs. skill-specific).
  3. Edits the target skill's RULES block in ALWAYS/NEVER form, attributing the correction with a short note (e.g., "from AC2 review feedback YYYY-MM-DD").
- **OUTPUT FORMAT** — Markdown diff fragment for the RULES block update.
- **KNOWLEDGE FILES** — Names the per-skill RULES block as the file to edit, plus `agents/skills/TEMPLATE.md` for the shape.

The capture action is prescriptive, not aspirational: agents that notice a recurring correction have a defined action to take in the same work cycle, not a vague "consider updating the skill".

### File 3 (edit): `agents/skills/product/spec-author/SKILL.md`

Refactored to the new template. Concretely:

- Replace the prose identity preamble with a 1–2 line IDENTITY pointer to the Rowan (or current authoring agent) `AGENTS.md`.
- Add a `## ALWAYS` and `## NEVER` RULES block derived from the current "Anti-patterns" section, recast as constraint statements. Examples (sourced from today's anti-patterns):
  - **NEVER** write manually requested specs to `brain/bookmarks/specs/`.
  - **ALWAYS** confirm the output folder before writing.
  - **NEVER** include implementation details, script names, file paths, or CLI flags in ACs.
  - **NEVER** treat frictions as spec drivers.
  - **ALWAYS** name existing systems by name in Source and Notes rather than rebuilding them in ACs.
  - **ALWAYS** carry `classification` (`feature`, `code`, `research`) plus a one-sentence rationale.
- Keep the existing PROCESS block (intake mode → read context → assess → write → return metadata) but formalise it under the PROCESS heading.
- Add an OUTPUT FORMAT block that lifts the today's spec format (`# Spec — <Title>` with Source/Outcome/Why/Acceptance Criteria/Non-Goals/Notes sections and per-AC rules) into a markdown template.
- Add a KNOWLEDGE FILES block naming (in priority order):
  1. `/Users/quinnstoffer/.openclaw/workspace/docs/state-of-the-nation.md`.
  2. Provided reference material from the caller.
  3. Relevant existing system specs under `codebases/sindustries/docs/systems/`.
  4. Only-when-relevant historical `codebases/sindustries/docs/specs/` entries.
- Add an ONBOARDING block describing the standard activation message shape (callers provide `request`/`reference_path`/`bookmark_path`/`review_path`/`summary_path`/`topic`/`bookmark_key` as needed).

## Data model or API contract changes

None. No database schema, REST/GraphQL endpoint, message queue, or service interface is touched. This is a documentation-and-skill-conventions change only.

The implicitly-defined contract is the SKILL.md template shape itself — versioned by being stored at a stable path under `agents/skills/TEMPLATE.md`. Existing skills do not break, they gradually migrate; no deprecation migration is needed for non-target skills in this PR.

## Workflow, cron, and skill changes

This PR introduces one new workflow layer: a convention contract (`TEMPLATE.md`) and a maintenance skill (`skill-creator`). Both are present entirely inside `agents/skills/`. No cron registration is added or modified.

Workflow effect:

- Future skill authoring flows through `skill-creator` (either directly invoked or referenced when an agent writes a new SKILL.md), which reads the template and ensures every block lands in the right order.
- Future corrections flow back into the originating skill's RULES block through the `skill-creator` capture subroutine, executed in the same work cycle that surfaced the correction (per AC7).

## Test plan with AC verification matrix

Acceptance criteria fall under workspace-conventions and skill-content checks. There is no user-visible app flow, no API contract, and no shipped UI change — therefore no Playwright e2e path applies. The verification matrix below uses file/manual/skill-invocation layers and is **interior to this doc only** (per the tech-design SKILL.md rule). The PR body of the implementation PR will not re-list these checkboxes.

| AC | Verification approach | Why this layer |
|---|---|---|
| AC1 — SKILL.md template documented as canonical reference | File review: read `agents/skills/TEMPLATE.md` and confirm six required headings (IDENTITY, RULES, PROCESS, OUTPUT FORMAT, KNOWLEDGE FILES, ONBOARDING) with the IDENTITY constraint wording. | This is a documentation artefact; the verification *is* reading the artefact. No runtime exists to e2e against. |
| AC2 — `spec-author` SKILL.md updated to the template | File review: read `agents/skills/product/spec-author/SKILL.md`; confirm each of the six headings is present, an ALWAYS/NEVER RULES block is populated from the former anti-patterns section, the PROCESS block matches the existing steps, an OUTPUT FORMAT block formalises today's spec template, a KNOWLEDGE FILES section names state-of-the-nation + relevant systems specs, and IDENTITY is a pointer (≤ 2 lines) to the relevant `AGENTS.md`. | Same as AC1 — documentation artefact, verified by reading. |
| AC3 — Agent can answer "what am I not allowed to do" from RULES/PROCESS alone and "what role am I playing" from IDENTITY pointer + its AGENTS.md | Skill-invocation test: spin up a fresh agent invocation bound to the updated `spec-author` skill with no extra identity briefing; query "what are you not allowed to write?" and "what role are you playing?" Compare expected answers — the first must cite RULES bullets (not AGENTS.md identity); the second must cite the AGENTS.md identity path, not the skill body. | No production flow exists; the only sane test is invoking the skill and checking the answer. |
| AC4 — RULES block constraints drawn from real past corrections, not invented | Manual/audit review: walk each RULES bullet back to a documented correction (spec revisions, approval feedback, PR review comments). Record the source date and provenance in the PR description. Reject invented rules in PR review. | Rules encode history; verification is a provenance audit, not a code test. |
| AC5 — KNOWLEDGE FILES section in priority order | File review: read `spec-author`'s KNOWLEDGE FILES block; confirm ordering matches the priority list above (state-of-the-nation → caller-provided references → relevant systems specs → only-if-relevant historical specs). | Same as AC1 — content review. |
| AC6 — ONBOARDING defines standard activation message pattern | Skill-invocation test: invoke `spec-author` twice — once with a custom briefing prose, once with only the documented activation inputs. Both invocations must produce a spec that satisfies AC2's template (i.e. the activation pattern alone is sufficient). | The activation pattern's effect is observable at invocation time. |
| AC7 — Feedback loop for capturing corrections into RULES is operable | Skill-invocation test: trigger a fake correction in a controlled environment (e.g., commit a stub correction, run `skill-creator` capture subroutine against `spec-author`), then read the resulting RULES block and confirm the correction lands as a new ALWAYS/NEVER bullet with the source note. Also: trigger a recurring correction twice and confirm the agent surfaces a "rule-worthy" decision at least once. | The feedback loop is the new behaviour; the only honest test is running the loop and inspecting the output. |

### E2E note

No user-visible app behaviour changes, so no Playwright e2e coverage is required. The above matrix is sufficient and matches the spec's Non-Goal of "adding a UI for skill authoring" and "enforcing the template via linting or CI".

### Pre-merge verification (for the implementer)

- [ ] `agents/skills/TEMPLATE.md` present, six sections in required order.
- [ ] `agents/skills/skill-creator/SKILL.md` present and itself follows the template (dogfooding).
- [ ] `agents/skills/product/spec-author/SKILL.md` refactored to template; each former anti-pattern recast as ALWAYS/NEVER with source note.
- [ ] A run-through of the AC3 and AC6 skill-invocation tests above produces expected answers. Capture transcripts in PR description.
- [ ] A run-through of the AC7 capture subroutine against `spec-author` appends a bullet to its RULES block. Capture the diff in PR description.

## Open questions and risks

**Open questions to resolve in PR review, not blocking design:**

1. Should the template live at `agents/skills/TEMPLATE.md` or as the top section of a new `agents/skills/README.md`? Recommendation: `TEMPLATE.md` (purpose-built, easy to link into `skill-creator`'s KNOWLEDGE FILES). Confirm in PR.
2. Should the `skill-creator` skill also own the SKILL.md skeleton emission (i.e., when invoked for a new skill, emit a fresh SKILL.md pre-populated with the six headings), or is that better as a separate `skill-init` companion? Recommendation: include skeleton emission in `skill-creator` for now — splitting later is cheap, splitting prematurely duplicates prompts.
3. Should RULES bullets carry a `provenance:` inline tag (e.g., `- **NEVER** ...  _(from PR review #N, YYYY-MM-DD)_`) or live in a sibling `RULES_PROVENANCE.md` per skill? Recommendation: inline tag for now — keeps rule and its origin co-located.

**Risks:**

- **Drift after rollout.** Without lint or CI enforcement, skills written outside `skill-creator` (e.g., by humans editing SKILL.md directly) can diverge from the template. Mitigation: the product spec deliberately excludes tooling gates from this slice; risk is accepted and minimised by routing all new skill authoring through `skill-creator`.
- **Feedback loop noise.** If the capture subroutine is too eager, RULES blocks accumulate one-off corrections and bloat. Mitigation: the rule-worthiness decision (recurring vs. one-off) is part of AC7's verification — agents must filter before appending.
- **Identity reference breakage.** If an agent's `AGENTS.md` path changes, the IDENTITY pointer goes stale. Mitigation: pointers use stable paths (`agents/definitions/<agent>/AGENTS.md`); drift is detectable by reading the file at PR review time.
- **`spec-author` rule surface area.** Recasting eight anti-patterns as ALWAYS/NEVER rules is a behaviour change for spec authors (they now hit a hard constraint list before writing). Mitigation: each bullet traces to a real recurring correction, so the change tightens behaviour rather than inventing rules; PR review explicitly audits AC4.
- **Capture subroutine conflicts with concurrent edits.** Two agents editing the same skill's RULES block at once could clobber each other. Mitigation: the capture subroutine operates per-skill per-work-cycle; concurrent editing is the same risk as any other concurrent doc edit and is out of scope for this PR.
