---
status: draft
task_id: 5e35dc25-aed5-4064-8f11-a99413d18612
product_spec: n/a (internal tooling — see task description)
shipped_pr: null
shipped_date: null
---

# Migrate Ash's mechanical verify.ts checks into the lobster; keep Ash for semantic AC judgment only

## Links

- Task: `5e35dc25-aed5-4064-8f11-a99413d18612`
- Task API: `http://localhost:4001/api/v1/tasks/5e35dc25-aed5-4064-8f11-a99413d18612`
- Sibling task (Ash gate design + provisioning): `f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47`
  (`Add Ash: automated QA-verifier agent gate between doing and acceptance`) — its tech design at
  `docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md` defines the lobster-side `qa_agent`
  gate that this PR's new mechanical checks plug into.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `migrate-ash-mechanical-checks` (from `origin/main`)
- Worktree: `~/workspace/worktrees/migrate-ash-mechanical-checks`
- Primary code surfaces:
  - `agents/workflows/feature-task/src/ac_parsing.rs` — new mechanical-evidence check functions
  - `agents/workflows/feature-task/src/main.rs` — wire checks into `verify_delivery`; move
    `ensure_qa_agent_gate` from unconditional to post-mechanical-pass
  - `agents/workflows/feature-task/src/main.rs` — add `TestRunner` trait + `PnpmTestRunner` impl
    so the lobster can spawn `pnpm test --filter <name>` for cited test names
  - `agents/workflows/feature-task/test/mechanical_evidence.rs` — ported unit tests from Ash
  - `agents/workflows/feature-task/test/verify_delivery_mechanical.rs` — gate-ordering integration tests
  - `agents/ash/src/verify.ts` — slim to semantic-only (drop mechanical `checkTestId`,
    `checkNotTested`, `checkPrReference`, `extractAcEvidence`, `parseEvidenceTag`,
    `runAllAcChecks`; add a small `verifySemantic` orchestrator)
  - `agents/ash/test/verify.test.ts` — delete mechanical tests (ported to lobster); add
    semantic-judgment tests
  - `agents/ash/README.md` — update "what Ash does" section to reflect semantic-only scope
- Touched docs (no new system doc — extends `docs/systems/ash.md` and `docs/systems/tasks.md`):
  - `docs/systems/ash.md` — rewrite "mechanical verification" section to clarify
    semantic-only scope and point at the lobster-side mechanical gate
  - `docs/systems/tasks.md` — note that the lobster's `verify_delivery` gate now performs
    cited-file-existence + cited-test-pass checks before the `qa_agent` gate is created

## Product intent (one paragraph)

Ash's `qa_agent` gate currently runs entirely inside her own agent process (`agents/ash/src/verify.ts`):
cited-file existence, cited-test pass/fail, and evidence-regex matching against the PR diff. None of that
is reasoning — it's fact-checking against objective state (the diff, CI results) — the same category of
check the lobster already does natively for AC-checkbox text
(`agents/workflows/feature-task/src/main.rs`, `body_has_checked_acceptance` and friends in
`ac_parsing.rs`). Splitting mechanical checks into a separate agent-run codebase adds a credential/auth
seam that has already caused two live incidents in one day (missing prodlike service credential, and a
`FORGEABLE_APPROVAL_OWNER` bug that made the `qa_agent` approval structurally impossible to grant). It
also means the assignee doesn't get the immediate deterministic must-fix feedback the lobster is
designed to give — they wait on Ash's heartbeat cycle instead.

Move the mechanical portion of `verify.ts`'s checks into the lobster's `doing → acceptance` gate, so
failures surface the same way every other lobster gate failure does. Keep Ash's agent invocation only
for the residual judgment call — does the diff actually satisfy the AC's intent, not just its literal
text — and only after the mechanical gate has already passed.

## Ownership boundary check

**Natural source of truth: shared package / cross-app contract** — the lobster already owns the
`doing → acceptance` transition and the per-AC evidence parsing (`ac_parsing.rs`). Adding mechanical
checks there keeps a single source of truth for "what counts as evidence-verified" and removes the
separate TS codebase that has been the source of the credential/auth incidents.

Concretely:

- The Rust `parse_evidence` in `ac_parsing.rs:91-117` is **already more correct** than Ash's TS regex
  in `verify.ts:46-50` — the Rust regex recognises all four evidence types with optional emoji prefix
  and tolerates nested parens. Mechanical checks should consume the Rust parser, not duplicate the
  TypeScript one.
- `ac_parsing.rs:280-326` (`task_ac_vs_open_pr_failures`) already establishes the per-task subsection
  scoping pattern (`### Task <id>` headings). The new mechanical-evidence failures reuse the same
  scoping so a multi-task PR only checks the current task's ACs.
- The lobster already fetches the PR's changed-files list via `pr_changed_files(url)` in `main.rs:4017`
  using `gh pr view --json files --jq ".files[].path"`. The new mechanical-evidence check consumes
  that list, just like `clippy_evidence_failures` does today for the clippy command gate.
- The lobster already shells out to `pnpm test` for the clippy-evidence gate (via `Command::new(...)`
  in `clippy_evidence_failures`). Adding a `TestRunner` trait lets the new cited-test-pass check use
  the same shell-out pattern with an injectable runner for tests.

**No interim shim.** The alternative — keeping mechanical checks in Ash and adding a "lobster mirror"
that calls into the TS code — would create two sources of truth for the same checks, doubling the
maintenance cost and reintroducing the credential seam this PR is trying to close.

## `.openclaw` boundary notes

AC3 in the task explicitly notes that Ash's `verify.ts` no longer needs its own service credential /
auth principal for the mechanical checks. **Quinn owns Ash's agent identity** at
`~/.openclaw/workspace/agents/ash/` (sessions, model pin, GitHub PAT, Telegram account, heartbeat/cron
wiring, IDENTITY.md). Rowan:

1. **Does** edit `agents/ash/src/verify.ts` in the repo — this is pure code, not agent identity.
2. **Does** slim `verify.ts` from mechanical + semantic to **semantic only**.
3. **Does** delete the mechanical-test cases from `agents/ash/test/verify.test.ts` (ported to lobster).
4. **Does NOT** touch `~/.openclaw/`, `agents/ash/`'s `package.json` deps, Ash's per-agent tokens,
   Ash's cron, or Ash's heartbeat wiring. Those are Quinn's provisioning, not code.
5. **Does NOT** post a fresh `[openclaw-needed]` comment. The `[openclaw-needed]` already on task
   `f6a4d56a` (PR #2 of that task) still stands; this PR doesn't change the bootstrap ask.

Ash's `ASH_GITHUB_TOKEN` and `ASH_TASKS_API_APPROVAL_TOKEN` are still **required** after this PR:
the semantic check reads the PR diff (needs GH token) and posts the `qa_agent` approval (needs Tasks
API token). What's gone is the separate "Ash runs mechanical checks before approving" path that
required both tokens to be live in Ash's process **before** the assignee could see any deterministic
feedback.

## Implementation plan

### 1. `agents/workflows/feature-task/src/ac_parsing.rs` — new mechanical-evidence check functions

Add a sibling to `task_ac_vs_open_pr_failures` that runs the deterministic file-existence + test-execution
checks against each per-task AC's parsed `Evidence`. Reuse the same per-task subsection carving pattern
and the same `Evidence` enum.

```rust
/// Mechanical evidence check failures for the `doing -> acceptance` gate.
///
/// Returns one failure string per problem, or an empty Vec if every AC's
/// evidence is mechanically satisfied (cited file present in the diff,
/// cited test passes, or non-code evidence trivially passes). Failures
/// here surface as `[feature-task-progress-checklist]` comments via the
/// existing `transition_or_block` path — they are the deterministic
/// "fix this before Ash runs" feedback, structurally identical to the
/// existing `verify_pr_acs_failures` pattern.
pub(crate) fn mechanical_evidence_failures(
    task_id: &str,
    task_acs: &[(String, String)],   // (label, description) pairs from task_description_acs
    body: &str,
    pr_files: &[String],             // from pr_changed_files(url)
    test_runner: &dyn TestRunner,    // injectable; PnpmTestRunner in production
) -> Vec<String> {
    // ... reuse subsection scoping from task_ac_vs_open_pr_failures ...
    // For each AC's parsed Evidence:
    //   - TestId(file_path ending in *.test|spec.*): assert pr_files contains it
    //   - TestId(test_name): test_runner.run(name) -> assert exit 0
    //   - NotTested { reason } matching file-path regex: assert pr_files contains it
    //   - Pr { reference } matching file-path: assert pr_files contains it
    //   - NotCode: pass (no mechanical surface)
}
```

The `TestRunner` trait lives in `ac_parsing.rs` (or `main.rs` — see step 3) and is trivial:

```rust
pub(crate) trait TestRunner {
    fn run(&self, test_name: &str) -> Result<TestOutcome, String>;
}

pub(crate) struct TestOutcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
```

The cited-file regex (`/\.(test|spec)\.[mc]?[jt]sx?$/i` from Ash's `verify.ts:101`) and the
file-path-or-PR-ref heuristic from Ash's `verify.ts:148-167` are ported verbatim so the lobster's
behaviour is a strict superset of Ash's mechanical behaviour today.

### 2. `agents/workflows/feature-task/src/main.rs` — `PnpmTestRunner` + verify_delivery wiring

Add the production `TestRunner` impl:

```rust
pub(crate) struct PnpmTestRunner;

impl TestRunner for PnpmTestRunner {
    fn run(&self, test_name: &str) -> Result<TestOutcome, String> {
        let output = Command::new("pnpm")
            .args(["test", "--filter", test_name, "--", "--reporter=basic"])
            .output()
            .map_err(|e| format!("spawn pnpm test failed: {e}"))?;
        Ok(TestOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
```

Then change `verify_delivery` (lines 737-879) to:

1. Run existing structural checks (`body_has_checked_acceptance`, `verify_pr_acs_failures`,
   `task_ac_vs_open_pr_failures`, clippy, workstreams) into the `failures` vec — **unchanged**.
2. **NEW**: For the latest PR, call `ac_parsing::mechanical_evidence_failures(task_id, task_acs,
   body, &pr_changed_files(url), &PnpmTestRunner)` and push each result into the same `failures` vec.
3. **If `failures` is non-empty**: jump straight to `transition_or_block(...)` with the existing
   `[feature-task-progress-checklist]` prefix. **Do not** call `ensure_qa_agent_gate` yet — Ash
   shouldn't run against a task that hasn't passed the mechanical gate.
4. **If `failures` is empty**: call `ensure_qa_agent_gate(&args, &env)` and re-fetch the task
   (this is the move from line 770 in the current code).
5. **Then** the existing `qa_agent_verified_failures(&env.task)` short-circuit fires if Ash hasn't
   approved yet. The `[qa-agent-blocked]` comment stays as-is.
6. **Otherwise** `transition_or_block` promotes to `acceptance`.

Net effect: mechanical failures are reported with the same `[feature-task-progress-checklist]` pattern
every other lobster gate failure uses, the assignee gets immediate deterministic feedback (no waiting
on Ash's cron), and Ash only runs after mechanical passes (saves Ash's CI budget on tasks that would
have failed mechanical anyway).

### 3. Gate ordering comment block

Add a comment block above the new step-2 call explaining the **mechanical-first → ensure-gate →
qa-agent-approval** ordering so the next reader doesn't re-introduce the old "ensure on every sweep"
behaviour:

```rust
// Mechanical-first gate ordering (task 5e35dc25):
// 1. Mechanical checks (file existence + test pass) → push to `failures`.
// 2. If `failures` non-empty, return transition_or_block early — no
//    qa_agent gate row, Ash doesn't run, assignee fixes and retries.
// 3. Only on `failures.is_empty()` do we ensure the qa_agent row exists,
//    then check qa_agent_verified. Ash runs semantic-only against the
//    already-cleaned PR.
```

### 4. `agents/ash/src/verify.ts` — slim to semantic-only

Delete the mechanical functions:

```ts
// Delete these — moved to lobster:
parseEvidenceTag()           // verify.ts:48
extractAcEvidence()          // verify.ts:62
checkTestId()                // verify.ts:84
checkNotTested()             // verify.ts:118
checkPrReference()           // verify.ts:131
checkNotCode()               // verify.ts:125 (always passes; trivial)
checkAcEvidence()            // verify.ts:172
runAllAcChecks()             // verify.ts:186
```

Keep:

- `Types` block (`Evidence`, `AcEvidence`, `PrFile`, `PrSummary`, `TaskSummary`, `CheckResult`,
  `Deps`, `VerifyOutcome`) — semantic checks still need `PrSummary` (diff + body) and
  `TaskSummary` (current state).
- `parseAcLine()` line regex (`AC_LINE_RE`) — needed to walk PR-body ACs for semantic judgment.
- `verifySemantic(taskId, prUrl, deps)` — new orchestrator. Reads PR body + diff, walks each AC,
  calls a semantic-judgment function per AC. The judgment function's signature is left as a
  **placeholder** for the design pass Quinn owns; the structural shape is:

  ```ts
  /**
   * Judge whether the PR's diff actually satisfies the AC's intent, not
   * just its literal text. The lobster's mechanical gate has already verified
   * file existence and test execution — this is the residual judgment.
   *
   * Implementation: Quinn owns. Recommended approach is an LLM call against
   * the diff + AC text with a strict "intent satisfied: yes/no" JSON
   * response, deterministically reproducible by setting temperature=0 and
   * recording the model + prompt version. Alternative deterministic
   * approaches (e.g. extracted function/class symbols compared against AC
   * claim keywords) are acceptable when LLM budget is a concern.
   */
  async function judgeAcIntent(
    ac: AcLine,
    diffText: string,
    deps: SemanticDeps,
  ): Promise<{ ok: true } | { ok: false; reason: string }> { /* Quinn implements */ }
  ```
- The CLI entry — unchanged shape (`--task-id`, `--pr-url`, env vars). Ash's cron invocations
  don't change; only the body shrinks.

### 5. `agents/ash/test/verify.test.ts` — port mechanical tests, add semantic placeholder

- Delete all `parseEvidenceTag`, `extractAcEvidence`, `checkTestId`, `checkNotTested`,
  `checkPrReference`, `checkNotCode`, `checkAcEvidence`, `runAllAcChecks` test cases — these
  are ported to the lobster (step 7).
- Add placeholder semantic tests that pin the **contract** Quinn will implement:
  - "verifySemantic returns `ok: true` when intent matches" — uses a fake `judgeAcIntent` returning
    `{ok: true}`.
  - "verifySemantic returns `ok: false` with reason when intent mismatches" — fake returns
    `{ok: false, reason: "AC2 implementation handles the happy path but not the error case mentioned in the AC text"}`.
  - "verifySemantic posts `[qa-agent-verified]` when all ACs pass" — verifies the comment shape
    stays machine-parseable.
  - "verifySemantic posts `[qa-agent-blocked]` with the failing AC's reason" — verifies the failure
    shape stays machine-parseable.

These are pin-the-contract tests; Quinn's real semantic-judgment implementation will replace the
fake.

### 6. `agents/ash/README.md` — update scope

Replace the "structural verification in this file is what Ash will run" paragraph with a new
paragraph:

> After PR #2 of task `5e35dc25`, `verify.ts` is **semantic-only**. The lobster's
> `doing → acceptance` gate (see `agents/workflows/feature-task/src/main.rs:737`) runs the
> mechanical checks (cited-file existence, cited-test pass/fail, evidence-text matching against
> the PR diff) before the `qa_agent` gate is created. Ash runs `verify.ts` only against
> mechanically-clean PRs and judges whether the diff actually satisfies the AC's intent, not
> just its literal text. If the lobster's mechanical gate is failing on your task, the
> `[feature-task-progress-checklist]` comment on the task already tells you exactly what to fix —
> you don't need Ash to run for deterministic feedback.

### 7. `agents/workflows/feature-task/test/mechanical_evidence.rs` — port Ash's mechanical tests

Port the following test cases from `agents/ash/test/verify.test.ts`:

| Ported test | Source (Ash `verify.test.ts`) |
|---|---|
| `checkTestId` happy path — file path in PR diff | `checkTestId_*` cases |
| `checkTestId` failure — non-test extension | `checkTestId_*` cases |
| `checkTestId` failure — file not in PR diff | `checkTestId_*` cases |
| `checkNotTested` happy path — file in PR diff | `checkNotTested_*` cases |
| `checkNotTested` failure — file not in PR diff | `checkNotTested_*` cases |
| `checkNotCode` always passes | `checkNotCode_*` cases |
| `checkPrReference` happy path — `#<n>` ref | `checkPrReference_*` cases |
| `checkPrReference` happy path — URL ref | `checkPrReference_*` cases |
| `checkPrReference` failure — file not in PR diff | `checkPrReference_*` cases |
| `runAllAcChecks` — mixed pass/fail across multiple ACs | `runAllAcChecks_*` cases |
| `extractAcEvidence` — multi-AC PR body parsing | `extractAcEvidence_*` cases |

Each Rust test uses a fake `TestRunner` (`struct AlwaysPassTestRunner; struct AlwaysFailTestRunner;`)
instead of shelling out to `pnpm`, keeping the suite hermetic.

### 8. `agents/workflows/feature-task/test/verify_delivery_mechanical.rs` — gate-ordering tests

Three integration tests that exercise the full `verify_delivery` flow with the new ordering:

- **AC1 gate-ordering**: task in `doing` with a merged PR whose cited test file is **not** in the
  diff → `verify_delivery` returns `criteria_met: false`, action `a
  `"verify_delivery_qa_agent_blocked"` is **not** taken (lobster short-circuits on mechanical
  failures BEFORE `ensure_qa_agent_gate`), and no `qa_agent` TaskApproval row was created.
- **AC2 gate-ordering**: task in `doing` with a merged PR whose cited test passes AND `qa_agent`
  row is missing → `verify_delivery` calls `ensure_qa_agent_gate`, returns `criteria_met: false`,
  action `taken = "verify_delivery_qa_agent_blocked"`, and posts a `[qa-agent-blocked]` comment
  with the generic "qa_agent approval is missing" reason.
- **AC3 / AC4 happy-path**: task in `doing` with a merged PR whose cited test passes AND
  `qa_agent` row is `approved` → `verify_delivery` transitions to `acceptance` and the existing
  `accepted` gate is surfaced.

### 9. `docs/systems/ash.md` + `docs/systems/tasks.md` — extend existing system docs

**No new system doc.** Per `CONVENTIONS.md`, prefer extending existing high-level docs over
creating new ones.

- `docs/systems/ash.md` — rewrite the "Mechanical verification" section to clarify Ash's new
  semantic-only scope; cross-link `agents/workflows/feature-task/src/main.rs:737` as the source
  of the mechanical checks.
- `docs/systems/tasks.md` — under the "feature-task workflow" section, note the new
  mechanical-evidence gate ordering: mechanical → ensure-gate → qa-agent-approval → transition.

## Data model changes

| Change | Surface | Risk |
|---|---|---|
| `ac_parsing.rs` gains `mechanical_evidence_failures()` + `TestRunner` trait | `agents/workflows/feature-task/src/ac_parsing.rs` | None — pure additions |
| `main.rs::verify_delivery` reorders: mechanical → ensure-gate → qa-agent-check | `agents/workflows/feature-task/src/main.rs:737-879` | Behavioural change: `ensure_qa_agent_gate` no longer called on every sweep. Old behaviour (row always exists) replaced with new behaviour (row only exists after mechanical passes). Tasks currently sitting with a `qa_agent` row outstanding but failing mechanical will see the row persist (we don't delete existing rows — see Risks) |
| `agents/ash/src/verify.ts` slimmed: mechanical functions deleted | `agents/ash/src/verify.ts` | None — pure removals |
| `agents/ash/test/verify.test.ts` test cases ported | `agents/ash/test/verify.test.ts` | None — test-only |

**No schema changes.** No `services/tasks-api` changes. No `ApprovalType` enum changes (the
`qa_agent` value added in PR #1 of task `f6a4d56a` is what this PR's gate-creation logic depends on).

## API contract changes

**None.** The Tasks API surface is unchanged. The lobster's behaviour change is internal:
`ensure_qa_agent_gate` is now conditional on `failures.is_empty()` rather than unconditional, but
the API calls are the same.

## Workflow / cron / skill changes

- **Lobster cron (unchanged):** the existing sweep picks up the new predicate order without
  config change. The lobster fires `verify_delivery` every sweep; the new ordering is internal to
  that function.
- **Ash cron (Quinn-owned, unchanged):** the cron cadence is unchanged. Ash still fires every
  ~15 minutes; what's different is that the row it targets (`qa_agent` outstanding) now only
  exists for mechanically-clean tasks. **Quinn does not need to change the cron** — the lobster's
  new ordering naturally limits Ash's work to mechanically-clean tasks.
- **PR-process skill (unchanged):** no change to `agents/skills/dev/pr-process/SKILL.md`. The
  PR body format (AC labels with emoji-prefixed evidence annotations) is unchanged.
- **Tech-design skill (unchanged):** no change. This PR is itself a tech-design PR.

## Test plan / AC verification matrix

| AC | Test layer | Test file | Notes |
|---|---|---|---|
| AC1 — lobster mechanically verifies file existence, test pass/fail, evidence-text matching in `verify_delivery`, posts `[feature-task-progress-checklist]` on failure | unit + integration | `agents/workflows/feature-task/test/mechanical_evidence.rs` (port + new) + `agents/workflows/feature-task/test/verify_delivery_mechanical.rs` (gate-ordering) | Failure cases for each of: cited-test-file missing from diff, cited-test failing, cited-not-tested-file missing from diff, cited-pr-file missing from diff. Success case: all checks pass. |
| AC2 — Ash's `qa_agent` approval only requested after mechanical gate passes; scoped to semantic judgment | integration + unit | `agents/workflows/feature-task/test/verify_delivery_mechanical.rs` (AC2 case: mechanical pass + qa_agent outstanding → `[qa-agent-blocked]`) + `agents/ash/test/verify.test.ts` (semantic-contract pin tests) | Verify Ash's verify.ts no longer contains the mechanical functions (`grep -n "^export function checkTestId\|^export function checkNotTested\|^export function checkPrReference" agents/ash/src/verify.ts` returns empty). |
| AC3 — Ash's `verify.ts` no longer needs its own credential/auth surface for mechanical checks | review | (PR review) | Verify `verify.ts` no longer calls `defaultFetchTask`, `defaultFetchPr` from the mechanical path. Both functions stay (semantic check still needs the diff), but the mechanical-check path that previously consumed them is deleted. ASH_TASKS_API_APPROVAL_TOKEN is still required (for posting approval); ASH_GITHUB_TOKEN is still required (for semantic-check diff read). |
| AC4 — Existing `verify.ts` test coverage for mechanical checks is preserved (ported to lobster test suite, not dropped) | unit | `agents/workflows/feature-task/test/mechanical_evidence.rs` | Each test case from `agents/ash/test/verify.test.ts` mechanical section has a corresponding Rust test (see §7 mapping table). Coverage is at-least-as-much as the deleted TS cases — no regression in what gets caught. |

## Open questions / risks

1. **Test execution budget.** The lobster's new mechanical check will spawn `pnpm test --filter
   <name>` once per cited test ID per sweep. A PR with 8 ACs citing distinct tests pays 8x CI
   time per sweep. Mitigations: (a) the lobster sweep cadence (~every 15 min during active
   development) bounds worst case; (b) `pnpm test --filter` is fast when the cited test is a
   specific test name vs a full suite; (c) if budget is a concern, restrict cited-test execution
   to the **latest** sweep before `qa_agent` gate creation, not every sweep. The first cut
   implements (a)+(b); (c) is a follow-up if Tom flags budget. Flag in PR description.

2. **Cross-PR cited test execution.** A cited test name in `Evidence::TestId` may live on a
   branch that's not the latest one (e.g. an earlier PR in a stack). `pnpm test --filter` runs
   against the current workspace state, which is the merged mainline, not the cited PR's
   branch. This is acceptable for merged PRs (they're on main) but breaks for open-PR sweeps
   (the cited test may not exist yet in the workspace). Mitigate by running cited-test execution
   only when `pr_changed_files` shows the PR is merged (i.e. run during the `doing → acceptance`
   sweep, not during the `doing` body's earlier sweeps). The first cut implements this guard.

3. **Ash's `qa_agent` row on tasks that previously had it created.** Today's
   `ensure_qa_agent_gate` creates the row on every sweep; after this PR it only creates the row
   after mechanical passes. Existing tasks in `doing` that already have a `qa_agent` row from a
   previous sweep (created when mechanical was passing) will keep that row even if their PR
   regresses and mechanical now fails. This is acceptable — the row will simply not be
   satisfied (Ash will see mechanical failures via the `[feature-task-progress-checklist]` and
   not approve). We do **not** delete pre-existing rows; doing so would require a new Tasks API
   endpoint or a destructive sweep. Document this in the PR description; flag if Tom wants the
   deletion path.

4. **Semantic judgment implementation.** `verifySemantic` in `agents/ash/src/verify.ts` is left
   as a **placeholder** for Quinn to implement. The pin-the-contract tests assert the shape
   (which ACs pass/fail, what comment pattern is posted) but the actual judgment logic is
   Quinn's call. This PR is mergeable without Quinn's semantic implementation because the
   lobster's mechanical gate works without Ash running — a task simply never reaches
   `acceptance` until Quinn's semantic check exists and is wired. Flag in PR description.

5. **`pnpm test --filter` semantics.** pnpm's `--filter` matches a **package**, not a test name.
   For cited test IDs like `test_foo` (Vitest name, not file path), we need `pnpm --filter <pkg>
   test -- -t <name>` or `pnpm test -- -t <name>` depending on the workspace layout. The first
   cut uses `pnpm test --filter <name> -- --reporter=basic` (matching Ash's current behaviour);
   if that proves wrong for vitest names, swap to `pnpm test -- -t <name>` and document. Verify
   at impl time against the actual repo's vitest config.

6. **Multi-task PR subsection scoping.** `mechanical_evidence_failures` reuses the
   `task_ac_vs_open_pr_failures` subsection carving (per-task `### Task <id>` headings). The
   PR's `pr_changed_files` is **PR-global**, not per-task — so a cited file from a sibling
   task's subsection will be mechanically-checked against the current PR's diff, which is the
   right behaviour (the file is or isn't in the merged diff). This is consistent with the
   existing AC-text check.

7. **Failure comment prefix separation.** Mechanical failures land in the same `[feature-task-progress-checklist]`
   bucket as AC-text-mismatch and clippy-evidence failures. The assignee sees one comment per
   sweep with all mechanical + structural + text problems grouped. This is the desired
   behaviour (single source of "what to fix"); the alternative (separate `[lobster-mechanical]`
   prefix) would fragment the feedback. Document this in the PR description.

## Rollback

- **Lobster rollback:** revert the gate-ordering change in `verify_delivery` (move
  `ensure_qa_agent_gate` back to unconditional at line 770) and remove the
  `mechanical_evidence_failures` call. The mechanical-check functions in `ac_parsing.rs` stay
  unused but don't break anything; delete in a follow-up if desired.
- **Ash rollback:** revert the slim of `verify.ts` to its mechanical + semantic shape. The
  mechanical functions and tests are restored verbatim.
- **No data migration.** No Tasks API schema changes; no Tasks API rows to undo.

## Implementation order

1. Land mechanical-evidence check functions in `ac_parsing.rs` with ported unit tests
   (`agents/workflows/feature-task/test/mechanical_evidence.rs`) — **single PR, no behavioural
   change yet**.
2. Wire mechanical checks into `verify_delivery`'s `failures` collection; reorder
   `ensure_qa_agent_gate` to post-mechanical-pass position; add gate-ordering integration tests
   (`agents/workflows/feature-task/test/verify_delivery_mechanical.rs`) — **second PR, behavioural
   change**.
3. Slim `agents/ash/src/verify.ts` to semantic-only; delete mechanical tests; update
   `agents/ash/README.md`; add semantic-contract pin tests — **third PR, Ash-side cleanup**. Quinn
   implements the actual semantic judgment in a follow-up.