---
status: draft
task_id: faf260e9-fe7b-4ce5-86ba-e47acab0ddb3
product_spec: brain/tasks/specs/in-progress/compounding-signal-for-bookmark-pipeline-f0331a69bfaf9aa7.md
shipped_pr: null
shipped_date: null
---

# Compounding Signal for the Bookmark Pipeline — Tech Design

## Links and delivery identity

- Product spec: `brain/tasks/specs/in-progress/compounding-signal-for-bookmark-pipeline-f0331a69bfaf9aa7.md`
- Task: `faf260e9-fe7b-4ce5-86ba-e47acab0ddb3` (`🔧 Compounding Signal For The Bookmark Pipeline`)
- Bookmark: `f0331a69bfaf9aa7`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `feature/compounding-signal-bookmark-pipeline`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/feature/compounding-signal-bookmark-pipeline`
- Tech design: `docs/specs/compounding-signal-for-bookmark-pipeline-tech-design.md`

## Product intent

The approved product spec asks for one inspectable answer to “are we compounding yet?”: a weekly prior-context reuse percentage, its four-week trend, and the current week’s dossier-promotion count. The result is a derived, read-only consumer of existing bookmark pipeline and knowledge artifacts. It must not add ingestion, retrieval, memory, or evidence infrastructure.

The only user-facing addition is a `Compounding % (7d)` KPI in Pulse’s existing Bookmarks tab. Failures degrade to the previous successful value with a stale marker rather than interrupting bookmark review, spec dispatch, approvals, or task creation.

Non-goals remain: semantic scoring, cross-pipeline leverage, alerts or automatic remediation, a separate dashboard, and writes to any upstream pipeline artifact.

## Current-state and dependency check

The implementation target already contains the shipped Mission Control Bookmarks tab and its dev-only workspace file adapter:

- `apps/mission-control/src/tabs/BookmarksTab.jsx`
- `apps/mission-control/src/tabs/BookmarksKpiRow.jsx`
- `apps/mission-control/src/bookmarkStateSource.js`
- `apps/mission-control/vite.config.js`

The two data-producing specs named by the product spec are still draft and unapproved as of this design:

1. `brain/bookmarks/specs/markdown-knowledge-base-metadata-and-retrieval-for-bookmark-pipeline-1f7463c784e8580f.md` proposes `priorContextRefs` on bookmark state and `brain/state/index/bookmark-corpus-index.jsonl`.
2. `brain/bookmarks/specs/evidence-layer-for-bookmark-review-e7a5199d628ecf8e.md` proposes topic dossiers and run receipts, but does not yet specify a dossier-promotion timestamp contract.

The dashboard dependency has effectively shipped, despite the product spec describing all three inputs as drafts. Implementation therefore starts with a dependency-contract check and must not invent or write missing upstream fields. If the final upstream contracts differ, this design is revised before computation is enabled.

## Ownership boundary

### Natural source of truth

This is a **workflow/OpenClaw-boundary derived artifact**, not UI-local state, API-owned state, database-backed domain data, or a shared-package contract.

- Upstream domain truth stays in workspace bookmark/evidence artifacts under `brain/state/`.
- A repo-owned Python command performs deterministic read-only computation and publishes a small derived artifact back to `brain/state/`.
- Pulse is a direct read-only consumer through its existing dev workspace adapter.
- The weekly cadence is owned by OpenClaw cron metadata; only the command and cron prompt are versioned in this repo.

No route, table, migration, credential, or persistence responsibility is added to `services/tasks-api`. Routing this through Tasks API would violate its task/workflow ownership boundary and would be more work than the durable file-derived boundary.

### Delivery cut

This feature is small enough to deliver in one implementation PR, but the PR should be internally ordered as mergeable commits:

1. pure calculator, schema validation, renderers, fixtures, and tests;
2. Pulse file adapter and KPI tile;
3. versioned runbook/system/app docs and cron prompt.

The external cron registration and workspace `infra/RUNBOOKS.md` index update happen only after merge as an explicit OpenClaw handoff. There is no interim client-only metric: computing the percentage in React would duplicate domain rules, erase the weekly artifact required by AC1, and create avoidable migration work.

## Metric contract

### Input adapter boundary

`compute_compounding_signal.py` will isolate final upstream shapes behind three pure adapters. The adapters accept paths via CLI flags, so tests use fixtures and the implementation can absorb upstream revisions without changing metric or renderer code.

1. **Bookmark cohort adapter**
   - Default proposed source: `brain/state/bookmark-review-state.json`.
   - Required per eligible item: stable bookmark key, current `reviewStatus`, a stable review/context-evaluation timestamp, and optional prior-context references.
   - Proposed draft mappings are `reviewedAt` and `priorContextRefs`, but these mappings are not considered final until the knowledge-base spec ships.
2. **Corpus health adapter**
   - Default proposed source: `brain/state/index/bookmark-corpus-index.jsonl`.
   - Returns valid indexed-document count and source freshness for the fixed operator-note decision table.
3. **Dossier-promotion adapter**
   - Default source is selected only after the evidence-layer spec defines a machine-readable promotion event with a stable event ID and timestamp.
   - Returns promotion events; the current-window count is the number of unique events whose promotion timestamp is in that window.
   - Parsing prose from `dossier.md`, file mtimes, or diff filenames is explicitly forbidden because none is a reliable promotion-event contract.

All adapters read bytes only. They expose no mutation methods and do not import bookmark workflow mutation helpers.

### Eligible states

The proposed closed set is:

```text
summarized
needs_research
spec_requested
spec_created
approval_pending
revision_requested
revision_staged
approved
tasked
declined
```

This includes current items at or beyond review/context evaluation, spec dispatch, approval, or a terminal outcome and excludes `ingested` because retrieval has not yet been evaluated there. Unknown states are rejected with a validation error rather than silently added to the denominator. The final set must be reconciled with the shipped upstream state contract before implementation is enabled.

Eligibility is evaluated from the item’s **current effective state** (respecting the existing task-linked ⇒ `tasked` invariant). An eligible item is assigned to one trend window using the upstream context-evaluation timestamp. This prevents later state transitions from counting the same item in multiple weeks while preserving AC2’s “currently in” wording.

### Window and percentage semantics

The command accepts `--as-of <ISO-8601>` for deterministic tests/manual reconstruction; otherwise `asOf` is the invocation time. All stored instants are UTC. Four contiguous half-open windows are produced:

```text
current: [asOf - 7 days, asOf)
prior1:  [asOf - 14 days, asOf - 7 days)
prior2:  [asOf - 21 days, asOf - 14 days)
prior3:  [asOf - 28 days, asOf - 21 days)
```

For each window:

- `eligibleCount` = currently eligible items whose context-evaluation timestamp lies in the window.
- `referencedCount` = those items with at least one valid, non-self prior-context reference.
- `percentage` = `round(referencedCount / eligibleCount * 100, 1)`.
- If `eligibleCount == 0`, `percentage` is `null`, not `0.0`; “no observations” must not look like measured zero reuse.

The headline is the current window’s percentage. JSON stores counts alongside percentages so every value is auditable. Markdown shows `—` for `null`.

### Fixed operator-note decision table

A note is selected only when all four percentages are non-null and `< 25.0`. The artifact stores the stable note ID and exact text; no LLM or generated prose is involved.

| Priority | Note ID | Inspectable predicate | Fixed text |
|---|---|---|---|
| 1 | `corpus_too_small` | Corpus index has fewer than 25 valid documents | `The indexed corpus is still too small to treat a low reuse rate as diagnostic. Keep collecting reviewed material, then reassess after four measurable weeks.` |
| 2 | `retrieval_path_may_be_broken` | Established corpus (≥25 documents), at least 10 eligible items across the four windows, and `referencedCount == 0` across all four | `The corpus is established but no eligible bookmark recorded prior context in four measurable weeks. Check the retrieval and state-recording path before interpreting this as unrelated intake.` |
| 3 | `mostly_unrelated_intake` | All other all-four-low cases | `Prior context is being recorded, but fewer than one in four eligible bookmarks reused it in every measured week. Most recent bookmarks may be unrelated to the existing corpus; inspect matched terms and topic mix before changing retrieval.` |

The constants (`25` corpus documents, `10` four-week eligible items, `25.0%` low threshold) live once in the calculator module, are emitted under `decisionPolicy` in JSON, and are documented in the runbook. Changing them is a reviewed code/config change, never prose editing at runtime.

### JSON artifact

Canonical machine-readable path: `brain/state/compounding-signal.json`.

Proposed schema (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "runId": "2026-08-17T20:15:00Z",
  "generatedAt": "2026-08-17T20:15:00Z",
  "asOf": "2026-08-17T20:15:00Z",
  "headlinePercentage": 37.5,
  "currentWindow": {
    "start": "2026-08-10T20:15:00Z",
    "end": "2026-08-17T20:15:00Z",
    "eligibleCount": 8,
    "referencedCount": 3,
    "percentage": 37.5,
    "dossierPromotionCount": 2
  },
  "trend": [
    {
      "offsetWeeks": 0,
      "start": "2026-08-10T20:15:00Z",
      "end": "2026-08-17T20:15:00Z",
      "eligibleCount": 8,
      "referencedCount": 3,
      "percentage": 37.5
    }
  ],
  "operatorNote": null,
  "decisionPolicy": {
    "lowPercentageBelow": 25.0,
    "corpusEstablishedDocuments": 25,
    "minimumFourWeekEligibleItemsForBrokenPath": 10
  },
  "inputs": {
    "bookmarkState": { "path": "brain/state/bookmark-review-state.json", "observedModifiedAt": "..." },
    "corpusIndex": { "path": "brain/state/index/bookmark-corpus-index.jsonl", "documentCount": 42 },
    "dossierPromotions": { "path": "<final upstream contract>", "eventCount": 2 }
  }
}
```

`trend` always contains exactly four entries ordered current to oldest. The implementation validates finite percentages, count relationships, timestamp ordering, the four-window count, known note IDs, and `headlinePercentage == trend[0].percentage` before publish.

### Markdown artifact

Human-readable path: `brain/state/compounding-signal.md`. It is rendered from the validated JSON model and contains:

- headline percentage and generated timestamp;
- a four-row trend table with dates, numerator, denominator, and percentage;
- current dossier-promotion count;
- operator note ID/text when selected;
- input paths and policy thresholds for inspection;
- the manual command pointer from the runbook.

JSON is the dashboard source of truth. Markdown is an operator rendering and must carry the same `runId`.

### Publication and failure semantics

The command computes and validates entirely in memory, writes both outputs to sibling temporary files, fsyncs them, then replaces the destination files. Existing destinations are retained as rollback copies until both replacements succeed. On any parse, compute, validation, or write error, the command exits non-zero, restores the prior pair if replacement had started, and prints one structured JSON error to stderr without touching upstream inputs.

The successful artifact itself is never rewritten to say “stale.” Staleness is a read-time condition: the UI marks a valid artifact stale when `generatedAt` is more than 8 days old (weekly cadence plus one-day grace). Therefore a failed weekly run naturally leaves the previous valid value visible and stale; it never blocks or mutates another pipeline stage.

## Implementation plan

### Calculator and artifacts

- **`agents/workflows/bookmarks/scripts/compute_compounding_signal.py`** (new)
  - Python standard library only, matching the repo’s workflow-glue precedent.
  - Resolves the workspace from `--workspace-root`, then `WORKSPACE_ROOT`; no checked-in absolute path.
  - CLI flags: `--workspace-root`, `--as-of`, input/output path overrides, `--dry-run`, and `--json`.
  - Pure functions for state normalization, windowing, percentage calculation, dossier event dedupe, note selection, schema validation, and Markdown rendering.
  - `--dry-run` reads and validates all inputs and prints the candidate JSON without publishing.
- **`agents/workflows/bookmarks/scripts/tests/test_compute_compounding_signal.py`** (new)
  - Temporary fixture workspace only; no live brain dependency.
  - Covers boundary timestamps, state eligibility, null windows, one-decimal rounding, non-self references, promotion dedupe, each note branch, malformed inputs, unknown states, deterministic Markdown, rollback, dry-run, and input-byte immutability.
- **`brain/state/compounding-signal.json` and `.md`**
  - Runtime outputs outside the repo, not committed.
  - The first production artifact is created only after upstream contracts and cron registration are ready.

The signal is a separate command, not a step in `agents/workflows/bookmarks/bookmarks.lobster.yaml`. The lobster runs more frequently than weekly and contains an approval pause; coupling the signal to it would make cadence and failure isolation worse. The signal remains downstream of the pipeline by reading its successful artifacts.

### Mission Control adapter and KPI

- **`apps/mission-control/vite.config.js`** (modify)
  - Add `GET /api/compounding-signal` to the existing dev-only `brainStateApi` plugin.
  - Missing file returns `404` (so missing is distinguishable from a valid empty signal); malformed JSON returns `500` without crashing Vite.
- **`apps/mission-control/src/bookmarkStateSource.js`** (modify)
  - Add an optional signal fetch and schema parser.
  - Return `compoundingSignal` plus `compoundingSignalStatus: valid | missing | malformed` without converting an optional signal failure into failure of bookmark state/transitions.
  - Abort signal is forwarded to all fetch calls (correcting the currently unused `signal` parameter while this module is touched).
- **`apps/mission-control/src/compoundingSignal.js`** (new)
  - Pure schema validation, staleness (`generatedAt + 8 days`), color band, and subtitle helpers.
  - Bands: green `≥ 50.0`, amber `25.0–49.9`, red `< 25.0`; null/missing has neutral styling.
- **`apps/mission-control/src/tabs/BookmarksKpiRow.jsx`** (modify)
  - Render the Compounding tile first, then existing state-count cards.
  - Valid: headline, semantic color, short subtitle (`<referenced>/<eligible> referenced · <n> dossier promotions`), and a stale marker when applicable.
  - Missing or malformed: `—` plus `Signal unavailable`; malformed may include an accessible title/diagnostic without dumping raw JSON.
  - The operator note remains in the artifacts/runbook; it is not expanded into a new dashboard panel in this slice.
- **`apps/mission-control/src/tabs/BookmarksTab.jsx`** (modify)
  - Pass signal state into the KPI row; a signal fetch problem does not replace the whole tab with its global error card.
- **`apps/mission-control/src/styles/components.css`** (modify)
  - Add semantic green/amber/red/neutral tile modifiers using existing design tokens; no new opaque palette.
- **Tests**
  - Extend `bookmarkStateSource.test.js`, add `compoundingSignal.test.js`, and extend `BookmarksTab.test.jsx` for valid bands, missing placeholder, malformed placeholder, stale marker, subtitle, and independent failure semantics.

### Versioned documentation

- **`docs/systems/bookmark-workflow.md`** (modify on implementation)
  - Add the signal as a downstream read-only observability consumer, its input/output contracts, cadence boundary, and failure semantics.
- **`apps/mission-control/SPEC.md`** (modify on implementation)
  - Add the Compounding KPI behavior and fallback states to the Bookmarks flow/screen and test-coverage list.
- **`docs/runbooks/bookmark-compounding-signal.md`** (new)
  - Versioned operator runbook covering manual dry-run/publish commands; health by maturity stage; established-corpus target `≥35%` after four measurable weeks; thresholds; and missing, stale, malformed diagnosis/recovery.
  - “Early” health is data coverage rather than a target percentage; “measuring” health is four non-null windows; “established” health is `≥35%` with four measured weeks and an established corpus.
- **`agents/crons/prompts/bookmark-compounding-signal.md`** (new)
  - Runs the exact calculator command, validates its structured result, says `NO_REPLY` on success, and includes the mandatory `notify-soft-fails` block. It never invokes another bookmark pipeline stage.

## Workflow, cron, and `.openclaw` boundary

Repo code cannot register OpenClaw cron metadata or write the runtime brain artifacts during implementation. Post-merge handoff is therefore required:

1. Inspect existing cron state first; do not create a duplicate job.
2. Register one isolated weekly job pointing to `agents/crons/prompts/bookmark-compounding-signal.md`.
3. Recommended schedule: Monday 08:15 `Pacific/Auckland` (`15 8 * * 1` with explicit timezone), after ordinary overnight bookmark work and away from existing exact-hour jobs.
4. Run the command manually once, inspect the JSON/Markdown pair, and verify the Pulse tile.
5. Add a short index entry to workspace `infra/RUNBOOKS.md` pointing to the versioned repo runbook, or add a workspace-specific companion only if Lox requires host recovery detail that does not belong in the repository.
6. Record the handoff through the feature workflow’s supported OpenClaw-needed/done mechanism; do not claim AC5 complete until the registered job is visible and a successful run is evidenced.

No secrets, ports, gateway restart, service restart, or new `.openclaw` config keys are required. Cron creation is external state and must be explicitly reviewed/applied after the implementation merges.

## Test plan

### Automated gates

- Python: `python3 -m unittest discover -s agents/workflows/bookmarks/scripts/tests -p 'test_compute_compounding_signal.py'`
- Mission Control targeted tests: `npm --workspace @sindustries/mission-control test -- --run src/compoundingSignal.test.js src/bookmarkStateSource.test.js src/tabs/BookmarksTab.test.jsx`
- Mission Control full tests: `npm --workspace @sindustries/mission-control test -- --run`
- Build: `npm --workspace @sindustries/mission-control run build`
- File/doc assertions: frontmatter valid; runbook, system doc, app spec, and cron prompt links resolve; no absolute local path is introduced.
- Read-only proof: calculator integration test hashes every fixture input before/after successful, dry-run, malformed, and simulated-publication-failure paths.

### Acceptance-criterion verification matrix

| AC | Verification | Layer |
|---|---|---|
| AC1 — weekly JSON + Markdown with headline, four windows, current promotions | Calculator fixture asserts schema, exactly four ordered windows, promotion count, shared run ID, and deterministic Markdown; post-merge cron evidence proves weekly registration | Unit + file + OpenClaw/manual |
| AC2 — eligible-state numerator/denominator and one decimal | Table-driven tests cover every allowed/excluded state, task-linked effective state, window boundaries, missing/empty refs, duplicate/self refs, and rounding | Unit |
| AC3 — closed low-trend decision table | One fixture per note ID plus threshold boundary cases; schema rejects unknown note IDs and generated prose | Unit |
| AC4 — KPI, bands, subtitle, missing placeholder | Vitest renders valid percentages at 24.9/25.0/49.9/50.0, subtitle, and missing/malformed placeholders | Component |
| AC5 — weekly, read-only, non-blocking, previous value stale | Input hash/rollback tests; adapter tests prove signal failure does not fail bookmark state; stale-age tests; post-merge cron registration and forced-failure smoke | Unit + integration + OpenClaw/manual |
| AC6 — manual trigger, maturity health, three failure cases | Runbook file review plus commands exercised against valid/missing/stale/malformed temporary artifacts | File + manual |
| AC7 — downstream draft dependencies remain revisable | Adapter boundaries and dependency section reviewed against the final upstream specs before enablement; no upstream writes/imports; contract-drift fixtures fail closed | Design/file + unit |

Pulse’s Playwright suite remains deferred in `apps/mission-control/SPEC.md`; starting a new browser harness for one read-only tile is disproportionate. Component tests cover the complete visible state matrix, while a post-merge manual smoke covers the real workspace adapter and cron-produced artifact.

## Rollout and rollback

1. Merge calculator/UI/docs with the cron unregistered.
2. Confirm final upstream contracts and run `--dry-run` against live workspace data.
3. Publish once manually; validate both artifacts and the tile.
4. Register the weekly cron and observe its first scheduled success.

Rollback is to disable/remove only the signal cron registration, then revert the implementation PR. Existing signal files may remain as historical derived artifacts or be moved to trash after operator approval. No upstream data or database rollback is needed. If the calculator fails, preserve the last successful pair while investigating.

## Open questions and risks

1. **Dossier promotion timestamp contract is missing (requires Tom/Quinn decision or upstream revision).** The evidence-layer draft describes promoted claims and run receipts but no machine-readable promotion event/timestamp. Recommendation: revise that upstream spec to expose stable `{ eventId, topic, promotedAt, source }` records. Do not infer promotions from Markdown or filesystem mtime.
2. **Final prior-context timestamp/field contract is not shipped.** This design proposes context-evaluation time plus `priorContextRefs`; implementation must map to the final knowledge-base artifact instead of locking the draft names into metric code.
3. **Cohort semantics need explicit approval.** Recommendation: current effective eligible state + context-evaluation timestamp, with `ingested` excluded and zero-denominator windows represented as `null`. This is auditable and avoids counting an item more than once, but the product spec does not name the timestamp.
4. **Decision-table sample thresholds are product policy.** This design recommends corpus established at 25 documents and a 10-item four-week floor for “retrieval path may be broken.” Tom/Quinn should confirm those constants during design approval; changing them later is straightforward and versioned.
5. **Workspace artifacts are outside Git.** Runtime output, cron metadata, and `infra/RUNBOOKS.md` cannot be completed by the implementation PR alone. The task must retain an explicit OpenClaw handoff until cron registration and the first artifact are verified.
6. **Production Pulse still depends on an external bookmark-state base URL.** The current Vite adapter is dev-only; this feature follows that shipped boundary rather than creating a new backend. If Pulse moves to hosted production, all bookmark state—including this signal—needs a bookmark-domain read service, not Tasks API.
