---
status: draft
task_id: 2b3962b1-7d8c-433e-beec-859de2f5b715
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Merge-gate secret scan enforcement — gitleaks CLI, no licence

## Problem statement

The `gitleaks` job in `.github/workflows/ci.yml` is a required `merge-gate` input, and it has never scanned a commit.

- `.github/workflows/ci.yml:1249` defines the `gitleaks` job (display name `gitleaks secret scan`).
- `.github/workflows/ci.yml:1272-1277` runs `gitleaks/gitleaks-action@v2` with `continue-on-error: true` (`:1274`).
- `gitleaks-action@v2` refuses to start on an organisation repo without a paid `GITLEAKS_LICENSE` secret. Every run aborts with `missing gitleaks license` / `[Stoffer-Industries] is an organization. License key is required.` before scanning anything.
- Because the step is fail-open, the job still concludes `success`. `infra/cloud/scripts/check-ci-results.py` only reads each required job's `result` and allows `success` or `skipped`, so `merge-gate` (`:1371` lists `gitleaks` in `needs`) has counted a required secret-scan result that is indistinguishable from no check at all.
- Live proof: run `42556174766` (2026-11-09, main @ `04669760`) — the `gitleaks secret scan` job and its `Run gitleaks` step both conclude `success` while the step log contains `##[error] missing gitleaks license`. The same holds for PR #836's head `deb991e0` (run `39703971137`, 2026-10-22).
- The workflow comment at `.github/workflows/ci.yml:1258-1266` asserts the opposite of observed behaviour ("this step is marked `continue-on-error: true` so the scan still runs (and surfaces findings via the PR comment) without blocking CI"). It does not run and surfaces nothing.

This is the fourth audit to raise it (W42 F6, W43 F2, W44, W46 F3) and it has never had a task or an owner.

## Task, branch, worktree, repositories

| Field | Value |
|---|---|
| Task | `2b3962b1-7d8c-433e-beec-859de2f5b715` — "💻 Make the merge gate's secret scan enforceable (gitleaks has never scanned a commit)" |
| Task type / status | `code` / `open` (priority high, assignee Rowan) |
| Repository | `Stoffer-Industries/sindustries` (single repo; no cross-repo work) |
| Branch | `task-2b3962b1-gitleaks-merge-gate` (off `origin/main` @ `04669760`) |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-2b3962b1-gitleaks-merge-gate` |
| Product spec | n/a — code task, no product spec exists |
| Tech design PR | none by design: the design is committed on the implementation branch (tech-design skill) |

`.openclaw` boundary: **no `.openclaw` changes are needed.** Everything in this design lives in the `sindustries` repo (workflow, config, scripts, docs). No agent configuration, cron, skill or gateway change is involved, so there is nothing to route to Quinn as an `.openclaw`-owned blocker. The one owner-level decision that remains open (Q1 below) is a licensing choice, not an `.openclaw` change.

## Chosen enforcement path

**Chosen: the license-independent gitleaks CLI, pinned by version and SHA256, run through one shared repo script, blocking by default.**

- gitleaks is MIT-licensed and needs no GitHub secret, no organisation credential and no owner-only provisioning step, so the gate is enforceable today by anyone with a branch.
- The binary is pinned: `gitleaks_8.30.1_linux_x64.tar.gz` from the upstream release, SHA256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` (upstream `gitleaks_8.30.1_checksums.txt`, verified 2026-11-09). A tampered or truncated download fails the install step; it cannot fail open.
- One entrypoint script serves CI, the fixture self-test and the local pre-commit hook, so the three surfaces cannot drift apart.
- **Not chosen now:** the licensed `gitleaks/gitleaks-action@v2`. That path needs a paid `GITLEAKS_LICENSE` organisation secret (open owner question Q1 in the W46 audit) and is not a precondition for enforcement. If that secret is ever provisioned, switching back is a one-step change inside the same job and AC1-AC4 still hold unchanged.

**No interim shim.** The durable shape (pinned install + shared entrypoint + blocking gate + fixture proof) costs about the same as any interim step, so building a temporary local-only or action-based arrangement would create avoidable migration work for no risk reduction.

## Ownership boundary

- Natural source of truth: the **CI/workflow boundary inside this repository** — `.github/workflows/ci.yml` (the gate), `.gitleaks.toml` (the detection policy), `infra/cloud/scripts/run-secret-scan.sh` (the scan entrypoint). It is not UI-local state, not an API-owned resource, not database-backed domain data, and not a shared package: the rule being enforced ("no secret may reach this repository's history") is owned by this repo's CI and has no consumer outside it today.
- Direct consumers of this boundary:
  - `merge-gate` → `REQUIRED_RESULTS` → `infra/cloud/scripts/check-ci-results.py` (`ALLOWED_RESULTS = {success, skipped}`), which is the `main` branch ruleset's only required status check context, `merge gate`.
  - Every deployment job, all of which require `needs.merge-gate.result == 'success'` (asserted by `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`).
  - The local pre-commit hook installed by `scripts/install-hooks.sh`.
  - Contributor documentation (`CONTRIBUTING.md` CI inventory) and the audit ledger (`docs/repo-audits/`).
- Extraction/migration plan: none needed. The new entrypoint replaces the action step in place; there is no temporary placement and no duplicated policy. If a second repository later needs the same gate, the entrypoint script is the extraction unit — not this PR's concern.
- Existing services are not appropriate owners here: this is not API or domain data, and no service runtime participates in a merge gate.

## Scope

### In scope

1. `.github/workflows/ci.yml` — `gitleaks` job:
   - replace the `gitleaks/gitleaks-action@v2` step with a pinned CLI install step (download + SHA256 verification) and an invocation of the shared entrypoint;
   - remove `continue-on-error: true` (`:1274`);
   - rewrite the job comment so it matches what the job does;
   - keep the job id `gitleaks` and the display name `gitleaks secret scan` — `merge-gate.needs` (`:1371`), the CONTRIBUTING inventory parity check and the job-id shape rule in `infra/cloud/scripts/tests/ci-deployment-gates.test.sh` all reference that id, so renaming it would be a separate, larger change.
2. `infra/cloud/scripts/run-secret-scan.sh` (new) — the single scan entrypoint used by CI, the fixture self-test and the local hook.
3. `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh` (new) — contract test for the enforcement path, wired into the `gitleaks` CI job and documented in `CONTRIBUTING.md` (required in both directions by `infra/cloud/scripts/tests/ci-job-script-inventory.test.sh`).
4. `.gitleaks.toml` — one **test-only detection rule** for the synthetic canary token, so the negative control uses a token that cannot be mistaken for a credential and cannot be defeated by the existing path allowlist. The rule only ever adds detections; it suppresses nothing.
5. `infra/cloud/scripts/secret-scan-negative-control.sh` (new) — the scripted negative control that produces the live AC1 proof (push a throwaway branch with the canary, read the required job's conclusion, delete the branch).
6. Documentation (AC4): the ci.yml job comment, the `CONTRIBUTING.md` CI inventory (`gitleaks` entry at `CONTRIBUTING.md:133` and the new contract test in the documented test list), `docs/systems/cloud-platform.md:615` (the advisory-marker paragraph that names the gitleaks fail-open gap), the comment at `infra/cloud/scripts/tests/ci-deployment-gates.test.sh:44-49` (which cites the same gap as the reason not to copy `continue-on-error`), and `docs/repo-audits/2026-W46.md` F3 (`:52`) and T3 (`:131`) → point at this task and its implementation PR.

### Out of scope (and why)

- **Narrowing the `.gitleaks.toml` path allowlist** (`tests/.*/fixtures/.*`, `.env.example`) — that is W41 F1 / T4's policy work (allowlist scope, not enforcement). Consequence for this task: the canary must live at a path the allowlist does not cover (`infra/cloud/secret-scan-canary.txt`), and the design must not rely on allowlisted fixture paths for the negative control.
- **The licensed `gitleaks-action` path and `GITLEAKS_LICENSE` provisioning** — owner decision (W46 Q1), explicitly not a precondition for enforcement.
- **A repository-history-wide secret sweep** — see *Scan scope* below. It needs its own triage of historic findings and its own enforcement policy, and it is tracked as a follow-up task, not smuggled into the gate change.
- **Scanning PR bodies, review comments and issue text** — gitleaks does not scan those surfaces (`docs/systems/observability.md:310`); that is a separate control.
- **Any change to the local hook's staged-scan semantics** — the hook keeps scanning staged changes; only its invocation is routed through the shared entrypoint so config and flags cannot drift.

## Scan scope — the decision that needs stating explicitly

The blocking scan covers **the change**, not the whole repository history:

- `pull_request` events: the commits in `github.event.pull_request.base.sha..HEAD`.
- `push` to `main`: the commits in `github.event.before..github.sha`.
- If the base cannot be resolved (first push / force-push edge), fall back to a working-tree scan (`gitleaks dir .`) and emit a `::warning::` naming the fallback.

Rationale and trade-off:

- A change-scoped scan is attributable: a red `gitleaks` job names the commits that introduced the finding, and an unrelated PR is not blocked by a secret that was already in `main`.
- A history-wide scan on every run is attractive but dangerous to land blind: if the repository's history contains an unallowlisted secret, the very first merge after the change turns `main` red for an unrelated reason, and the natural "fix" (a broad allowlist entry) would weaken the gate this task exists to make real.
- Consequence, stated plainly: a secret that is already present in `main`'s tree or history is **not** what this gate change catches. That exposure is real and is triaged in the follow-up task (M2 below) — one repository-wide scan, remediate the real findings, then the tree scan can join the gate with a clean baseline.
- The entrypoint must never report success for an empty scope: if the resolved range contains no commit, the scan step fails with an explicit error rather than concluding "nothing found" (this is the AC3 failure mode — a green check that scanned nothing).

## Implementation plan

### 1. `infra/cloud/scripts/run-secret-scan.sh` (new, executable)

Contract:

- Usage: `run-secret-scan.sh [--staged] [--config <path>] [--base <sha>] [<root>]`; defaults: config `.gitleaks.toml`, root `.`.
- Preconditions, each failing loudly with a GitHub annotation and a distinct exit code:
  - `gitleaks` on `PATH` → else `::error::gitleaks binary not found` and exit `2`;
  - config file exists → else `::error::gitleaks config not found` and exit `3`;
  - a non-empty scan scope → else `::error::secret scan scope resolved to zero commits` and exit `4`.
- Invocation: `gitleaks git --redact=100 --no-banner --config <config> --log-opts "<base>..HEAD" <root>` for the change scan, `gitleaks dir --redact=100 --no-banner --config <config> <root>` for the tree fallback, `gitleaks protect --staged --redact=100 --no-banner --config <config>` for `--staged` (the local hook's mode).
- Any gitleaks finding exits non-zero; the script prints `::error::secret scan failed` and propagates the exit code.
- `--redact=100` everywhere: this repository is public and CI logs are public, so a finding must never print its value.
- No fail-open constructs: no `|| true`, no `continue-on-error`, no `set +e` around the scan.

### 2. `.github/workflows/ci.yml` — `gitleaks` job

- Step "Install gitleaks CLI (pinned)": download `gitleaks_8.30.1_linux_x64.tar.gz` from the upstream release URL, verify SHA256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` with `sha256sum -c -`, extract to `$RUNNER_TEMP/bin`, prepend to `PATH`. A download or checksum failure fails the step (and therefore the job).
- Step "Scan for secrets": `bash infra/cloud/scripts/run-secret-scan.sh` — base resolution from the event payload (`github.event.pull_request.base.sha` / `github.event.before`), tree fallback when unresolvable.
- Step "Fixture self-test": `bash infra/cloud/scripts/tests/secret-scan-enforcement.test.sh` (behavioural part; the binary is on `PATH` in this job).
- Job comment rewritten to state: no licence is required, the CLI is version- and checksum-pinned, the scan covers the change, findings and setup failures fail this job, and this job is a required `merge-gate` input.
- `merge-gate.needs` unchanged — the job id stays `gitleaks`, so the gate's composition and the guard test's derived required set are untouched.

### 3. `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh` (new)

Static assertions over `ci.yml` and the entrypoint:

- the `gitleaks` job contains no `continue-on-error: true`;
- the job invokes `infra/cloud/scripts/run-secret-scan.sh`;
- the job pins the gitleaks version and the expected SHA256;
- the job comment no longer claims the scan "still runs ... without blocking CI";
- the entrypoint script exists, is executable, and contains no fail-open construct (`|| true`, `continue-on-error`);
- the `CONTRIBUTING.md` inventory line for `gitleaks` does not describe the job as advisory-only.

Behavioural assertions (this job installs the binary, so they always run where they matter):

- a temp git repo containing a commit with the synthetic canary token makes the entrypoint exit non-zero (detection);
- a temp git repo with no secret makes the entrypoint exit zero (clean pass);
- a missing config makes the entrypoint exit non-zero **and** print an `::error::` annotation (setup failure is visible);
- a missing binary makes the entrypoint exit non-zero with an `::error::` annotation;
- an empty commit range makes the entrypoint exit non-zero (a green check must never mean "scanned nothing").

If `gitleaks` is not on `PATH` the test fails loudly with an instruction to install it — it never skips, because a skipped assertion asserts nothing.

### 4. `.gitleaks.toml` — canary rule

```toml
[[rules]]
id = "sindustries-secret-scan-canary"
description = "Test-only detection rule for the secret-scan enforcement canary. Adds a detection; it never suppresses one."
regexes = ['''SINDUSTRIES_SECRET_SCAN_CANARY_[A-Z0-9]{16,}''']
entropy = 2.0
```

The canary is a distinctive, non-credential marker: publishing it on a throwaway branch for the duration of the negative control cannot leak anything, and the existing path allowlist does not cover `infra/cloud/secret-scan-canary.txt`.

### 5. `infra/cloud/scripts/secret-scan-negative-control.sh` (new)

Live AC1 proof, scripted so it is repeatable:

1. create a scratch branch off `origin/main`, write `infra/cloud/secret-scan-canary.txt` containing the canary token, commit, push to `ci/secret-scan-negative-control`;
2. open a pull request from it so the `pull_request` trigger runs (`ci.yml` triggers on `pull_request` and on `push` to `main` only);
3. wait for the run, read the `gitleaks secret scan` and `merge gate` job conclusions, and assert both are `failure`;
4. print the run URL and the two conclusions (this is the evidence artifact for AC1);
5. close the pull request and delete the remote branch.

### 6. Documentation (AC4)

- `CONTRIBUTING.md:133` — the `gitleaks` inventory entry loses "advisory-only — see W38 audit F1 for the unenforced-server-side gap" and gains the enforcement summary; the documented contract-test list gains `secret-scan-enforcement.test.sh` (required by the inventory parity test).
- `docs/systems/cloud-platform.md` — the paragraph at `:615` that names the gitleaks fail-open gap is rewritten, and a short "Secret scan enforcement" subsection records: the pinned CLI + checksum, the change scope, the failure modes, and the negative-control procedure.
- `infra/cloud/scripts/tests/ci-deployment-gates.test.sh:44-49` — the comment that says `continue-on-error` "already means fail-open on `gitleaks` (W43 F2, needs-human-decision) and that is a known gap, not a pattern to copy" is updated: the gap is closed, so the comment now states the rule without citing a closed gap.
- `docs/repo-audits/2026-W46.md` — F3 (`:52`) gets "➡️ Tracked by task `2b3962b1`" and the implementation PR link; T3 (`:131`) is marked as tracked by this task.
- `docs/systems/observability.md:310` — the sentence "gitleaks scans commit diffs, not comment bodies" stays true for the change-scoped scan; no edit required (optional wording refresh, not needed for AC4).

## Data model / API contract changes

None. This change touches no database, no API, no service, no shared package. The only contracts that change are CI-internal: the `gitleaks` job's behaviour, and the shared entrypoint's CLI surface (`run-secret-scan.sh`).

## Workflow, cron and skill changes

- No cron, no agent skill, no workflow definition outside `.github/workflows/ci.yml`.
- No agent-facing workflow (Lobster / task queue) changes: the task's `[tech-design]` → approval → implementation flow is unchanged.

## Test plan — AC verification matrix

No AC here is user-visible app behaviour, so E2E (Playwright) coverage is not applicable; the equivalent surface is a live GitHub Actions run, and the ACs explicitly require live CI evidence rather than local invocation.

| AC | Verification | Layer | Evidence artifact |
|---|---|---|---|
| **AC1** — synthetic secret in a fixture causes the required CI job to fail, proven by a live CI run | (a) Negative control: throwaway PR with the canary → `gitleaks secret scan` conclusion `failure` **and** `merge gate` conclusion `failure`. (b) Always-on: the fixture self-test in the same job asserts the entrypoint exits non-zero on a synthetic canary commit, in every run. | live GitHub Actions run (both a and b) | Run URL + both job conclusions in the PR body; self-test output in the `gitleaks` job log |
| **AC2** — scanner setup failure is visible and fails the job; `continue-on-error` gone; comment matches behaviour | Static: contract test asserts no `continue-on-error: true` in the `gitleaks` job, no fail-open construct in the entrypoint, and no "advisory-only" wording in the CONTRIBUTING inventory. Behavioural: the fixture asserts missing-config and missing-binary invocations exit non-zero **and** print an `::error::` annotation. | contract test + live CI run | Contract-test output in the `gitleaks` job log |
| **AC3** — a clean tree passes and the success is meaningful | (a) The implementation PR's own `gitleaks secret scan` run concludes `success` after an executed scan, and the job log states the scanned scope (commit count / scope resolution) so the green is distinguishable from a no-op. (b) The fixture asserts a clean temp repo exits `0` and that an **empty** commit range exits non-zero. | live CI run + contract test | Job log lines in the PR run; contract-test output |
| **AC4** — chosen path and licensing/credential posture documented; W46 finding updated | Reviewer check of the six documentation surfaces above, plus a contract assertion that the CONTRIBUTING inventory no longer describes the job as advisory-only. | contract test + reviewer | PR diff + contract-test output |

## Milestones

- **M1 (this PR)** — enforcement and its proof land together: pinned CLI install, shared entrypoint, blocking job, contract test, canary rule, negative-control script, documentation. Splitting enforcement from its proof would leave a window where the gate blocks without a fixture, or a fixture without enforcement; the pieces are individually reviewable inside one PR.
- **M2 (follow-up task, created after merge)** — repository-wide secret triage: one history/tree scan over the whole repository, remediate genuine findings (never a blanket allowlist), then add the tree scan to the gate with a clean baseline. Separate because it has its own triage and its own enforcement policy.
- **M3 (conditional, only if Tom provisions `GITLEAKS_LICENSE`)** — swap the install step back to the licensed action. The enforcement contract (AC1-AC4) and the entrypoint stay unchanged.

## Assumptions

- The `gitleaks` job runs on `ubuntu-latest` (x86_64) → the `linux_x64` release asset is the correct one.
- gitleaks v8.30.1 provides the `gitleaks git` and `gitleaks dir` subcommands (renamed from `detect` in v8.19) and the `--log-opts` flag.
- GitHub-hosted runners can reach `github.com` release assets (needed for the pinned download). If that ever changes, the fallback is a cached org-side binary or a container image — recorded as a risk, not relied upon.
- The `main` branch ruleset's only required status check context is `merge gate` (verified live 2026-10-24, recorded in `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`), so a red `gitleaks` job reddens the gate through `check-ci-results.py` and blocks the merge.
- No new repository or organisation secret is required — the CLI path needs no credential at all.
- The scan runs for fork pull requests too (`pull_request` events need no secret for this job), which is strictly better coverage than the licensed action gave us.

## Open questions and risks

- **Q1 (owner: Tom/Quinn, not blocking)** — keep the CLI path permanently, or migrate back to the licensed action once `GITLEAKS_LICENSE` is provisioned? The design does not depend on the answer; both paths satisfy AC1-AC4, and the switch is one step inside the same job.
- **Q2 (Rowan, at implementation)** — does the repository tree at `main` contain any unallowlisted secret? Measured by the implementation PR's own CI run. If it does, that is a real exposure to remediate in the same PR — the implementation must not weaken the allowlist to get green.
- **Risks**
  - *False positives blocking merges*: the existing allowlist is narrow; any new allowlist entry needs a stated reason and a narrow path/regex shape. The canary rule only adds detections.
  - *Scan duration*: the change-scoped scan is expected to be fast; the first run measures it. If the commit range is unexpectedly slow, scope it to the merge-base range.
  - *Publishing the canary*: the canary token is synthetic and rule-detectable, the file exists only on the throwaway branch, and the branch and PR are deleted by the negative-control script.
  - *Losing the fail-open safety net*: removing `continue-on-error` means a scanner outage blocks merges. That is exactly AC2, and every failure path is explicit (`::error::` annotations with distinct exit codes) so an outage is diagnosable rather than silent.
  - *Merge-gate composition*: unchanged. The new contract test is wired into the existing `gitleaks` job, so no new merge-gate input is introduced and `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`'s derived required set is unaffected.

## Clarification gate

**No clarification needed before implementation**, because: the task description names the recommended path (a license-independent CLI) and states explicitly that the owner decision on the licensed action is *not* a precondition; the acceptance criteria define the required behaviour (fails on findings, setup failures visible, clean tree passes, documented posture); and the repository's own guard tests fix the job id, the merge-gate composition and the documentation surfaces that this design must respect. The assumptions above are stated so a reviewer can reject any one of them explicitly rather than discover it mid-implementation.

## Related specs, tasks and audits

- Task `2b3962b1-7d8c-433e-beec-859de2f5b715` (this work).
- Audits: `docs/repo-audits/2026-W46.md` F3 (`:52`) and T3 (`:131`); earlier: W42 F6, W43 F2, W44, W41 F1, W39 F1, W38 F1.
- Related design: `docs/specs/merge-gate-required-job-coverage-tech-design.md` (its `:109` records that the gitleaks fail-open was deliberately excluded from that scope — this task is that excluded scope).
- Related system doc: `docs/systems/cloud-platform.md` (advisory-marker paragraph at `:615`).
- Related test: `infra/cloud/scripts/tests/ci-deployment-gates.test.sh` (merge-gate contract), `infra/cloud/scripts/tests/ci-job-script-inventory.test.sh` (contract-test wiring and documentation parity).

## As implemented — three deviations from the design above

The design assumed the repo's existing `.gitleaks.toml` was sound, and that the canary rule could be written as `regexes = [...]`. Implementing it against the real gitleaks v8.30.1 binary showed both assumptions false. All three changes below are corrections of the *policy file*, not of the enforcement design, and the contract test now guards each one.

1. **The config was inert.** `[extend]` set no keys, and `extend.useDefault` has defaulted to **false** since gitleaks v8.19 — so the config shipped with no rules at all. The table's own comment claimed the bundled ruleset was in use. Measured: the previous config did not flag `API_KEY=sk_live_…`, which the default ruleset does flag. Fixed by setting `useDefault = true`.
2. **A rule's pattern is `regex` (singular); the plural `regexes` form is ignored.** The design's canary rule was written as `regexes = [...]`, which gitleaks rejects with `both |regex| and |path| are empty`. Fixed by using `regex`. (An *allowlist* does legitimately use the plural form; only a *rule* does not.)
3. **The two per-rule overrides were removed.** `generic-api-key` and `AKAHU_CLIENT_SECRET` were written to relax empty `.env.example` placeholders, but with their patterns ignored they carried a path and no pattern — and the `generic-api-key` override shadowed the built-in rule for the whole repository. The global allowlist already covers the `.env.example` path and the empty-assignment shape they were written for, so removing them restores the bundled rules at full strength rather than narrowing them. Measured: identical detection on a probe with and without them for the shadowed rule, and the tracked tree at `main` (1356 files) scans clean under the corrected config, so switching the default ruleset on does not retroactively redden anything.

**Q2 answered.** The repository tree at `main` contains no unallowlisted secret in any tracked file: the corrected config reports zero findings across all 1356 tracked files. The findings it does surface are all in gitignored local development files (`.vercel/`, `*.env.local`, `*.env.prodlike`) — local machine state, not repository history — which is why the gate scans the change rather than the tree. The M2 follow-up (repository-wide history triage) is unchanged.
