---
status: draft
task_id: 536e04fc-784c-4c23-8e36-bf1caa05436c
product_spec: brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md
shipped_pr: null
shipped_date: null
---

# Bookmark specs get a task type, only feature-typed ones need Tom's approval

## Links

- Product spec: `brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md`
- Tech design: `docs/specs/bookmark-specs-task-type-classification-tech-design.md`
- Task: `536e04fc-784c-4c23-8e36-bf1caa05436c`
- Tasks API record: `http://localhost:4001/api/v1/tasks/536e04fc-784c-4c23-8e36-bf1caa05436c`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-536e04fc-bookmark-specs-task-type-classification`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must update Ivy's bookmark classification prompt and the related cron config so the classifier actually runs (boundary lives outside this repo).

## Scope

Today, every bookmark-generated spec waits for Tom's product approval before any task is created. Most bookmark specs are small code/research fixes that don't need Tom's sign-off. This task:

1. Classifies every bookmark spec as `feature`, `code`, or `research`.
2. Keeps today's flow for `feature`: Tom approves → task created.
3. Skips approval for `code` / `research`: task created directly with the matching type.
4. When classification is ambiguous, **no type is set** and **no task is auto-created**; the spec is surfaced for manual triage.
5. Bookmark-origin tasks without a type are visible in a recurring check.
6. Every task created through this flow has its type set at creation (no post-hoc patch).

## Ownership boundary

- The classifier and the approval-routing logic live in the bookmark pipeline (`apps/` or `agents/` depending on current structure). The task is **primarily about the bookmark pipeline** plus a small recurring check in `services/tasks-api` or a cron-driven report.
- Tasks API: `task.type` already exists per existing schema; we ensure the bookmark creator sets it. No schema change required.
- The recurring visibility check is a cron-friendly query against the Tasks API plus a Telegram message. Implementation lives in the OpenClaw boundary — flagged for Quinn.
- `.openclaw` follow-up: Ivy's bookmark-prompt must call the classifier; the cron must wire the recurring check. Quinn handles.

## Implementation plan

File/module scope:

- `agents/workflows/bookmark-pipeline/...` (or current location) — add a `classifySpec(spec)` step. Output is one of `feature | code | research | null` (null = ambiguous). Implementation:
  - Prompt the model with the spec body and a constrained rubric: feature = user-visible product change; code = infra/test/refactor; research = spike/one-pager; otherwise null.
  - Deterministic fallback: if the model's `type` field is empty, missing, or not in the allowed set, return `null`.
  - Unit tests with 6 fixture specs (2 feature, 2 code, 1 research, 1 ambiguous) assert the right output.
- `agents/workflows/bookmark-pipeline/...` — branch on classification:
  - `feature` → existing approval flow (unchanged).
  - `code` or `research` → skip approval message, call Tasks API `create` with `type: code|research`.
  - `null` → do not call Tasks API `create`; instead emit a `bookmark-triage-needed` event (Telegram + dashboard list) and stop.
- `services/tasks-api/src/routes/tasks.ts` — confirm `type` is accepted on POST. (Already exists per AC6, but verify in code.)
- `agents/cron/bookmark-triage-report.py` (or similar) — new recurring check:
  - Query `GET /tasks?source=bookmark&type=null&status=open&createdBefore=now-7d` (the actual filter shape is whatever the API supports; pseudocode here).
  - Emit a Telegram message listing any untyped bookmark tasks older than 7 days.
  - Wired into the existing daily cron.
- `agents/skills/bookmarks/x-ingest/SKILL.md` (or equivalent skill file) — document the new classifier and the routing rules so future agents understand the flow.
- `docs/systems/bookmark-pipeline.md` (or current system doc) — add a section "Spec classification and task typing" describing the rules.

## Data model / API contract

- Tasks API `create` body: ensure `type` field is persisted. Existing schema likely already supports it; if not, add an enum column via Prisma migration. No public API shape change.
- New event type `bookmark-triage-needed` for the Telegram/dashboard surface.
- Classifier output is intentionally narrow: `feature | code | research | null`. We do **not** allow custom types in v1.

## Workflow / cron / skill changes

- **Inside repo**: bookmark-pipeline classifier + branch, recurring check script, skill and system doc updates.
- **Outside repo (`.openclaw`)**: Ivy prompt update + cron registration. Quinn owns.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — bookmark spec is classified as feature/code/research | Unit tests on `classifySpec` with 6 fixtures; integration test that runs the full bookmark-pipeline end-to-end on a fixture and asserts the task's `type`. |
| AC2 — `feature` keeps today's approval flow | Integration test: feed a feature-classified spec, assert an approval message was emitted AND no task was created. |
| AC3 — `code` / `research` skip approval, create task with matching type | Integration tests: feed a code-classified spec, assert no approval message was emitted AND a task was created with `type: code`. Repeat for research. |
| AC4 — ambiguous classification sets no type, creates no task, surfaces for manual triage | Integration test: feed a fixture the classifier returns `null` for. Assert no `create` call AND a `bookmark-triage-needed` event was emitted. |
| AC5 — bookmark-origin tasks without a type are visible in a recurring check | The cron script is wired and tested via a dry-run that asserts it queries the right slice and would emit a message when untyped tasks exist. Manual smoke run after deploy. |
| AC6 — every task created through this flow has its type set at creation | Integration tests in AC3 + a query test that asserts zero `source=bookmark` tasks exist with `type=null` after the pipeline runs. |

User-visible ACs: AC2 (Tom sees approval messages only for feature-typed specs). E2E: not directly applicable; the visible surface is Telegram. Coverage is at unit + integration + a one-off Telegram manual check.

## Open questions and risks

- **Classifier consistency**: a small model may flip between feature/code on the same spec. We accept non-determinism — the rubric is the contract, not specific tokens. If Quinn wants determinism, we can switch to a regex/keyword pre-check before the LLM.
- **Triage surface ownership**: `bookmark-triage-needed` events currently flow to Telegram via Lox. Confirm with Quinn that Lox is still the channel owner.
- **Backfill**: existing untyped bookmark tasks in the DB. The recurring check (AC5) covers them; we explicitly do **not** auto-classify them in this PR.

## Linked spec

- `brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md`