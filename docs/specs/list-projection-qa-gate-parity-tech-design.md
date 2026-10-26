---
status: shipped
task_id: 7db08a30-38af-48f1-af5a-9fac8660cc08
product_spec: "n/a"
shipped_pr: 892
shipped_date: 2026-10-27
---

# List projection gate parity — dormant `qa_agent` gates in `GET /tasks`

## Product intent

The Tasks API list projection and the detail projection disagree about whether a
`qa_agent` workflow gate is outstanding. The documented contract
(`docs/systems/tasks.md`, "Attention owners and workflow gates") says:

> The `qa_agent` fallback is exposed only after Lobster's latest delivery-evidence
> sweep has cleared; while the latest Lobster state carries an unresolved
> delivery/progress failure, the gate remains dormant and the delivery assignee
> remains actionable.

The detail route honours that contract. The list route does not, and neither does
the `?workflowGateOwner=<name>` filter. This design fixes the list projection so
that all three read from one rule, without changing the documented contract and
without persisting gate state anywhere.

Observed impact (2026-10-27, live API): `GET /tasks?workflowGateOwner=Ash` returned
6 tasks, all `doing`; every one of them returns `workflowGates: []` from
`GET /tasks/:id`. The Tasks UI board consumes the list payload
(`apps/tasks/src/tasksApi.ts`) and renders the gate layer in
`apps/tasks/src/components/StackedAvatarGroup.jsx`, so board cards show an
`Ash`/`qa_agent` layer for a gate that is dormant, and the "my gates" filter
surfaces tasks that are not the named owner's to act on.

## Task, branch, worktree, repositories

| Item | Value |
| --- | --- |
| Task | `7db08a30-38af-48f1-af5a-9fac8660cc08` — "List projection over-reports dormant `qa_agent` gate (list/detail gate divergence)" |
| Task type | `code` (no product spec required; the task description is the product intent) |
| Branch | `task-7db08a30-list-projection-gate-parity` (from `origin/main`) |
| Worktree | `/Volumes/WD1/worktrees/quinn/task-7db08a30-list-projection-gate-parity` |
| Repository | `Stoffer-Industries/sindustries` (canonical checkout stays on clean `main`) |
| Service | `services/tasks-api` (owns the task domain) |
| Consumer app | `apps/tasks` (board UI) |

## Source of truth and ownership boundary

**Natural source of truth: the API-owned contract.** The rule "is the `qa_agent`
gate dormant?" is domain logic that already exists in exactly one place —
`deliveryEvidenceBlocksQa()` in `services/tasks-api/src/routes/tasks/_mapper.ts` —
and is consumed by the shared `mapTask()` projection. There is no database column
for gate state, and there must not be one: the task's own contract forbids
persisting gate ownership into `attentionOwners`, and `docs/systems/tasks.md`
states that gate ownership "is never copied into or persisted as an
attention-owner row".

Therefore the durable fix is **one rule, one input, two projections**:

- one shared module owns the dormancy rule and the marker vocabulary it reads;
- the list route feeds that rule the same evidence the detail route feeds it;
- the `?workflowGateOwner` filter selects on **derived gates**, not on a SQL
  approximation of them.

No interim shim, no persisted flag, no second source of truth.

### Root cause — there are two layers, and fixing only one leaves the bug

**Layer 1 — the list payload.** The list route's Prisma `findMany` include block
(`services/tasks-api/src/routes/tasks.ts`) selects `tags`, `approvals`,
`attentionOwners` and dependencies — **not** `comments`. `mapTask()` derives gates
from `task.comments`, so `deliveryEvidenceBlocksQa()` sees an empty array, finds
no `[lobster-state]` marker, returns `false`, and the `qa_agent` gate is never
filtered out of `derivedGates`. The detail route's `findFirst` include block
*does* select `comments`, so it suppresses the gate correctly.

**Layer 2 — the `?workflowGateOwner` filter.** `buildWorkflowGateOwnerWhere()`
(`services/tasks-api/src/routes/tasks/_deps.ts`) builds a **Prisma `where` clause**
that matches on `status` + `taskType` + absence of an approved `qa_agent` approval
row. It runs in the database and cannot see comments at all, so it is an
over-approximation of "has a live gate owned by X". **Fixing Layer 1 alone does not
fix AC2**: the filter would still return tasks whose derived `workflowGates` is
empty, so the filtered result would still disagree with the payload it is
filtering.

Both layers must be addressed in the same change, which is why this is one design
rather than two.

## Implementation plan

### 1. New shared module — `services/tasks-api/src/routes/tasks/_deliveryEvidence.ts`

Owns the dormancy rule and the marker vocabulary, together, so the rule and the
database query cannot drift apart.

- `DELIVERY_EVIDENCE_MARKERS` — the single constant listing every comment marker
  the rule reads: `[lobster-state]`, `[feature-task-progress-checklist]`,
  `[code-task-progress-checklist]`, `[feature-task-blocked]`,
  `[code-task-blocked]`, `[qa-agent-blocked]`, `[qa-agent-deferred]`,
  `[implementer-prs]`, `[rowan-prs]`.
- `deliveryEvidenceCommentWhere()` — a Prisma `where` fragment selecting only
  comments whose `body` **contains** any of those markers.
  `contains` (not `startsWith`) is required: the rule matches some markers at
  line level inside a comment (`text.split('\n').some(line => line.trimStart()
  .startsWith(tag))`), so `contains` is the superset that preserves the rule's
  semantics exactly. Prisma's default `contains` is case-sensitive, matching the
  rule's case-sensitive matching.
- `deliveryEvidenceBlocksQa(comments)` — the rule, moved out of `_mapper.ts`
  unchanged in behaviour.

**Why one constant matters:** the query and the rule are two readers of the same
vocabulary. A marker added to the rule but not to the query would silently break
list/detail parity; a marker added to the query but not to the rule would silently
change the gate. One constant, used by both, removes that class of drift.

**Parity invariant (why the marker subset is sufficient):** the rule only ever
reads marker-bearing comments — it scans backwards for the latest
`[lobster-state]`, checks for `[implementer-prs]`/`[rowan-prs]` after it, then
scans backwards from it for the checklist/blocked/deferred markers. A comment that
contains no marker is skipped in the scan and cannot change the outcome. So
`deliveryEvidenceBlocksQa(markerSubset) === deliveryEvidenceBlocksQa(allComments)`.
This is asserted by test, not assumed.

### 2. `_mapper.ts` — use the shared rule

`mapTask()` keeps its current signature and its current behaviour; it reads
`task.comments` exactly as it does now, and the list route supplies the marker
subset in that field. `deliveryEvidenceBlocksQa` is removed from `_mapper.ts` in
favour of the shared module (no wrapper, so there is one implementation).

### 3. List route — `services/tasks-api/src/routes/tasks.ts`

- Add the marker-filtered `comments` include to the list `findMany` block, using
  `deliveryEvidenceCommentWhere()` and the same ordering the detail route uses
  (`[{ createdAt: 'asc' }, { id: 'asc' }]`). This satisfies **AC4**: the query
  selects only the comments needed to evaluate delivery evidence, not the full
  comment history of every listed task.
- **The list response shape must not change.** Today the list payload carries
  `comments: []` for every task (the list never loaded comments, and `mapTask`
  defaults to `[]`). Once the list loads marker comments, `mapTask` would start
  emitting those comments into the payload — a silent response-shape change and a
  payload-size regression. The route therefore explicitly restores
  `comments: []` on the list payload. This is called out in the PR body because
  it is easy to miss in review and easy to break with a later refactor.
- **AC2 — `?workflowGateOwner`:** keep `buildWorkflowGateOwnerWhere()` as the SQL
  *candidate* pre-filter (it is indexable and encodes the status/task-type/approval
  policy), and add a **post-derivation narrowing** step: after mapping, keep only
  tasks whose derived `workflowGates` actually contain an outstanding gate owned by
  the requested owner (case-insensitive). The filter now selects on derived gates,
  so it agrees with the payload by construction.
- **Pagination under-fill (the cost of the narrowing):** the SQL pre-filter is an
  over-approximation, so a page can contain fewer than `limit` surviving tasks.
  The route therefore fetches in batches and keeps advancing past the last
  *emitted* task's cursor until the page is full or the candidate source is
  exhausted; `hasNextPage` reflects whether candidates remain. The loop is
  bounded (`MAX_FILTER_BATCHES = 10`) and logs a warning if the bound is reached,
  so a pathological data set cannot hang the request.
  The cursor contract is unchanged: the cursor is the last emitted task's
  `(createdAt, id)`, and because narrowing only *removes* rows from a
  `(createdAt desc, id desc)` ordering, continuing from that cursor skips nothing.
- The detail route is **not** changed: it already loads comments and its response
  exposes them. Its derived gates will now be produced by the same shared rule.

### 4. `apps/tasks` — `apps/tasks/src/components/StackedAvatarGroup.test.jsx`

Add the **AC5** component test. `buildStackedOwnerLayers()` is a pure function of
the task payload, so the board-side assertion is that a list payload for a
delivery-evidence-blocked task (no `qa_agent` gate in `workflowGates`) yields no
`workflow-gate` layer entry.

### 5. Docs

- `docs/systems/tasks.md` — extend the existing "Attention owners and workflow
  gates" section (and the `?workflowGateOwner` filter description) with two
  sentences: both projections derive the gate from the same rule and the same
  evidence, and the filter selects on derived gates. **No new system doc** — the
  contract already lives here, and the doc taxonomy's consolidation bias applies.
- `apps/tasks/SPEC.md` — check whether the board's gate-layer behaviour is
  described there; this is a bug fix that restores documented behaviour, so the
  expectation is a wording clarification, not a behaviour change. Recorded in the
  PR body either way.

## API contract changes

| Surface | Change |
| --- | --- |
| `GET /tasks` response | **None.** The payload gains no fields and loses none; `comments` stays `[]` per task. Only `workflowGates` values change — they become correct. |
| `GET /tasks/:id` response | **None.** Unchanged shape; gate values become correct (they already were). |
| `GET /tasks?workflowGateOwner=<name>` | **No contract change** — the filter is corrected to match its own documented meaning ("tasks whose exact current-stage outstanding gate is owned by `<name>`", `docs/systems/tasks.md`). The result set shrinks to the tasks that actually have that gate. |
| Data model | **None.** No schema change, no migration, no new column, no persisted gate state. |

## Workflow, cron, and skill changes

None. The Lobster's comment vocabulary is unchanged; this work only *reads* it.

## `.openclaw` boundary notes

None. No `.openclaw/` file, credential, cron or skill change is required. The
only agent-facing surface affected is the Tasks API response, which is owned by
this repository.

One consumer note: `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`
re-hydrates each list hit through the detail endpoint, which is why the queue has
not surfaced this divergence. That script is **not** changed here — after this
fix its re-hydration is redundant *for gates* but still serves its other
purposes.

## Test plan

Existing suites to run unchanged: `services/tasks-api` vitest suite, `apps/tasks`
vitest suite, and the route-layer prisma-mock pattern used by
`services/tasks-api/test/workflowGatesRouteLayer.test.ts` and
`services/tasks-api/test/read-endpoints.test.ts`.

New tests:

| Test | File | Layer |
| --- | --- | --- |
| `deliveryEvidenceBlocksQa` over a marker-only subset equals the same call over the full comment list (fixture corpus: failed state + checklist, failed state + fresh `[implementer-prs]`, failed state + `[qa-agent-blocked]`, clean state, no state at all) | new `services/tasks-api/test/deliveryEvidence.test.ts` | unit |
| List and detail return the same `workflowGates` for a `doing` task whose latest `[lobster-state]` carries a `failureFingerprint` and which also carries a delivery-checklist comment | new/extended `services/tasks-api/test/read-endpoints.test.ts` | route layer (prisma mock) |
| `?workflowGateOwner=Ash` excludes the delivery-evidence-blocked task and includes the task with a live `qa_agent` gate | same file | route layer |
| A `doing` task whose latest `[lobster-state]` has no `failureFingerprint` still reports the outstanding `qa_agent` gate in list payload, detail payload **and** filter result | same file | route layer |
| The list `findMany` call carries the marker-filtered `comments` include (and not an unfiltered `comments: true`) | same file (assert on the prisma mock's call args) | route layer |
| A list payload for a delivery-evidence-blocked task renders no workflow-gate layer | `apps/tasks/src/components/StackedAvatarGroup.test.jsx` | component |

### AC verification matrix

| AC | Verification | Layer | Fails on current `main`? |
| --- | --- | --- | --- |
| AC1 — list/detail gate parity | Same task fixture through `GET /tasks` and `GET /tasks/:id`; assert identical `workflowGates` and no outstanding `qa_agent` gate | tasks-api route layer | **Yes** — list omits `comments`, so it reports the gate |
| AC2 — `?workflowGateOwner` stops over-reporting | Blocked task absent from the `Ash` result; live-gate task present | tasks-api route layer | **Yes** — the SQL clause cannot see comments |
| AC3 — no over-correction | Clean-state `doing` task still reports the outstanding `qa_agent` gate in list payload, detail payload and filter result | tasks-api route layer | No — this is the over-correction guard for AC1/AC2 |
| AC4 — bounded comment access | Assert on the prisma mock's `findMany` args: `comments` is present with a `where` clause, and no unfiltered comment selection is used. The query is cited in the PR body | tasks-api route layer (assertion) | **Yes** — no `comments` include exists today |
| AC5 — board renders no gate layer | `buildStackedOwnerLayers()` on the list payload of a delivery-evidence-blocked task yields no `workflow-gate` entry | apps/tasks component | **Yes** — the payload today carries the gate |

**E2E note for AC5.** A browser E2E is disproportionate here: the board's gate
layer is rendered by a pure function of the payload, so the component test
exercises the rendering path directly, and the server-side suppression that the
component depends on is covered by the AC1/AC2 route-layer tests. The app's
existing e2e suite (`apps/tasks/src/e2e`) is not extended for this change; the
reason is recorded here rather than assumed.

## Risks and rejected alternatives

1. **Pagination under-fill after the filter narrowing.** Handled by the bounded
   batch loop. The residual risk is a page that is short when the bound is hit;
   the route logs a warning in that case rather than silently returning a short
   page.
2. **Marker drift between rule and query.** Handled by one constant plus the
   parity unit test over the fixture corpus.
3. **Comment query cost.** The `contains` filter is not indexable, so the list
   route scans candidate comment rows per listed task. The result is bounded to
   marker-bearing comments per task, but the row count scales with page size
   (`DEFAULT_LIMIT = 100`, `MAX_LIMIT = 10000`). At the maximum limit this is the
   same order as the existing `tags`/`approvals`/`attentionOwners` includes and
   is proportionate — but a caller asking for 10,000 tasks now also pays for
   their marker comments. Worth watching, not worth pre-emptively changing the
   limit policy here.
4. **REJECTED — express dormancy in SQL** (e.g. `comments: { none: { body:
   { contains: '"failureFingerprint"' } } }`). Rejected because the rule reads the
   *latest* `[lobster-state]` and several markers at line level, which SQL cannot
   express; a `contains` approximation would over-*exclude* tasks whose earlier
   state carried a fingerprint but whose latest does not — replacing a
   false-positive filter with a false-negative one, which is the worse failure for
   a "my gates" queue.
5. **REJECTED — drop the SQL pre-filter and filter purely in JS.** Rejected
   because it would scan every task in the filtered status class on each request.
   The pre-filter plus narrowing keeps the database work proportional.
6. **REJECTED — persist a `qaAgentDormant` flag on the task.** Rejected: it
   creates a second source of truth beside the comment-derived rule and the task
   contract forbids persisting gate state.
7. **Risk — the list payload's `comments: []` is easy to break.** Any future
   change that maps list tasks without restoring `comments: []` silently starts
   exposing marker comments in list responses. Mitigation: the restore is one
   explicit step in the route and is called out in the PR body.

## Open questions for Quinn

1. **Should the `?workflowGateOwner` filter eventually become a pure derived-gate
   filter with no SQL pre-filter?** The current design keeps the SQL pre-filter
   for cost reasons and adds narrowing. If the batch loop proves noisy in
   practice, the alternative is a single derived-gate query path (more
   expensive, simpler pagination). This design takes the cheaper path; flagging
   the trade-off rather than pre-empting it.
2. **Should the list payload ever expose comments?** Today it exposes `[]` for
   every task, and this design preserves that. If the board needs recent comment
   text on cards, that is a separate, deliberate payload change — not something
   to smuggle in as a side effect of fixing the gate parity.
3. **Does the `agent_task_queue.py` re-hydration become dead weight after this
   fix?** Partly — its gate re-hydration becomes redundant, but it still serves
   other list/detail differences. Left untouched here; worth a look if a future
   change touches that script.

## Out of scope

- Changing the gate policy itself (who owns `qa_agent`, when it is actionable).
- Changing the Lobster's comment vocabulary or its evidence rules.
- Persisting or exposing gate state in `attentionOwners`.
- Changing the detail route's response shape or its full comment load.
- The board's rendering of attention-owner layers (only the gate layer is in
  scope).
