---
status: draft
task_id: c78f62d6-5f19-4d17-bd3b-d77f3226f52f
product_spec: brain/tasks/specs/in-progress/solo-builder-product-validation-workflow-226c01e92a0b4b80.md
shipped_pr: null
shipped_date: null
---

# Solo-Builder Product Validation Workflow — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/solo-builder-product-validation-workflow-226c01e92a0b4b80.md`
- Task: `c78f62d6-5f19-4d17-bd3b-d77f3226f52f` (`Solo-Builder Product Validation Workflow`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/c78f62d6-5f19-4d17-bd3b-d77f3226f52f`
- Source bookmark: `brain/bookmarks/x/2-markets-worth-trillions-are-opening-at-the-same-.md` (key `226c01e92a0b4b80`)
- Source summary: `brain/bookmarks/summaries/2-markets-worth-trillions-are-opening-at-the-same-time-i-ve-been-through-3-plat-226c01e92a0b4b80.md`
- Existing system docs: `docs/systems/content-factory.md`, `docs/systems/tasks.md`
- Existing skills: `agents/skills/product/idea-capture/SKILL.md`, `agents/skills/product/feature-task-create/SKILL.md`, `agents/skills/product/spec-author/SKILL.md`, `agents/skills/bookmarks/curate/SKILL.md`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-c78f62d6-solo-builder-product-validation-workflow`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-c78f62d6-solo-builder-product-validation-workflow`
- No secondary repo changes expected.

## Source-read note

The product spec path is iCloud-backed under `brain/`; this agent hit macOS `Operation not permitted` when reading the source bookmark file directly. The task description has been rebuilt from the spec and includes the accepted intent, ACs, checksum, and Rowan workstream, so this design is grounded on the task record plus existing workspace inspection.

## Product intent

The task describes the desired outcome as:

> Tom can pick one niche agent-native product idea, run it through a documented validation slice on the Sindustries stack, and ship a working MVP (or confidently kill it) within a fixed window, using a 7-question agent design spec, a 50-example eval set, and a draft-and-approve autonomy pattern as gating artifacts before any UI work begins.

This is a methodology-codification task, not a feature build. The shipped artifacts are reusable templates and a procedural skill that composes on top of `idea-capture`, `feature-task-create`, and `spec-author`. Nothing new in `services/`, `apps/`, `packages/`, or `infra/` is required.

## Service boundary and data ownership

- The workflow lives entirely in the workspace (templates + skill) and reuses the existing Sindustries task lifecycle, bookmark pipeline, and content factory. No new service, no new database table, no new API.
- Templates are workspace artifacts: `brain/templates/solo-builder-product-validation/<template>.md`. They are reference material, not runtime state.
- The orchestration skill is `agents/skills/product/solo-builder-product-validation/SKILL.md`. It is a procedural layer that reads templates and walks Tom through the slice; it does not own any data.
- Long-lived validation state for a single product attempt lives in the task created via `feature-task-create` (the existing Tasks API path). The skill writes the 7-question and 50-example artifacts inline as task description or as attached markdown in the same branch; no separate persistence layer.
- Validation lessons (AC6) land back into the skill/template files via a follow-up edit on the same workflow branch — the lessons are documented, not stored in a database.
- Extraction plan: if a future product needs a dedicated validation-runner (e.g. recurring eval triggers, automated eval scoring), that becomes a new task with its own tech design. This spec deliberately does not pre-build it.

## `.openclaw` boundary

- No `.openclaw/` files should be edited in this repo PR.
- No new cron, no new agent, no new skill registration required (the skill lives in the repo and is invoked by name when relevant).
- If the chosen niche candidate requires deployment secrets (e.g. third-party API keys) once an MVP begins, post `[openclaw-needed]` with the exact env var names and target deployment at that point — not in this PR.

## Acceptance criteria recap

- **AC1:** A documented 7-question agent design template lives in the workspace and is the required first artifact for any new product idea before any build work begins.
- **AC2:** A documented 50-example eval-set template lives in the workspace and is the required gate before scaling any agent past draft-and-approve autonomy.
- **AC3:** A solo-built MVP can be scoped, evaluated, and shipped (or killed) inside a fixed two-week slice using the templates above and the existing Sindustries task/content/git infrastructure, without inventing new orchestration surfaces.
- **AC4:** A niche category selection step exists that surfaces boring, high-MRR, low-satisfaction incumbents as candidate targets, and Tom uses it before committing to a build.
- **AC5:** The build phase uses a draft-and-approve autonomy pattern: the agent drafts, a human approves, and full autonomy is only enabled after the eval set proves it is safe.
- **AC6:** After one MVP completes the slice, the lessons (skill files, eval patterns, distribution mechanics) land back into the workspace in a form that the next product can reuse without re-deriving them.

## Implementation plan

### New templates (AC1, AC2)

Two new files under `brain/templates/solo-builder-product-validation/`:

- `7-question-agent-design.md`
  - Header explaining purpose: "First artifact for any new product idea. Use before any build work begins."
  - The 7 questions themselves, each with a short rationale and a "what good looks like" example. Intentionally implementation-agnostic — questions are about the agent's job, the user's job, the data boundary, the failure mode, the safe-failure behavior, the success metric, and the eval criteria.
  - A worked example redacted from the bookmark thesis (one or two bullet points, not the full source).
  - A pointer to the next step (50-example eval set).
- `50-example-eval-set.md`
  - Header explaining purpose: "Gate before scaling any agent past draft-and-approve autonomy."
  - Template structure: 50 rows, each with `input`, `expected_output_or_behavior`, `failure_mode`, and `pass/fail`.
  - Guidance on how to source the 50 (real user utterances, synthetic edge cases, adversarial inputs).
  - Threshold guidance: minimum pass rate before scaling past draft-and-approve, and how to handle borderline cases.
  - A pointer to the draft-and-approve pattern doc.

These are workspace artifacts, not runtime services. They get reused as-is across future product attempts.

### Niche selection step (AC4)

A new procedure section in the orchestration skill (below). It surfaces the heuristic from the bookmark: "boring, high-MRR, low-satisfaction incumbents" — typically visible as App Store ratings ≤4 stars combined with public revenue / employee-count signals. The procedure is:

1. Tom picks 3–5 candidate niches from the bookmark pipeline or a fresh brainstorm.
2. For each, find at least 2 incumbent apps and capture: rating, MRR proxy (revenue or employee count), and top complaints.
3. Score each candidate on retention signal (high MRR proxy) and dissatisfaction signal (low rating + clear complaints).
4. Pick the top candidate; capture the rationale (1–2 sentences) into the task description.

The procedure is a `## Niche selection` section in the new skill, not a separate script. No new data store — the captured niche assessment is included in the task description or the 7-question template fill-in.

### Draft-and-approve pattern (AC5)

This is mostly already in `feature-factory-v2`: Tom approves the spec, the lobster flips the marker, Rowan implements, Quinn approves the PR, Tom does QA. The new contribution is the **eval-based gate** before scaling past draft-and-approve. Documented as:

- Default state for any new agent in this codebase: **draft-and-approve**. The agent drafts, a human approves, only then does the side-effect run.
- To exit draft-and-approve, the eval set (AC2) must pass at the documented threshold, and the relevant product owner must re-acknowledge the autonomy bump on the task.
- Re-entry: if a regression is detected after scaling, the lobster reverts the relevant ability to draft-and-approve and posts a `[autonomy-reverted]` task comment.

This is documented in the new skill and in `docs/systems/content-factory.md` (the existing system doc that frames product attempts). No new automation in this PR — the eval-based gate is a manual check until the eval scoring infra exists.

### Orchestration skill (AC1, AC3, AC4, AC5)

New file: `agents/skills/product/solo-builder-product-validation/SKILL.md`

Contents:

- **When to use** — Tom has a product idea and wants to validate before committing to build.
- **Pre-flight** — invokes `idea-capture` to anchor the idea doc first.
- **Step 1: Niche selection** — run the AC4 procedure, capture rationale.
- **Step 2: 7-question agent design** — fill in the AC1 template, attach to the task description.
- **Step 3: 50-example eval set** — fill in the AC2 template, attach to the task description.
- **Step 4: Task creation** — invoke `feature-task-create` with the AC1+AC2 artifacts as the task description body. Promote status to `ready` once Tom approves the spec.
- **Step 5: Two-week slice** — calendar-block the validation window; the slice uses the existing task lifecycle (lobster advances through `ready → doing → acceptance → done`). Include a mid-slice review at day 7 (kill decision) and a ship/kill decision at day 14.
- **Step 6: Lessons loop (AC6)** — after the slice completes, the skill writes the lessons back into the templates and the skill itself, on a follow-up edit. Lessons include: what the 7-question template missed, what the 50-example eval set caught, where the draft-and-approve gate helped or hurt, and any distribution mechanics worth keeping.

The skill is named `solo-builder-product-validation` so future agents (Ivy, future Rowans) can invoke it for the same path.

### Existing skill updates

- `agents/skills/product/idea-capture/SKILL.md` — add a one-line forward link: "If the idea is a product idea (something we'll build), continue with the `solo-builder-product-validation` skill instead of writing a freeform idea doc."
- `agents/skills/product/feature-task-create/SKILL.md` — no change required; the validation skill calls it as-is.
- `agents/skills/bookmarks/curate/SKILL.md` — no change required; bookmark pipeline is the upstream of niche candidates.

### System doc update (AC5)

Update `docs/systems/content-factory.md` to add a "Solo-builder validation path" subsection describing the workflow at a high level, with a link to the new skill. The skill itself is the operational reference; the system doc just records that the workflow exists and points future agents to it. No new system doc is created — `content-factory.md` is the right home per the consolidation bias in `docs/CONVENTIONS.md`.

### Validation slice mechanics (AC3, AC6)

The slice is a **calendar discipline**, not a new feature. The skill defines:

- Day 0: niche selection + 7-question template filled.
- Day 1–2: 50-example eval set filled.
- Day 3: task promoted to `ready`, spec approved by Tom, tech design posted.
- Day 4–7: implementation (`doing`).
- Day 7: mid-slice review. Kill criteria: niche signal is weaker than expected, eval set shows core loop fails, or build cost exceeds the slice budget. Killing is a feature, not a failure.
- Day 8–13: ship preparation, evaluation against the 50-example set, distribution hooks (X post from the content factory, SIndustries tab if relevant).
- Day 14: ship or kill decision. Ship = merge to main + complete the task. Kill = mark task done with a `[killed-at-day-N] <reason>` task comment and lessons write-back.
- Lessons write-back (AC6) lands within 1 week of the kill-or-ship decision, on a follow-up PR that edits the templates and the skill.

The slice uses existing infra: Tasks API for state, GitHub for code, the lobster for transitions, content factory for distribution. No new orchestration surfaces.

## Test plan

### Documentation tests

- Both templates exist at the documented paths and render as markdown without frontmatter errors.
- The skill file includes all six AC steps in order.
- The skill SKILL.md's `name` frontmatter is `solo-builder-product-validation` and is discoverable via the standard agents/skills tooling.
- The `content-factory.md` update references the new skill and does not duplicate it.

### Cross-reference tests

- `idea-capture/SKILL.md` mentions the new skill by exact name.
- The new skill mentions `idea-capture`, `feature-task-create`, and `spec-author` by exact name.
- `tasks.md` (existing system doc) is not modified — this workflow reuses the existing task lifecycle and does not introduce new task states.

### Procedural / manual test

The AC3 and AC6 tests are procedural — they validate that the workflow is usable end-to-end, not that a specific implementation passes. The validation is:

- The slice is run on at least one real product candidate (chosen by Tom).
- The slice completes inside 14 calendar days, or is killed before day 14 with a documented reason.
- The eval set catches at least one regression that the draft-and-approve gate would have allowed.
- After the slice, the lessons are written back into the templates and skill.

This is not automate-able in this PR. The PR ships the methodology; the methodology is validated by running it once. The task stays in `doing` until the first slice finishes (or is killed), and the lobster gating ensures the AC3/AC6 evidence flows back.

### AC verification matrix

| AC | Verification layer | Planned evidence |
|---|---|---|
| AC1 | Docs | `brain/templates/solo-builder-product-validation/7-question-agent-design.md` exists, has the 7 questions, header, and example. Skill refers to it by path. |
| AC2 | Docs | `brain/templates/solo-builder-product-validation/50-example-eval-set.md` exists, has the 50-row template, sourcing guidance, and threshold guidance. Skill refers to it by path. |
| AC3 | Manual | First slice runs to ship-or-kill inside 14 days; task transition history shows `ready → doing → acceptance → done` (or `done` with kill-reason). |
| AC4 | Docs + manual | Skill's `Niche selection` section exists; first slice's task description includes the captured niche rationale and 2+ incumbent signals. |
| AC5 | Docs + manual | Skill's `Draft-and-approve pattern` section exists; first slice's task description shows the autonomy state at each phase. |
| AC6 | Docs + manual | After the first slice, the templates and skill have a `## Lessons from <slice-name>` section added in a follow-up commit. |

## Open questions and risks

- **First slice requires a real product candidate.** This PR ships the workflow, but the AC3/AC6 success criteria only complete when the workflow is actually run on a product. Tom needs to pick a candidate before this task can move to `done`. The PR can land in `acceptance` (templates, skill, system doc update) and the task stays in `doing` until the first slice runs.
- **Draft-and-approve automation.** The skill documents the pattern but does not automate the eval-gate or autonomy-revert. If the first slice surfaces a need for automation, that becomes a follow-up task (not part of this spec).
- **Eval set quality.** 50 examples is a floor, not a guarantee. The skill's guidance is honest about this; the templates are templates, not promises.
- **Niche selection signal.** "Boring, high-MRR, low-satisfaction" is a heuristic, not a metric. The procedure captures the rationale but does not block on a quantitative threshold. Tom's judgment is the gate.
- **Source spec path.** The product spec under `brain/` was unreadable directly from this agent; the spec path is included verbatim and the task description's checksum is the source of truth for the design.
