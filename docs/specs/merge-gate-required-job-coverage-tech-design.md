---
status: draft
task_id: 5674a6c1-6757-48fb-aa2d-669ac2c22c25
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Merge Gate Required-Job Coverage — Tech Design

## Links

- Task: `5674a6c1-6757-48fb-aa2d-669ac2c22c25` (💻 "Close the merge-gate verification hole and make the gate self-checking")
- Task API detail: `http://localhost:4001/api/v1/tasks/5674a6c1-6757-48fb-aa2d-669ac2c22c25`
- Research task (investigation record, stays linked per AC7): `9f7dd4e2-ecc4-450e-9182-72af19e0b0b3` — verdict comment dated 2026-10-24 contains the full AC1–AC3 findings this design builds on.
- Repo audit ledger: `docs/repo-audits/2026-W41.md` F3 (line 52), `docs/repo-audits/2026-W42.md` F3 (line 103) — both currently link only the research task; AC7 requires they also reference this implementation task once it lands.
- Prior reconfirmation: PR #798 (W42 audit).
- Gitleaks fail-open decision (explicitly out of scope here): tracked separately as **W43 F2**, needs-human-decision.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `rowan-merge-gate-required-job-coverage`
- Worktree: `/Volumes/WD1/worktrees/quinn/rowan-merge-gate-required-job-coverage`
- Primary surfaces:
  - `.github/workflows/ci.yml` — add the missing `needs` entry (AC1).
  - `infra/cloud/scripts/tests/ci-deployment-gates.test.sh` — replace the hand-maintained `expected_required` literal with a derived check, add the advisory marker, add the AC3/AC4 negative fixtures, add the AC5 coupling assertion.
  - `docs/repo-audits/2026-W41.md`, `docs/repo-audits/2026-W42.md` — append this task's ID to the existing F3 ledger lines (AC7).
  - `brain/research/ci-aggregate-completeness-W41.md` — see Open Questions; the research task's verdict comment claims this was committed 2026-10-24 but it does not exist in the repo tree or `git log --all`. Flagging rather than silently reconstructing it.
- No `.openclaw` runtime change, no API/data-model change, no new GitHub Actions permissions requested (see Decision 4 for why).

## Problem Summary

`gh-with-agent-token-tests` (`ci.yml:885-941`) owns the only regression guard for per-agent GitHub identity (the `gh-with-agent-token.sh` shim), the `bin/deploy|status|rollback` contracts, the cloud staging workflow harness, the staging failure-drill contract, and the stable-hostname harness/schema check. It is declared in `ci.yml` but **absent from `merge-gate.needs`** (`ci.yml:1041-1065`), so a failure there currently blocks neither `merge-gate` nor any of the 10 downstream deployment jobs (each gated only on `needs.merge-gate.result == 'success'`).

The existing contract test (`ci-deployment-gates.test.sh:40-65`) cannot catch this because its `expected_required` set is a second hand-maintained literal that repeats the same omission — config and "proof" were copy-pasted from the same wrong source, so they agree with each other and disagree with reality.

Verified live (2026-10-24, via `gh api repos/Stoffer-Industries/sindustries/rulesets/13513816`): the `main` branch ruleset has exactly one required status check, context `merge gate`, and classic branch protection on `main` is absent (404). So `merge gate` is the **sole** gate standing between a PR and `main` — there is no second line of defence if the aggregate's own dependency list is wrong.

## Decision 1 — Required vs. advisory marker

**Decision:** a job's required/advisory status is determined by graph position, not a workflow-level annotation:

- **Required** = every job in `ci.yml` that is not `merge-gate` itself and is not downstream of `merge-gate` (i.e. its `needs` does not include `merge-gate`) — unless explicitly exempted (next bullet).
- **Advisory** = named in a new, explicit, empty-by-default allowlist constant in the contract test:

  ```python
  # Jobs intentionally excluded from merge-gate.needs. Empty today — there
  # is no verification job whose failure is allowed to not block release.
  # Adding a name here is a security-posture decision and requires a tech
  # design, same as this one. Do NOT use `continue-on-error` as the
  # advisory marker — it already means fail-open on `gitleaks` (W43 F2,
  # needs-human-decision) and that is a known gap, not a pattern to copy.
  ADVISORY_VERIFICATION_JOBS = frozenset()
  ```

This is the "dedicated marker" the task description asks for: a reviewable, grep-able, version-controlled set, co-located with the derivation logic it constrains — not a YAML field (GitHub Actions has no native required/advisory concept to hang one on) and explicitly not `continue-on-error`. Today it is empty, so the fix for AC1 (`gh-with-agent-token-tests`) flows through the ordinary "required by default" path with no marker needed.

## Decision 2 — Derived expected-set mechanism

Verified by parsing the live `ci.yml` (36 jobs: 1 producer `changes`, 24 verifiers including the omitted one, 1 aggregator `merge-gate`, 10 deployment jobs): the set `{name for name, job in jobs.items() if name != 'merge-gate' and 'merge-gate' not in as_list(job.get('needs'))}` minus `ADVISORY_VERIFICATION_JOBS` is **exactly** equal to today's `merge-gate.needs` plus the one omitted job. This is a clean invariant — no verifier job exists today that is neither downstream of `merge-gate` nor required by it, other than the bug this task fixes.

`as_list` must normalize `needs` because some jobs declare it as a bare string (`feature-task-clippy: needs: changes`) rather than a list.

Implementation: extract this into a local function `compute_expected_required(jobs)` inside the embedded Python in `ci-deployment-gates.test.sh`, used both by the real assertion and by the AC4 self-test (so the two can't drift apart the way `expected_required` and `merge-gate.needs` already have once).

## Decision 3 — Negative fixtures (AC3, AC4)

**AC4 — sentinel-mutation fixture**, mirroring the existing W43 F1 `mutated_outputs` self-test pattern already in this file:

1. Take the parsed `jobs` dict, deep-copy it, append a fake job `sentinel-unwired-verification-job: {needs: changes}` (required-shaped: not `merge-gate`, not downstream of it).
2. Run `compute_expected_required` against the mutated jobs and compare to the mutated copy's `merge-gate.needs` (unchanged) — assert the comparison fails and that `sentinel-unwired-verification-job` is named in the reported diff.
3. Add the sentinel to the mutated `merge-gate.needs` and re-run — assert it now passes.

This proves the contract test can go red on a future omission, not just today's.

**AC3 — aggregate-outcome fixture:**

1. Build a `REQUIRED_RESULTS` payload from the real (post-fix) `merge-gate.needs` job names, forcing one real name (`gh-with-agent-token-tests`) to `'failure'` and the rest to `'success'`. Feed it to `check-ci-results.py` (reusing the existing subprocess-invocation pattern at `ci-deployment-gates.test.sh:76-90`, which today only exercises synthetic `unit`/`optional` names). Assert exit code 1 and that the failing job's name appears in stderr.
2. Reuse the existing static loop over `deploy_jobs` (`ci-deployment-gates.test.sh:~104-116`) — it already asserts every deployment job's `if` condition requires `needs.merge-gate.result == 'success'` and runs under `always()`. No change needed here; call this out explicitly in the verification matrix as the second half of AC3's proof (aggregate failure ⇒ no deploy job's condition is satisfied, because every one of them requires the exact string that step 1 just proved goes to `'failure'`).

## Decision 4 — Ruleset-to-`ci.yml` coupling (AC5)

**Decision: hermetic assertion + dated manual-verification comment, not a live `gh api` call from inside the CI job.**

Rationale: reading a repository ruleset (`GET /repos/{owner}/{repo}/rulesets/{id}`) needs elevated read access beyond this workflow's current `permissions: {contents: read, pull-requests: read}`. Granting `administration: read` to get an automated live check is a second security-posture change riding inside a task whose own description scopes it to the `merge-gate.needs` hole — and tying an assertion to the literal numeric ruleset ID `13513816` is brittle if the ruleset is ever recreated. The existing contract test suite is entirely hermetic (file-parsing only, no network); breaking that pattern for one check is a bigger design question than this task needs to answer.

Implementation:

```python
# Verified live 2026-10-24 via `gh api repos/Stoffer-Industries/sindustries/rulesets/13513816`:
# the `main` ruleset's only required_status_checks entry has context "merge gate",
# and classic branch protection on `main` is absent (404) — merge-gate is the
# sole gate. Re-verify this during repo-audit passes if the ruleset changes;
# this assertion only catches ci.yml drifting away from the last-verified name.
REQUIRED_STATUS_CHECK_CONTEXT = 'merge gate'
if gate.get('name') != REQUIRED_STATUS_CHECK_CONTEXT:
    fail(f"ci.yml: merge-gate name must stay '{REQUIRED_STATUS_CHECK_CONTEXT}' to match the live branch ruleset's required status check")
```

(`gate.get('name') != 'merge gate'` already exists in the file today under a weaker message; this replaces it with the named constant and the dated provenance comment, satisfying AC5's "coupling is asserted" without inventing a brittle live dependency.) Flagging this as the one point in the design I'd like Quinn's explicit sign-off on, since "assert vs. live-verify" is a judgment call.

## Decision 5 — `skipped` stays allowed (point 5 of the task description)

No code change: `check-ci-results.py`'s `ALLOWED_RESULTS = frozenset({'success', 'skipped'})` already treats `skipped` as passing, and the existing `validator_cases` table already has a case proving it (`{'unit': {'result': 'success'}, 'optional': {'result': 'skipped'}}` → exit 0). This matters because path-filtered jobs (e.g. `feature-task-clippy`, which only runs `if: needs.changes.outputs.feature_task == 'true'`) report `skipped` on unrelated PRs and must not block them. Documenting this explicitly in the verification matrix below rather than touching working code.

## Out of Scope

- `gitleaks`'s `continue-on-error: true` fail-open behaviour — tracked as **W43 F2**, needs-human-decision, explicitly excluded per the task description.
- Live-API ruleset verification automation — see Decision 4.
- Reconstructing `brain/research/ci-aggregate-completeness-W41.md` as a committed file — see Open Questions.

## Implementation Plan

1. `.github/workflows/ci.yml`: add `gh-with-agent-token-tests` to `merge-gate.needs` (AC1). One line.
2. `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`:
   - Add `as_list`/`compute_expected_required` helper, replace the hand-maintained `expected_required` literal with its output minus `ADVISORY_VERIFICATION_JOBS` (AC2).
   - Add `ADVISORY_VERIFICATION_JOBS = frozenset()` with the explanatory comment (Decision 1).
   - Add the AC4 sentinel-mutation self-test (Decision 3).
   - Extend the existing validator-invocation block to also exercise real `merge-gate.needs` job names with one forced failure (AC3).
   - Replace the existing bare `gate.get('name') != 'merge gate'` check with the named `REQUIRED_STATUS_CHECK_CONTEXT` constant + provenance comment (AC5).
3. `docs/repo-audits/2026-W41.md` line 52 and `docs/repo-audits/2026-W42.md` line 103: append `, implementation task 5674a6c1 (5674a6c1-6757-48fb-aa2d-669ac2c22c25)` to the existing F3 ledger lines, keeping `9f7dd4e2` as the investigation record per AC7.
4. `brain/research/ci-aggregate-completeness-W41.md`: resolve the discrepancy flagged in Open Questions — either commit the file (content is fully recoverable from the `9f7dd4e2` verdict comment) in this PR, or get Quinn's agreement to treat the task comment as the durable record instead and say so explicitly in that task.

## Test Plan — AC Verification Matrix

| AC | Verification | Layer |
|---|---|---|
| AC1 | `gh-with-agent-token-tests` present in `merge-gate.needs`; AC3 fixture forces it to `failure` and asserts `check-ci-results.py` exits 1 | file / contract test |
| AC2 | `compute_expected_required(jobs)` derivation replaces the literal; AC4 fixture proves a future omission is caught by name | contract test (new helper + self-test) |
| AC3 | Real-job-name failure fixture → `check-ci-results.py` exit 1 with the failing name in stderr; existing `deploy_jobs` loop already proves every deploy `if` requires `needs.merge-gate.result == 'success'` | contract test |
| AC4 | Sentinel-mutation self-test: append an unwired job to a mutated copy of `jobs`, assert the comparison fails and names it; add it to mutated `needs`, assert it passes | contract test |
| AC5 | `gate.get('name') == REQUIRED_STATUS_CHECK_CONTEXT ('merge gate')`, with dated provenance comment recording the live ruleset check (no live call in CI — see Decision 4) | contract test + manual record |
| AC6 | This document committed on `rowan-merge-gate-required-job-coverage`; `[tech-design]` task comment posted; Quinn's `tech_design` approval recorded before implementation starts | process (this pass) |
| AC7 | `docs/repo-audits/2026-W41.md` and `2026-W42.md` F3 lines updated to also cite `5674a6c1`; `9f7dd4e2` stays as the investigation record | docs-only diff in the implementation PR |

No user-facing app flow is touched, so E2E coverage does not apply; the fallback layer is the existing bash/python contract-test harness already used for every other CI-structure assertion in this file.

## Open Questions / Risks

1. **Missing research deliverable.** Task `9f7dd4e2`'s 2026-10-24 verdict comment states `brain/research/ci-aggregate-completeness-W41.md` was delivered, but it is not in the repo tree or `git log --all -- <path>`. The comment's content is complete enough to have driven this design directly, so nothing here is blocked on it — but the stated deliverable should either be committed or the task record corrected so "stays linked as the investigation record" (AC7) points at something real. Raising for Quinn rather than silently picking one.
2. **Decision 4 (hermetic vs. live ruleset check)** is the one judgment call in this design most worth a second look — flagged above.
3. `ADVISORY_VERIFICATION_JOBS` is empty today; if a genuinely advisory job is ever proposed, adding it should go through the same tech-design + Quinn-approval path as this task, not a quiet PR — worth a one-line note in `CONTRIBUTING.md` or the skill docs if this pattern needs to be discoverable later (not doing that here; out of scope).
