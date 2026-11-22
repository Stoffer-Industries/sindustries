---
status: draft
task_id: 38173f7d-a316-43a6-926f-9bcb706efe6c
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech design — deterministic tasks-board drag-and-drop e2e

## Intent

The Tasks board's HTML5 drag-and-drop has no deterministic e2e coverage. The one spec
that drives it (`apps/tasks/test/e2e/board-rejection.spec.js`) intermittently fails in CI
and reddens the aggregating `merge gate` for **every** PR in the repository — including
PRs whose diff cannot touch the tasks app.

This design makes the drag deterministic **in the test harness only**. It changes no
product behaviour, no API contract, and no data model.

## Coordinates

| | |
|---|---|
| Task | `38173f7d-a316-43a6-926f-9bcb706efe6c` — Make the tasks board drag-and-drop e2e deterministic |
| Task type | `code` (tech-design gate is satisfied by this doc + Quinn's structured `tech_design` approval) |
| Repo | `Stoffer-Industries/sindustries` |
| Branch | `task-38173f7d-board-rejection-e2e-determinism` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-38173f7d-board-rejection-e2e-determinism` |
| Design doc | `docs/specs/board-rejection-e2e-determinism-tech-design.md` (this file, on the branch) |
| Related prior work | `task-fb5c4e40-board-rejection-e2e` added the spec under task `fb5c4e40`; this task is the follow-up that makes it deterministic |

## Problem statement and evidence

The spec's failing assertion:

```js
await page.getByTestId('card-gated-task').dragTo(page.getByTestId('column-acceptance'));

expect(attempted).toEqual([{ status: 'acceptance' }]);
```

`attempted` was `[]` — the board's drop handler never issued the PATCH.

Observed failures (same test, same assertion, same failure text, two unrelated branches
in one day):

| CI run | PR / branch | Diff under test |
|---|---|---|
| `45072664754` | #1096 `chore/code-garden-2026-W46-gymtrack-callback-runbook-pointer` | comment-only in `apps/gymtrack/src/App.jsx` + a docs file |
| `45044755527` | `chore/code-garden-2026-W46-stable-hostname-design-contract` | docs/infra only |

The diff was never at fault: main's own run of that job passed, and the spec passes locally
on every attempt. Note that `apps/tasks/playwright.config.js` already sets
`retries: process.env.CI ? 1 : 0` — so each recorded failure is a failure **after a retry**,
i.e. the flake reproduces, it is not a one-off.

## Root cause analysis

### Mechanism A — `dragTo` does not guarantee HTML5 drag-event delivery order (CONFIRMED)

`locator.dragTo()` is a mouse-driven approximation of an HTML5 drag. Chromium's native
drag is driven by an out-of-process drag controller; the
`dragstart` → `dragover` → `drop` sequence crosses a process boundary, and `drop` can be
delivered before the page's `dragstart` handler has populated the payload.

The board reads the payload in `apps/tasks/src/App.jsx`:

```js
// L807-811 — column
onDragOver={(e) => e.preventDefault()}
onDrop={(e) => {
  const id = e.dataTransfer.getData('text/plain');
  if (id) patchTask(id, { status });
}}

// L834-836 — card
draggable={!isSelected}
onDragStart={(e) => {
  if (!isSelected) e.dataTransfer.setData('text/plain', task.id);
}}
```

If the drop lands before `setData` has run, `getData('text/plain')` returns `''`, the
`if (id)` guard short-circuits, `patchTask` is never called, no PATCH is issued, and
`attempted` stays `[]`. That is precisely the observed failure text, and it is
diff-independent — which is why it fires on a comment-only PR.

### Mechanism B — the assertion reads an async side effect with no wait (CONFIRMED, independent of A)

`attempted.push(...)` happens inside a Playwright `page.route` handler. The route handler
runs in the browser process *after* the drop handler's `fetch()` has been initiated.
`dragTo()` resolves when the mouse-up is dispatched; it does **not** wait for the
intercepted request to reach the route handler.

So even on a fully successful drag, `expect(attempted).toEqual([...])` is an immediate
assertion against a value that may not have been written yet. Mechanism B has the same
failure signature (`received []`) as mechanism A, which is why the CI log alone cannot
distinguish them. **Both must be fixed** — fixing only the drag wiring would leave the
assertion racy.

### Mechanism C — backend not up ("tasks-api failed to start") — RULED OUT for this spec

Every request the spec makes is intercepted by `page.route('**/api/v1/**')` and fulfilled
locally: `/auth/session` (401), `/task-types/feature/required-approvals`,
`GET /tasks`, `GET /tasks/gated-task`, and the PATCH (409 + the API's own message). The
spec never reaches the real tasks-api on `:4000`.

Independently: if the API had failed to start, the CI step
`Wait for tasks-api` (`.github/workflows/ci.yml`, `tasks-app-e2e` job) would have exited 1
**before** Playwright ran at all, so the suite would not have produced an assertion
failure. The echo in the CI log is therefore not the cause of `attempted === []`.
*(One cheap confirmation at implementation time: grep the specific failing run's
`/tmp/tasks-api.log` dump for the `Wait for tasks-api` step outcome.)*

### Mechanism D — card re-render mid-drag — RULED OUT

The card's React key is `task.id ?? \`${status}-${task.title}-${index}\``. Every routed GET
returns the same id, so a late detail fetch cannot remount the element under a different
key. A remount would surface as a Playwright "element is not attached to the DOM" error,
not a clean `[]`.

### Mechanism E — the `qa_agent` gate / the 409 body — RULED OUT

The API is mocked. The 409 and the QA-gate message are produced by the route handler in the
spec itself. A problem in the gate would fail the *toast* assertion, not `attempted`.

### Mechanism F — the 3s auto-refresh re-render — low risk, irrelevant to the payload

`useTasks` is configured with `refreshIntervalMs: 3000`. A refresh replaces the card, but
the React key is stable so the DOM node is reused, and the drop handler reads
`dataTransfer` — not the DOM — so a refresh cannot blank the payload. The deterministic
wiring removes any dependency on this timing anyway.

## Ownership boundary check

**Natural source of truth: the e2e test harness.** The board's drag behaviour (HTML5 DnD
with a `text/plain` payload carrying the task id) is the product contract and is already
documented in `apps/tasks/SPEC.md`. It is correct and stays unchanged.

- **Not the product code.** The obvious "make it deterministic in the app" option — carrying
  the dragged task id in React state instead of `dataTransfer` — would change the board's
  DnD mechanism. That is a behaviour change, it is explicitly excluded by AC3, and it would
  make the product conform to a test harness's limitation. Rejected.
- **Not the API.** The API is mocked in this spec; it cannot produce an empty request list.
- **Not the merge gate.** The merge gate is downstream of the flake, not a cause. Changing
  CI gating semantics is out of scope (see Open questions).
- **Durable harness boundary.** Two specs drive the same HTML5 DnD path today:
  `board-rejection.spec.js` (L90) and `happy-path.spec.js` (L89). Both carry mechanism A.
  The deterministic drag therefore goes in **one shared helper**
  (`apps/tasks/test/e2e/helpers/dragCardToColumn.js`) rather than being inlined into the
  one spec that failed. A future spec that needs to drag gets the deterministic path by
  default instead of copying `dragTo` again. This is the durable boundary, and it is about
  as cheap as the interim inline version — no shim is warranted.

**Service boundary guardrail:** no API route, database table/model, queue, cron, worker,
external integration, or cross-service dependency is added or changed. `docs/ARCHITECTURE.md`
is therefore not triggered by this change.

**Data model / API contract changes:** none.

## `.openclaw` boundary

None. The entire change lives inside `Stoffer-Industries/sindustries` under
`apps/tasks/test/`. No `~/.openclaw/` file is written (Rowan cannot write there).

## Implementation plan

### 1. New helper — `apps/tasks/test/e2e/helpers/dragCardToColumn.js` (new)

Per Playwright's own guidance for HTML5 drag-and-drop, dispatch the three drag events
explicitly and share **one** `DataTransfer` handle between them, awaiting each dispatch so
the ordering is enforced by the test, not by the browser's drag controller:

```js
export async function dragCardToColumn(page, cardTestId, columnTestId) {
  const card = page.getByTestId(cardTestId);
  const column = page.getByTestId(columnTestId);

  await expect(card).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());

  await card.dispatchEvent('dragstart', { dataTransfer });
  await column.dispatchEvent('dragover', { dataTransfer });
  await column.dispatchEvent('drop', { dataTransfer });

  return dataTransfer;
}
```

Properties this relies on:

- `dispatchEvent` resolves only after the event has been dispatched **and** the page's
  handlers for it have run, so the card's `onDragStart` → `setData('text/plain', task.id)`
  has definitely executed before `dragover`/`drop` are dispatched.
- The same `DataTransfer` instance is passed to all three events, so `getData` in the
  column's `onDrop` reads the store `setData` wrote. Mechanism A is eliminated *by
  construction*, not by timing luck.

### 2. `apps/tasks/test/e2e/board-rejection.spec.js` (modify)

- Replace `await page.getByTestId('card-gated-task').dragTo(page.getByTestId('column-acceptance'))`
  with `await dragCardToColumn(page, 'card-gated-task', 'column-acceptance')`.
- Replace the immediate assertion

  ```js
  expect(attempted).toEqual([{ status: 'acceptance' }]);
  ```

  with a retrying poll (mechanism B):

  ```js
  await expect.poll(() => [...attempted]).toEqual([{ status: 'acceptance' }]);
  ```

  `expect.poll` re-invokes the callback and re-serialises the value on each interval; the
  spread returns a fresh array so the in-place-mutated `attempted` is never compared by
  reference.

- Keep the rest of the spec as-is. The toast assertion and the two card-position
  assertions already use retrying matchers (`toContainText`, `toBeVisible`, `toHaveCount`),
  so they carry no timing assumption.

### 3. `apps/tasks/test/e2e/happy-path.spec.js` (modify — same race class, no ACs)

`happy-path.spec.js` L89 uses `card.dragTo(doing)`. Adopt the same helper so the repo has
one way to drive a board drag. No acceptance criteria attach to this file; it is a
same-mechanism sibling, and leaving a second `dragTo` in place would preserve the flake
class in the suite.

**Fallback if this turns out to be risky:** if `happy-path.spec.js` turns out to depend on
some native-`dragTo` behaviour, revert **only that file** to `dragTo` and ship the helper
with `board-rejection.spec.js` alone, recording the reason in the PR body. The AC-bearing
scope is unaffected either way.

### 4. Explicitly out of scope

- No change to `apps/tasks/src/**` — no product behaviour change (AC3).
- No change to `services/tasks-api/**`.
- No change to `.github/workflows/ci.yml` (see Open questions).
- No change to `apps/tasks/SPEC.md`: the board's user-visible behaviour is unchanged, and
  the spec's flow → e2e mapping stays valid.

## Test plan

No new product tests are required — the change is to the harness. The verification is
that the existing spec becomes deterministic and that the fix leaves the merge gate green.

### Acceptance-criterion verification matrix

| AC | Planned verification | Layer |
|---|---|---|
| **AC1** — no dependency on HTML5 drag-event delivery timing; drag is deterministic; the spec waits for the PATCH attempt | `apps/tasks/test/e2e/board-rejection.spec.js` uses `dragCardToColumn` (explicit `dragstart`/`dragover`/`drop` sharing one `DataTransfer`) and `expect.poll` instead of an immediate assertion. Proven by inspection: `git grep -n 'dragTo' -- apps/tasks/test` returns **no** `dragTo` call sites after the change. Green spec run. | e2e (Playwright) |
| **AC2** — 10 consecutive local passes; `tasks app e2e (ui + api + db)` green on 3 consecutive branch runs | Local: `for i in $(seq 1 10); do npm run test:e2e --workspace apps/tasks -- board-rejection.spec.js || break; done` — 10 consecutive green runs, with the loop output pasted into the PR body. CI: CI triggers on `pull_request` and pushes to `main` only, so a branch push does not start a run — the PR's run is the trigger and the three runs are explicit re-runs of the same job on the same head via `gh run rerun --job <job-id>`. All three run URLs go in the PR body. | e2e (Playwright) + CI |
| **AC3** — proves the PATCH was attempted and rejected, the API's own message reaches the user, the card stays in its column, and the fix is confined to test/drag wiring | In the spec: (a) `expect.poll(() => [...attempted]).toEqual([{ status: 'acceptance' }])` — the intercepted PATCH body; (b) `expect(toast).toContainText('qa_agent')` + `toContainText('Ash must approve')` — the API's own 409 message, via retrying matchers; (c) card still in `column-doing` and absent from `column-acceptance`, via retrying matchers. Scope: `git diff --name-only origin/main...HEAD` lists only paths under `apps/tasks/test/` — no file under `apps/tasks/src/` or `services/` is touched. | e2e + diff inspection |
| **AC4** — durable fix ships as its own PR, with repeat-run evidence in the body, verified to leave `merge gate` green | One PR, opened **draft** and converted to ready-for-review only after the implementation is complete; body carries the 10-run local transcript and the 3 CI run URLs; `## System Spec` section states that no behaviour-level doc changed and why; `[implementer-prs] <url>` posted as a task comment. Post-merge, observe `merge gate` green on the next unrelated PR's CI run (the gate aggregates `tasks app e2e (ui + api + db)`). | process + CI |

### Commands

```bash
# Local single-spec run (from the worktree)
npm run test:e2e --workspace apps/tasks -- board-rejection.spec.js

# 10 consecutive runs (AC2)
for i in $(seq 1 10); do
  npm run test:e2e --workspace apps/tasks -- board-rejection.spec.js || { echo "FAILED on run $i"; break; }
done

# Same loop for the sibling spec touched in step 3
for i in $(seq 1 10); do
  npm run test:e2e --workspace apps/tasks -- happy-path.spec.js || { echo "FAILED on run $i"; break; }
done

# Prove no dragTo call sites remain (AC1)
git grep -n 'dragTo' -- apps/tasks/test
```

## Risks

| Risk | Mitigation |
|---|---|
| `dispatchEvent` with a `dataTransfer` init depends on `DragEvent` construction with a supplied `DataTransfer` — a Chromium-family behaviour | CI installs Chromium (`npx playwright install --with-deps chromium`) and `apps/tasks/playwright.config.js` declares no `projects` block. Confirm at implementation time which browser the local run uses and, if it is not Chromium, pin `browserName: 'chromium'` for the run rather than assuming. The rest of the spec's assertions are browser-agnostic. |
| Adopting the helper in `happy-path.spec.js` could surface a pre-existing assumption in that spec | Run that spec 10× locally before the PR goes ready-for-review; if it is flaky for unrelated reasons, revert only that file (see step 3 fallback). |
| The synthetic `dragstart` produces no native drag image | Irrelevant to the assertions; noted so nobody "fixes" it later. |
| The merge gate may be counting a *retried* pass as green | CI sets `retries: 1` under `CI`. This is a CI-semantics question, not a cause of the flake, and changing it would affect every spec — see Open questions. Not changed here. |
| A reviewer may think the fix "hides" the race rather than removing it | The matrix in AC1/AC3 is the answer: the drag no longer depends on delivery order at all, and the assertion waits on the observed side effect rather than on a clock. |

## Open questions

1. **Should `retries: 1` in CI stay?** With `retries: 1`, a spec that flakes once passes the
   job on the retry and the merge gate reports green — i.e. CI can *mask* exactly this
   class of flake. Changing it is a CI-policy change affecting every spec in the repo and
   is out of scope here. Flagged for Tom: if the merge gate is meant to be a true flake
   detector, `retries: 0` for the e2e job is the setting that makes it one.
2. **Does the helper belong in `apps/tasks/test/e2e/helpers/` or in the existing
   `apps/tasks/test/e2e/fixtures/` directory?** `fixtures/` currently holds test data, not
   behaviour helpers. Proposal: `helpers/`. Cheap to change; noted so it is a decision
   rather than an accident.
3. **Is the same drag harness needed by other apps?** No other app in this repo drives
   HTML5 DnD today (checked `apps/` for `onDragStart`/`dataTransfer` consumers — only
   `apps/tasks/src/App.jsx`). If that changes, the helper should move to a shared package
   rather than being copied.
