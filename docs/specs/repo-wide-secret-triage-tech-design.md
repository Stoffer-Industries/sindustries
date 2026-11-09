---
status: draft
task_id: 46211c26-4a31-45a2-97aa-43e8593d01d4
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Repository-wide secret triage and tree-scan enforcement

## What this ships

The merge-gate secret scan shipped in task `2b3962b1` (PR #947) makes the gate
**enforceable** but deliberately narrow: it scans the change (`base.sha..HEAD`),
not the repository. A secret that is already in `main`'s tree or history is
outside that gate. This task closes the gap in three ordered steps:

1. **Triage** — one repository-wide scan (full history + tracked tree) under the
   enforced config, with every finding triaged individually.
2. **Remediate** — rotate/revoke genuine credentials and remove them from the
   tree; remove them from history only under an explicit, approved rewrite.
3. **Re-baseline and widen** — with a clean tree baseline established, join the
   tree scan to the merge gate so a secret committed into any tracked file fails
   the required job, and run the history scan on a schedule as an alerting
   surface.

The ordering is the design. The tree scan joins the gate **only after** the
tree is clean; the history scan is an alert surface and never a merge blocker.

## Task, branch, worktree, repos

| Item | Value |
|---|---|
| Task | `46211c26-4a31-45a2-97aa-43e8593d01d4` — "Repository-wide secret triage and tree-scan enforcement (M2 follow-up to the merge-gate gitleaks enforcement)" |
| Parent task | `2b3962b1-7d8c-433e-beec-859de2f5b715` — PR #947 (merged 2026-11-09, head `5560d04`) |
| Type / priority | `code` / high |
| Repo | `Stoffer-Industries/sindustries` |
| Branch | `task-46211c26-repo-wide-secret-triage` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-46211c26-repo-wide-secret-triage` |
| Product spec | n/a — code task, no product spec |

## Current state on `main` (verified at `0be5af0`)

- `.gitleaks.toml` — `useDefault = true` (the bundled ruleset is active), a
  narrow global allowlist (`.env.example` paths, test-fixture paths, a
  placeholder stopword list, an empty-assignment regex), and one test-only
  detection rule `sindustries-secret-scan-canary` scoped to
  `infra/cloud/secret-scan-canary.txt`.
- `infra/cloud/scripts/run-secret-scan.sh` — the shared entrypoint used by the
  CI job, the local pre-commit hook and the contract test. Change scope only
  (`--staged`, or `base..HEAD`); explicit failure modes (exit 2 missing binary,
  3 missing config, 4 zero-commit scope, 5 bad usage) and no fail-open path.
- `.github/workflows/ci.yml` — the `gitleaks` job (`name: gitleaks secret scan`)
  installs the pinned CLI (`8.30.1`, SHA256 `551f6fc8…`) and runs the
  entrypoint. `gitleaks` is one required input of the `merge-gate` job, whose
  only required status-check context is `merge gate`.
- `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh` — the contract
  test: static half (no `continue-on-error`, no `gitleaks-action`, no
  `GITLEAKS_LICENSE` dependency, pinned version + SHA, entrypoint wired, job
  comment matches behaviour, CONTRIBUTING inventory parity, config shape) and
  behavioural half (missing binary / missing config / empty range each exit
  non-zero; a clean temp repo passes with its scope reported).
- Measured at the parent's implementation: the **tracked tree** at `main` scans
  clean under the corrected config (zero findings across 1356 tracked files);
  the findings that do surface are in gitignored local development files
  (`.vercel/`, `*.env.local`, `*.env.prodlike`). The **full git history has
  never been scanned** under the corrected config.

## Ownership boundary — the natural source of truth

The source of truth here is a **workflow/CI boundary**, not an API or a
database:

- **Detection policy** — `.gitleaks.toml` (rules and allowlist).
- **Execution policy** — `infra/cloud/scripts/run-secret-scan.sh` (scope
  resolution, failure contract, exit codes). Every surface (CI job, local
  pre-commit hook, contract test, and now the scheduled history scan) calls
  this one entrypoint, so the policy cannot drift between them.
- **Enforcement wiring** — `.github/workflows/ci.yml` (`gitleaks` job) and the
  branch ruleset's `merge gate` context.
- **Finding record** — a tracked ledger in this repository.

No API route, database table, model or cross-service contract is added or
changed. There is no second source of truth to reconcile: the M2 work extends
an existing entrypoint and an existing policy file rather than introducing a
parallel scanner path.

**Incremental-delivery check:** the durable shape (one entrypoint, one config,
one ledger, one gate job) is about as easy as any interim shim would be, so
this design builds the durable shape directly. There is no interim step to
clean up later.

## `.openclaw` boundary

None required. The work is entirely inside this repository: workflow YAML, a
shell entrypoint, a config file, contract tests and docs. Nothing needs a
change under `~/.openclaw/`, and no task-state routing change is needed.

## Implementation plan

### 1. Extend the shared entrypoint with explicit scope modes

`infra/cloud/scripts/run-secret-scan.sh` gains two modes alongside the
existing change scope:

- `--history` — the whole history: `gitleaks git --log-opts="--all"`, with
  `--redact=100`.
- `--tree` — the tracked working tree: `gitleaks dir`, with `--redact=100`.

Both modes keep the current failure contract: an empty or unresolvable scope is
an explicit failure (never "scanned nothing → success"), and every failure
path prints a `::error::` annotation and exits with its own code. The scope
resolved is always printed, so a green check states what it scanned. `--tree`
must scan tracked files only (git-tracked paths, so a developer's local
`.env.local` never enters the result).

### 2. New scheduled history-scan workflow

`.github/workflows/secret-scan-history.yml` — the alerting surface:

- Triggers: weekly `cron` plus `workflow_dispatch` (on demand).
- Uses the **same pinned CLI** (version + SHA256) and the **same entrypoint**
  (`--history --tree`), so there is no second install path and no second
  policy. A contract-test assertion enforces that.
- Checkout with `fetch-depth: 0` (full history required).
- Redacted output only; the run publishes a findings summary (rule ID, path,
  commit SHA, line — **never the value**) as a job artifact and a step
  summary.
- The job fails when findings exist (an alerting failure, visible in Actions),
  but it is **not** a merge-gate input and does not block merges.

### 3. Remediate genuine findings (the part that needs people)

Triage is per finding, and the two categories are handled differently:

- **Still-live credential in the tree** → rotate/revoke it with its owner
  first (credential rotation is an owner action, not a code action), then
  remove it from the tree in the same PR. Removal from the tree alone is not
  remediation: a live secret that stays live is still a leak.
- **Still-live credential in history only** → rotate/revoke it with its owner,
  then decide the history treatment (see the rewrite gate below).
- **False positive / test fixture** → either fix the content (preferable) or
  add a **narrow** allowlist entry with a stated reason and a specific path
  and/or regex shape. A blanket or path-wide allowlist entry is not an
  acceptable way to make a scan pass, and the contract test below fails the PR
  if one appears.

**History rewrite gate.** Rewriting published history is destructive: it
force-pushes over the public repository, invalidates every clone and CI
cache, and cannot be undone for anyone who already cloned. Default path is
**rotate + document** — the credential is dead, so the historical exposure is
no longer exploitable, and the residual is recorded in the ledger. A rewrite
is performed only when all of these hold:

1. Tom or Quinn explicitly approves that specific rewrite.
2. The credential is confirmed live (so the rewrite is buying real value).
3. A backup ref (`refs/original/…`) and a written rollback procedure exist
   before the force-push.

Nothing in this task performs a history rewrite without those three
conditions.

### 4. Join the tree scan to the merge gate (after the baseline is clean)

The `gitleaks` job in `.github/workflows/ci.yml` gains a second invocation of
the entrypoint with `--tree`, so a secret committed into **any tracked file**
fails the required job (and therefore the `merge gate` context).

Design choice: **a second step in the existing `gitleaks` job**, not a new
job id. A new job id would change the set of required status checks on the
`main` ruleset — a platform-level change with a wider blast radius and a
ruleset edit — for no additional coverage. Keeping one job keeps
`merge-gate.needs` composition, the required-check set and the existing
contract-test wiring unchanged.

The tree scan is added **only after** AC2's clean-baseline evidence exists. If
a live secret is still in the tree, adding the tree scan first would redden
every open PR at once — including PRs that have nothing to do with the leak —
and the tempting fix (an allowlist entry) is exactly what this task exists to
prevent. The sequencing is therefore: triage → remediate → clean baseline
evidence → gate wiring.

Runtime: the tree scan runs on every PR from now on. The first run measures
its duration; the tree is ~1356 files, so the expected cost is small. If the
measured cost is material, the fallback ladder is (a) keep the scan in the
gate and trim the job's other work, then (b) reduce the scanned surface only
with a documented, Tom-visible deviation — never "scheduled only" silently.

### 5. Contract-test extensions

`infra/cloud/scripts/tests/secret-scan-enforcement.test.sh` gains:

- The `gitleaks` job runs the entrypoint in `--tree` mode.
- `.github/workflows/secret-scan-history.yml` exists, is triggered by
  `schedule` and `workflow_dispatch`, pins the same gitleaks version and
  SHA256, and calls the shared entrypoint (no direct `gitleaks` invocation
  outside the entrypoint).
- **Allowlist narrowness**: no allowlist path entry may match the repository
  root or a whole top-level directory, and every allowlist path entry carries
  an inline reason comment. (The config's own comment already says "Do NOT
  add broad allowlists"; this makes it enforceable.)
- The entrypoint's `--history` and `--tree` modes exit non-zero on an empty
  or unresolvable scope, and print the scope they resolved.

### 6. Docs

- `docs/runbooks/secret-scan-triage.md` (new) — the operational runbook:
  how to run the triage scan locally, how to read a finding, how to rotate a
  credential, when a rewrite needs approval, and **the live findings ledger**
  (one row per finding: rule ID, path, commit SHA, line, status, rotation
  owner, date). A per-finding ledger does not belong in a system doc (those
  describe what a system *is*, not individual findings), and it is not an
  audit.
- `docs/systems/cloud-platform.md` — update the existing "Secret scan
  enforcement" section: the gate now scans change + tree, history runs on a
  schedule, triage procedure and runbook pointer.
- `CONTRIBUTING.md` — CI inventory: the tree scan is part of the required
  `gitleaks` job; the history scan is a scheduled alert.
- `docs/repo-audits/2026-W46.md` — F3/T3 resolution note updated to point at
  this task as the residual (history/tree) work.

## Data model / API contract changes

None. No task, user or domain data is added, and no API surface changes. The
only new tracked artefact is the findings ledger (a Markdown file).

## Workflow, cron and skill changes

- One new GitHub Actions workflow (`.github/workflows/secret-scan-history.yml`)
  with a weekly schedule and a manual dispatch. It is **not** wired into
  `merge-gate.needs`.
- No OpenClaw cron, Lobster, skill or task-routing change is required.

## Test plan — AC verification matrix

No AC here is user-visible app behaviour, so E2E (Playwright) coverage is not
applicable; the equivalent surface is live GitHub Actions runs, which is what
the ACs themselves demand.

| AC | Verification | Layer | Evidence artifact |
|---|---|---|---|
| **AC1** — one repository-wide scan (history + tree) under the enforced config, every finding triaged individually, no blanket allowlist | (a) The scheduled/dispatchable history workflow runs `--history --tree` over the full history and the tracked tree; (b) the findings ledger carries one row per finding with its triage status (rotated / removed / false-positive-with-reason); (c) the contract test fails the PR if the allowlist gains a path-wide entry or an entry without a reason. | live workflow run + contract test + ledger review | Run URL + artifact (redacted) + ledger path in the PR body; contract-test output |
| **AC2** — the tracked tree at `main` scans clean under the enforced config, proven by a live run that names scope and count | The live history-workflow run (tree mode) reports zero findings over the tracked tree, with the scope and the finding count printed by the entrypoint. | live workflow run | Run URL + the entrypoint's scope/finding-count lines |
| **AC3** — the tree scan is wired into the merge gate on the clean baseline, and a secret in a tracked file fails the required job | Negative control: a throwaway PR carrying a synthetic canary in a **tracked** file → the `gitleaks secret scan` job concludes `failure` **and** `merge gate` concludes `failure`; branch and PR deleted afterwards (same pattern as PR #947's negative control). Plus the always-on fixture in the job asserting the tree scan exits non-zero on a synthetic canary commit. | live GitHub Actions run | Run URL + both job conclusions in the PR body; fixture output in the job log |
| **AC4** — surviving history-only findings are enumerated with per-finding remediation status | The ledger's history section lists every surviving history finding with its status (rotated, rewrite-approved-and-done, false-positive-with-reason). | ledger review | Ledger path + row count in the PR body |

## Open questions and risks

- **Q1 (owner: Tom) — credential rotation ownership.** If triage finds a live
  credential in history, rotation is an owner action. Default assumption: Tom
  rotates organisation/cloud credentials, Quinn rotates third-party API keys
  where the account is shared; the ledger records *who* and *when*, never the
  value. The design does not depend on the answer — rotation precedes any
  rewrite decision, and the rotate-and-document path needs no rewrite.
- **Q2 (owner: Tom) — rewrite or document.** Default: rotate + document;
  rewrite only under the three conditions in §3. The repo is public, so the
  exposure window is real now; rotation is what closes it, not the rewrite.
- **Q3 (owner: Quinn/Tom) — schedule cadence.** Default: weekly + on-demand
  dispatch. A secret lands in `main` within minutes of a merge, so the
  *gate* is the timely surface; the weekly scan is the backstop for history
  that the change scan cannot see.
- **Risk — the history scan is not merge-blocking.** A history finding surfaces
  on the weekly schedule, not at merge time. This is a deliberate trade (a
  full-history scan on every run is too slow and would redden every PR on an
  unrelated historic finding). Mitigation: the tree scan joins the gate, so
  anything that reaches `main`'s tree is caught at merge time; the residual
  surface is history-only and is covered by the weekly alert.
- **Risk — rewriting history invalidates clones and CI caches.** Handled by the
  three-condition rewrite gate and the backup-ref rollback procedure.
- **Risk — false positives from the newly-enabled default ruleset** in the
  tree scan. Handled by fixing content in preference to allowlisting, by the
  narrowness assertion in the contract test, and by measuring the first run's
  duration and finding count before the gate wiring lands.
- **Risk — the gate wiring lands before the baseline is clean.** Ordering in
  the implementation plan prevents this; the tree scan is added only after
  AC2's evidence exists.

## Clarification gate

**No clarification needed before implementation**, because: the task's four
ACs fix the required outcomes (triage, clean tree baseline, tree scan in the
gate, residual documented); the parent's approved tech design already fixed
the enforcement path and the licensing posture; and the open questions above
are owner decisions with stated defaults (rotate-and-document; weekly
schedule) that the implementation does not depend on. The assumptions that
could be wrong — the gitleaks CLI's `--log-opts="--all"` history mode,
`gitleaks dir` over tracked files only, and the tree-scan runtime in the gate
— are the first things the implementation measures, so they are recorded as
verification steps rather than assumptions to be discovered mid-implementation.

## Related specs, tasks and audits

- Task `46211c26-4a31-45a2-97aa-43e8593d01d4` (this work).
- Parent task `2b3962b1-7d8c-433e-beec-859de2f5b715` — PR #947, merged
  2026-11-09; its design `docs/specs/merge-gate-secret-scan-enforcement-tech-design.md`
  names this task as its M2 milestone.
- Audit `docs/repo-audits/2026-W46.md` — F3 (`:50`) and T3 (`:134`), now
  resolved by the parent task with this task carrying the residual.
- System doc `docs/systems/cloud-platform.md` — "Secret scan enforcement".
- Tests: `infra/cloud/scripts/tests/secret-scan-enforcement.test.sh`,
  `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`.
