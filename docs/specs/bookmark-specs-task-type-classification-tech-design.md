---
status: draft
task_id: 536e04fc-784c-4c23-8e36-bf1caa05436c
product_spec: brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md
shipped_pr: null
shipped_date: null
revision_note: 2026-08-06 NZST — Tom reversed the implementation approach. Classification is LLM-driven (part of Ivy's existing spec-generation call), not a separate deterministic helper. PR #359's classify_spec helper is the wrong foundation; it is removed in WS2.
---

# Bookmark specs get a task type, only feature-typed ones need Tom's approval

## Links

- Product spec: `brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md`
- Tech design: `docs/specs/bookmark-specs-task-type-classification-tech-design.md` (this file)
- Task: `536e04fc-784c-4c23-8e36-bf1caa05436c`
- Superseded PR (deterministic helper — to be deleted in WS2): https://github.com/Stoffer-Industries/sindustries/pull/359

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-536e04fc-bookmark-specs-task-type-classification-llm-redesign` (WS2 tech-design branch)
- Worktree: `~/workspaces/rowan/sindustries-task-536e04fc-bookmark-specs-task-type-classification`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must update Ivy's bookmark-spec prompt to return the structured `{spec_markdown, classification, classification_rationale}` payload (boundary lives outside this repo), and must register the recurring untyped-bookmark-task check as a cron.

## Revision history

- **2026-07-27 NZST (Quinn-approved)**: original design — separate `classifySpec(spec)` helper with LLM rubric + deterministic fallback. PR #359 merged the deterministic helper on 2026-08-05.
- **2026-08-06 NZST (this revision)**: Tom's correction — classification is **part of Ivy's existing LLM spec-generation call**, returning a structured `{spec_markdown, classification, classification_rationale}` payload. No separate helper, no deterministic fallback. PR #359's `classify_spec.py` and its tests are removed in WS2.

## Revised approach

The original design called for a separate `classifySpec(spec)` helper that wrapped a constrained LLM rubric, with a deterministic fallback for parse failures. Tom's correction simplifies this: the classification is **part of the existing LLM spec-generation call** (Ivy's bookmark prompt), not a separate function.

Concretely: Ivy's LLM call is extended to return a structured payload alongside the spec markdown. The pipeline reads both fields from the same call. There is no second classification pass, no keyword scoring, and no deterministic helper. This avoids a second source of truth and lets the LLM exercise judgment over the spec it is already reading.

### LLM output schema (the contract)

```json
{
  "spec_markdown": "<full spec body>",
  "classification": "feature" | "code" | "research" | "ambiguous",
  "classification_rationale": "<short prose; helps triage and debug>"
}
```

- `classification` is a 4-value enum. `ambiguous` is a **first-class outcome**, not a parse-error fallback.
- The schema lives in-repo as a documented constant (e.g. `agents/workflows/bookmarks/classification_schema.py`) so the prompt template, the validator, and the tests share one source of truth.
- Ivy's prompt is told: when in doubt, return `"ambiguous"`. Bias to ambiguous over guessing.

### Safety / invalid-output handling

The pipeline **never crashes** on bad LLM output, **never coerces** an out-of-enum value, and **never silently skips** the triage surface. Specific rules:

- Malformed JSON (parse error) → `ambiguous`. Do not raise.
- `classification` outside the enum (typo, hallucinated value) → `ambiguous`. Do not coerce.
- Missing `classification` field → `ambiguous`. Do not default.
- Empty `spec_markdown` → `ambiguous` (no useful spec to act on).
- LLM call timeout, transport error, or model refusal → `ambiguous`, with the error captured in the triage event payload so manual triage has full context.

Validation lives at the pipeline boundary (a thin wrapper around the LLM call) so all downstream branches see only the validated enum.

### Pipeline behavior by classification

| Classification | Today's flow | New flow |
|---|---|---|
| `feature` | Tom approves → task created (type=feature) | unchanged: Tom approval message, then Tasks API create with `type=feature` |
| `code` | (today: would have been feature-approved → task created) | skip approval, Tasks API create with `type=code` |
| `research` | (today: would have been feature-approved → task created) | skip approval, Tasks API create with `type=research` |
| `ambiguous` | n/a | do **not** call Tasks API create; emit `bookmark-triage-needed` event |

Every task created through this flow has its type set at creation (AC6) — no post-hoc patch. The `bookmark-triage-needed` event is the only place where a task is intentionally **not** created from the spec.

## Treatment of PR #359 (already merged)

PR #359 added two files on top of the unrelated `docs/systems/gymtrack.md` cleanup:

- `agents/workflows/bookmarks/scripts/classify_spec.py` — the deterministic classifier.
- `agents/workflows/bookmarks/tests/test_classify_spec.py` — 10 unit tests.

Tom's direction makes that implementation the wrong foundation. Cleanest treatment: **delete both files in WS2**, no fallback, no keep-as-utility. Concretely:

- WS2 removes `classify_spec.py` and `test_classify_spec.py` from main.
- PR #359 itself stays merged — it is a historical artifact. The new AC1 evidence lives in WS2's PR body (LLM-call wrapper tests + schema-validator tests).
- The `docs/systems/gymtrack.md` 8-line cleanup from PR #359 is unrelated and stays.
- No second source of truth (deterministic helper vs LLM call). No dead-code rot.

If PR #359's merged AC1 evidence (🧪 testID: `test_classify_spec.py::ClassifySpecTests`) later becomes inaccurate, that is acceptable: the lobster's `verify_delivery` is syntactic — it parses the PR body and accepts the evidence annotation as-is — it does not re-run deleted tests against main. WS2 re-claims AC1 with new evidence; the two PRs overlap on AC1 coverage, which is fine.

## Decomposition

- **WS1 (merged, historical)** — PR #359 deterministic helper. Deleted in WS2.
- **WS2 — LLM-driven classification + Ivy schema** (Rowan code + Quinn Ivy prompt)
  - Delete `classify_spec.py` + `test_classify_spec.py` from main.
  - Add `agents/workflows/bookmarks/classification_schema.py` — the documented 4-value enum + JSON validator. Treats parse/enum/missing-field errors as `ambiguous`.
  - Update Ivy's bookmark-spec prompt template to require `{spec_markdown, classification, classification_rationale}` structured output. Quinn commits the actual prompt text in `.openclaw`.
  - Add unit tests on the schema validator: 4 happy paths (one per classification) + 4 invalid-output paths (malformed JSON, wrong enum, missing field, empty spec).
  - Add integration tests on the LLM-call wrapper using recorded LLM responses for the 4 happy + 4 invalid cases. No live LLM in CI.
  - Quinn `[openclaw-needed]` for the Ivy prompt update.
- **WS3 — pipeline routing + ambiguous event** (Rowan)
  - Branch on the validated classification:
    - `feature` → existing approval flow (unchanged).
    - `code` / `research` → skip approval, call Tasks API `create` with matching type.
    - `ambiguous` → no `create` call, emit `bookmark-triage-needed` event.
  - Confirm Tasks API `create` accepts `type` (AC6).
  - Integration tests for each branch using recorded LLM responses.
  - Update the bookmark pipeline's existing skill / system doc to describe the routing rules.
- **WS4 — recurring untyped-task check** (Rowan script + Quinn cron registration)
  - `agents/cron/bookmark-triage-report.py` (or equivalent) queries bookmark-origin tasks without a type and emits a Telegram report when any are older than 7 days.
  - Dry-run tests + a one-shot smoke run.
  - Quinn `[openclaw-needed]` for cron registration.

## Data model / API contract

- Tasks API: `task.type` already exists per existing schema. WS3 verifies the bookmark creator sets it. **No schema change.**
- New event type `bookmark-triage-needed` for the Telegram/dashboard surface. Payload: `{spec_id, source_url, classification_rationale, error_if_any}` so triage has full context.
- LLM-output schema (4-value enum + rationale field) is the contract between Ivy's prompt and the pipeline. Lives in-repo as a documented constant; Quinn mirrors it in Ivy's prompt template in `.openclaw`.

## Workflow / cron / skill changes

- **Inside repo (Rowan)**: delete PR #359 helper; add classification_schema.py + validator + unit/integration tests; pipeline routing; `bookmark-triage-needed` event; recurring check script; system doc update.
- **Outside repo `.openclaw` (Quinn)**: Ivy bookmark-prompt update; cron registration for the recurring check.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — bookmark spec is classified as feature/code/research/ambiguous | Unit tests on `classification_schema.py` validator (4 happy + 4 invalid → ambiguous). Integration tests on the LLM-call wrapper using recorded responses for all 4 valid classifications. |
| AC2 — `feature` keeps today's approval flow | Integration test: feed a feature-classified LLM output, assert approval message emitted AND no task created. |
| AC3 — `code` / `research` skip approval, create task with matching type | Integration tests for code and research: assert no approval message AND a task created with the matching `type`. |
| AC4 — ambiguous sets no type, creates no task, surfaces for triage | Integration test: feed an `ambiguous` LLM output, assert no `create` call AND `bookmark-triage-needed` event emitted with full payload. |
| AC5 — untyped bookmark tasks are visible in a recurring check | The cron script is wired and dry-run-tested; manual smoke run after deploy. |
| AC6 — every task created through this flow has its type set at creation | Integration tests in AC3 + a query test that asserts zero `source=bookmark` tasks exist with `type=null` after the pipeline runs (modulo the deliberate ambiguous branch, which emits a triage event instead). |

User-visible ACs: AC2 (Tom sees approval messages only for feature-typed specs). E2E coverage: not directly applicable; the visible surface is Telegram. Coverage is unit + integration + a one-off Telegram manual check.

## Open questions and risks

- **LLM determinism**: classification may not be deterministic across runs. Acceptable — the schema is the contract, not specific tokens. Downstream routing is deterministic because it operates on the validated enum.
- **Ivy prompt template content**: Quinn owns the actual Ivy prompt template text in `.openclaw`. Rowan proposes the schema + prompt-fragment shape here; Quinn commits it.
- **`bookmark-triage-needed` event channel**: same surface as today's `bookmark-approval` message — Telegram via Lox. Confirm with Quinn that Lox is still the channel owner for the new event type.
- **Backfill**: existing untyped bookmark tasks. WS4's recurring check covers them; we explicitly do **not** auto-classify them in this PR.
- **PR #359 AC1 evidence**: after WS2 deletes the tests, PR #359's `🧪 testID: test_classify_spec.py::ClassifySpecTests` evidence becomes historical. The lobster's verifier is syntactic (does not re-run deleted tests) so the merged PR still validates, but the human reader should know the tests no longer exist on main. WS2 re-claims AC1 with new evidence.

## Linked spec

- `brain/tasks/specs/in-progress/bookmark-task-type-classification-2026-07-25.md`