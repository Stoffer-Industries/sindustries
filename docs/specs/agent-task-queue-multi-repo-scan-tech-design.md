---
status: draft
task_id: 7fba23bf-64b7-4c14-8ce5-e45721543d28
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Project both repos from the unified agent task queue, with repo-qualified PR identity

## Links and scope

- Task: `7fba23bf-64b7-4c14-8ce5-e45721543d28` — 💻 Make the unified agent task queue project both repos, with repo-qualified PR identity
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-7fba23bf-multi-repo-task-queue`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-7fba23bf-multi-repo-task-queue`
- Primary surfaces:
  - `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` (the scanner)
  - `agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py` (the suite)
  - `docs/systems/tasks.md` (system doc — updated on ship)
- Related designs:
  - `docs/specs/agent-task-queue-cumulative-fetch-hang-2026-08-20-tech-design.md` — the bounded-timeout + parallel fan-out contract this change must preserve
  - `docs/specs/ambient-gh-token-overrides-profile-tech-design.md` — the `gh_env` credential boundary this change must not disturb
- Repositories scanned after this change: `Stoffer-Industries/sindustries` **and** `Stoffer-Industries/workspace`

---

## Product intent

The unified heartbeat queue is the only thing that tells an agent's heartbeat what to work on next. It projects two kinds of work: Tasks API records, and GitHub pull requests.

It currently projects PRs from exactly one repository, because `agent_task_queue.py:63` declares

```python
REPO = "Stoffer-Industries/sindustries"
```

and all seven GitHub call sites interpolate that constant into their endpoint paths. `Stoffer-Industries/workspace` — a live repository with its own CI, runbooks, reviewer set and PR lifecycle — is therefore *structurally unreachable*. No queue shape can carry a review request, a CHANGES_REQUESTED review, or a merge candidate from that repo, because the scanner never asks GitHub about it.

This is not theoretical. At design time, four workspace PRs are open with `rowanstoffer` requested as reviewer:

```
$ gh pr list --repo Stoffer-Industries/workspace --state open \
    --json number,title,author,reviewRequests
# 88  docs(infra): make the daily service-health cron model-free…   quinnstoffer → rowanstoffer
# 87  docs(infra): document MiniMax Token Plan quota failures       quinnstoffer → rowanstoffer
# 85  docs(infra): runbook for staging stable-hostname DNS…         quinnstoffer → rowanstoffer
# 83  docs(infra): runbooks for 502-vs-schema-drift and empty-payload relay  quinnstoffer → rowanstoffer
```

Every one of those is a review request addressed to Rowan that the queue reports as `reviewRequests: []`. The same gap was logged twice in retro notes (2026-10-24 `the-queue-scans-one-repo-so-the-other-repos-authored-prs-are-invisible-to-it`; 2026-10-29 `heartbeat-review-queue-is-scoped-to-one-repo`) and recurred a third time on 2026-11-08, ten days apart. The durable fix belongs in the scanner. A reviewer noticing the backlog is diligence, not a control.

**Outcome.** The scanner takes the repository set as a parameter rather than a constant, projects every configured repository, and qualifies every PR it emits with the repository it came from — so two PRs that share a number in different repos cannot collide or overwrite each other, and an operator reading a queue item can always tell which repo it belongs to.

---

## The trap this design exists to avoid

**PR numbers are repo-scoped.** `Stoffer-Industries/workspace#83` and `Stoffer-Industries/sindustries#83` are both real, both open, and different PRs. The task description calls this out explicitly, and it is correct: a naive "scan two repos" implementation merges two number-keyed collections and one silently overwrites the other.

Three concrete collision points exist in the current code, and all three must be addressed by this change:

1. **`classify_github_prs` emits bare `number`** (`agent_task_queue.py:660`). Two PRs with the same number in different repos produce two dicts that differ only by `url` and `title` — any consumer that keys on `number` collides.
2. **`_pull_number_from_url` (`agent_task_queue.py:197`) discards the owner and repo**, keeping only the number. `GITHUB_PR_URL_RE` (`agent_task_queue.py:140`) captures the number and throws the rest away, so a linked delivery URL pointing at the workspace repo would be fetched from `sindustries` — the wrong PR, or a 404.
3. **`build_unified_queue` sorts by `str(item.get("id") or item.get("number") or "")`** (`agent_task_queue.py:1005`). PR-derived items have no `id`, so they sort by bare number and two same-numbered PRs from different repos tie.

The fix is one concept applied consistently: **a repo-qualified PR identity**, carried on every emitted item and derived from the URL wherever a URL is the input.

---

## Architecture approach

### 1. The repo set becomes data, not a constant

```python
DEFAULT_SCANNED_REPOS = (
    "Stoffer-Industries/sindustries",
    "Stoffer-Industries/workspace",
)
```

`REPO` is deleted, not renamed. Every function that talks to GitHub takes the repository as an explicit argument:

| Function | Current signature | New signature |
|---|---|---|
| `_fetch_github_pr_detail` | `(config_dir, token_env, number, retries=3)` | `(config_dir, token_env, repo, number, retries=3)` |
| `_fetch_reviews_tolerant` | `(config_dir, token_env, number)` | `(config_dir, token_env, repo, number)` |
| check-runs fetch | inlined twice | new `_fetch_check_runs(config_dir, token_env, repo, sha)` — one call site shape, repo threaded once |
| `fetch_github_prs` | `(agent)` | `(agent, repos)` |
| `fetch_linked_delivery_prs` | `(agent, tasks, github_prs=None)` | `(agent, tasks, github_prs=None, repos=None)` |

The two inlined check-runs fetches (`agent_task_queue.py:877` and `:916`) are lifted into one helper so the repo cannot be threaded at one call site and forgotten at the other — the same class of bug as the two `/issues/` vs `/pulls/` reviewer-request paths this workspace has been bitten by before.

**CLI:** a `--repos` flag accepts a comma-separated `owner/name` list and defaults to `DEFAULT_SCANNED_REPOS`. Heartbeat invocations in `agents/definitions/rowan/HEARTBEAT.md` and the sibling agents' heartbeats need **no change** — the default already covers both repos. The flag exists so a repo can be added, removed, or temporarily disabled without a code change, and so the test suite can drive an arbitrary repo set.

### 2. Repo-qualified PR identity

Every PR-derived item emitted by `classify_github_prs` carries three fields:

```python
{
  "id": "Stoffer-Industries/workspace#83",   # composite, collision-free
  "repo": "Stoffer-Industries/workspace",     # owner/name
  "number": 83,
  "title": "docs(infra): runbooks for 502-vs-schema-drift…",
  "url": "https://github.com/Stoffer-Industries/workspace/pull/83",
}
```

`id` is the stable composite key (`owner/name#number`). It is what downstream consumers key on, and because `build_unified_queue` already prefers `item["id"]` over `item["number"]` when sorting, the composite flows into the deterministic ordering with no change to that function.

The URL parser becomes repo-aware:

```python
GITHUB_PR_URL_RE = re.compile(
    r"^https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$"
)

def _parse_pr_url(url: str) -> tuple[str, int] | None:
    """Return `(owner/name, number)` for a GitHub PR URL, or None."""
```

`_pull_number_from_url` is replaced by `_parse_pr_url`, and every linked-delivery hydration call uses the repo parsed from *that URL* — not from the configured set, and not from a constant. A task comment linking `Stoffer-Industries/workspace#88` is fetched from the workspace repo.

`fetch_linked_delivery_prs` already keys its hydration map by `html_url`, which is globally unique across repos, so that map does not need to change. What changes is which repo each URL is fetched from.

### 3. Coverage is reported, so an empty list can never again mean "no coverage"

This is the AC3 mechanism and it is also the guard against the exact false-clean shape that caused this task.

The JSON envelope gains two top-level keys:

```jsonc
{
  "scannedRepos": ["Stoffer-Industries/sindustries", "Stoffer-Industries/workspace"],
  "repoCoverage": [
    {"repo": "Stoffer-Industries/sindustries", "status": "ok",        "openPrCount": 4, "detailPrsHydrated": 1, "reason": null},
    {"repo": "Stoffer-Industries/workspace",  "status": "degraded", "openPrCount": 0, "detailPrsHydrated": 0, "reason": "gh-api-failure: exit 1"}
  ]
}
```

- `status` is `ok` (the repo's PR list was fetched successfully), `degraded` (the list call failed — auth, timeout, 5xx), or `skipped` (the repo was not attempted).
- `reason` carries the same failure detail the existing `prHydrationDegraded` marker carries, but per repo.

The existing whole-envelope `prHydrationDegraded` marker (identity unprovisioned / first-list failure) is retained unchanged for backward compatibility — consumers that only know that key keep working. `repoCoverage` is strictly additional.

The property this buys: a consumer that sees `reviewRequests: []` can consult `repoCoverage` and learn **which** repo failed to project, instead of inferring "no PRs anywhere". A silent empty list is no longer a reachable state.

### 4. Latency: the repo set doubles, the heartbeat slot does not

`fetch_github_prs` currently hydrates each PR's detail, reviews and check-runs **serially**, in a plain `for` loop (`agent_task_queue.py:870-879`). Doubling the repo set doubles that serial loop, and the 2026-08-20 hang design (`docs/specs/agent-task-queue-cumulative-fetch-hang-2026-08-20-tech-design.md`) exists precisely because cumulative sequential runtime blew the heartbeat slot.

So the hydration fan-out moves to the `ThreadPoolExecutor` that `fetch_linked_delivery_prs` already uses, over the flattened `(repo, pr)` work list, bounded by the existing `_MAX_PARALLEL_PR_FETCH_WORKERS`. The per-call `_GH_API_TIMEOUT_SECONDS = 10.0` bound and the `--verbose` instrumentation are unchanged.

This preserves the earlier design's contract — total wall time bounded by `max(per-PR latency)` rather than `sum(...)` — and extends it to the repo dimension. The alternative (accept 2× latency and document it) is rejected: the heartbeat slot is the binding constraint on this workload, and the parallel machinery is already written and tested.

---

## Ownership boundary check

**Natural source of truth:** the scanner itself. The scanned repo set is a property of *the queue*, not of any one repo — it belongs in the script that projects the queue, with the GitHub API remaining the source of truth for PR state.

**One scanner, two repos — not one scanner per repo.** The alternative is to copy `agent_task_queue.py` into `Stoffer-Industries/workspace` and run two queues. That is rejected outright: it recreates exactly the drift this task exists to kill (the queue and the reality of the repo set would diverge silently again), it doubles the maintenance surface, and it reintroduces the false-clean shape at the seam between the two queues.

**Where the scanner lives.** The scanner stays in `Stoffer-Industries/sindustries` under `agents/skills/ops/tasks-api/scripts/`. Edge's `sync-agent-definitions.sh` copies that tree into each agent's workspace, so every agent keeps running the same scanner with the same repo set — there is no second copy to drift.

**Reviewer policy stays agent-based, not repo-based.** `_blocking_reviewers(agent, pr, latest)` decides who must approve before a PR can become a merge candidate. It is deliberately **not** made repo-aware in this change, because the workspace repo uses the same agent identities as sindustries: Quinn authors workspace PRs, Rowan reviews them, and Quinn is still the blocking reviewer for Rowan-authored PRs in either repo. A per-repo reviewer table would be a speculative extension with no current requirement. If the workspace repo later adopts a different blocking-reviewer policy, that is a separate change with its own design.

**Why not fix this in the reviewer's diligence.** The retro notes show this gap recurred three times, ten days apart, each time resolved by a human noticing the backlog. The control has to live in the scanner; a reviewer-level habit is not a control.

---

## `.openclaw` boundary

None of this change requires writing outside the repository.

- No new secrets. The existing `GITHUB_IDENTITIES` map already carries the per-agent `gh` profile dir / token env, and Rowan's profile (`~/.config/gh-rowan`) already has read access to both `Stoffer-Industries/sindustries` and `Stoffer-Industries/workspace` — verified during design: `gh pr list --repo Stoffer-Industries/workspace` succeeds under `GH_CONFIG_DIR=~/.config/gh-rowan` as `rowanstoffer`.
- No OpenClaw runtime config, no cron entries, no env vars, no scheduler changes.
- The `agents/skills/ops/tasks-api/scripts/` tree is synced to agent workspaces by Edge's `sync-agent-definitions.sh`; no manual copy is needed and no `.openclaw` write is required.
- `gh_env()` (`agents/lib/github_cli.py`) is untouched — the repo changes only the *endpoint path* passed to `gh api`, never the credential boundary.

---

## Implementation plan — file and module scope

### `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`

1. **Repo set.** Delete `REPO`. Add `DEFAULT_SCANNED_REPOS`. Add `--repos` to `build_parser()`; parse, validate (`owner/name` shape) and de-duplicate the list, preserving order. Invalid entries are a hard error, not a silent drop — a malformed repo name that is silently skipped is the same false-clean shape in miniature.
2. **Repo-aware helpers.** Thread `repo` through `_fetch_github_pr_detail`, `_fetch_reviews_tolerant`; add `_fetch_check_runs(config_dir, token_env, repo, sha)` and use it at both former inline call sites.
3. **URL parsing.** Replace `GITHUB_PR_URL_RE` + `_pull_number_from_url` with the capturing regex + `_parse_pr_url(url) -> tuple[str, int] | None`.
4. **Scan.** `fetch_github_prs(agent, repos)` loops the repo set; each repo's PR list is fetched independently so one repo's failure degrades only that repo; every hydrated PR is tagged with its `repo`. Per-PR detail/reviews/check-runs hydration moves to the bounded `ThreadPoolExecutor` fan-out.
5. **Coverage.** `fetch_github_prs` returns `(prs, coverage)` — or records coverage into a module-level structure read by `main()`. The per-repo record carries `repo`, `status`, `openPrCount`, `detailPrsHydrated`, `reason`.
6. **Identity.** `classify_github_prs` emits `id`, `repo`, `number`, `title`, `url` on every summary it produces, for all four collections (`reviewRequests`, `authoredPrConflicts`, `authoredPrFeedback`, `mergeCandidates`).
7. **Linked delivery.** `fetch_linked_delivery_prs` parses each URL's repo with `_parse_pr_url` and fetches that PR from that repo. A URL whose repo is not in the configured set is still fetched (the task explicitly linked it) and is reported as a coverage `degraded` row with reason `linked-delivery-repo-not-configured` — visible, not silent.
8. **Envelope.** `main()` writes `scannedRepos` and `repoCoverage` into the JSON envelope. The human-readable output gains the repo-qualified `id` so a terminal reader sees `workspace#83`, not `#83`.

### `agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py`

New tests, in the existing `unittest` style of that file (see `AgentTaskQueueTest` and the `pull_request()` / `task()` fixtures):

- `test_scan_covers_every_configured_repo` — a fake `_gh_api` records every endpoint; assert the set of `repos/<owner>/<name>/pulls` endpoints requested equals the configured repo set exactly.
- `test_every_github_endpoint_targets_a_configured_repo` — assert no recorded endpoint names a repo outside the configured set (no stray hardcoded `sindustries`).
- `test_repo_qualified_ids_coexist_across_repos` — feed a `sindustries#83` and a `workspace#83` into `classify_github_prs`; assert both survive in the same collection with distinct `id`s and distinct `repo`s, and neither overwrites the other.
- `test_linked_delivery_pr_is_fetched_from_its_own_repo` — a delivery URL in the workspace repo is fetched from `repos/Stoffer-Industries/workspace/pulls/…`, not from sindustries.
- `test_repo_coverage_reports_every_configured_repo` — `repoCoverage` has exactly one record per configured repo.
- `test_failed_repo_fetch_is_reported_not_silently_empty` — one repo's list call raises; assert that repo's coverage row is `degraded` with a reason, and that the other repo still projects normally (partial degradation, not total loss).
- `test_every_emitted_pr_item_identifies_its_repo` — every item in all four PR collections has a non-empty `repo`, an `id` equal to `<repo>#<number>`, and a `url` whose path contains the repo.
- `test_no_hardcoded_single_repo_constant` — `getattr(module, "REPO", None) is None`. A cheap tripwire against reintroducing the constant.
- `test_repo_set_is_validated` — a malformed repo name is rejected rather than silently skipped.

### `docs/systems/tasks.md` (on ship)

Extend the "Discovering actionable tasks (recipient side)" subsection with a "Multi-repo scan and repo-qualified PR identity" subsection documenting: the default repo set, the `--repos` override, the `id`/`repo` fields on every PR item, and the `scannedRepos` / `repoCoverage` envelope keys. This is a behaviour change to a durable operational surface, so it belongs in the system doc, not only in this design.

### Not in scope

- **Reviewing the four open workspace PRs** (#83, #85, #87, #88). They become reachable *because* of this change; doing the reviews is separate work, picked up by the normal `reviewRequest` heartbeat path once the scanner lands.
- Any change to the Tasks API, to `pending_tech_design_approvals.py`, or to the task-side classification logic. Those are repo-independent by construction and gain nothing here.
- A per-repo reviewer table (see ownership boundary).
- `workspace#84`, which the task description mentions as a duplicate of #83 with a file/table-row mismatch. That is a workspace-repo content question, not a scanner question.

---

## Data model / API contract changes

No Tasks API schema change. The contract change is the queue's own JSON envelope:

| Key | Type | Meaning |
|---|---|---|
| `scannedRepos` | `string[]` | The repository set this run projected, in configured order. |
| `repoCoverage[][].repo` | `string` | `owner/name`. |
| `repoCoverage[][].status` | `"ok" \| "degraded" \| "skipped"` | Whether this repo's PRs were actually projected. |
| `repoCoverage[][].openPrCount` | `number` | Open PRs GitHub reported for this repo. |
| `repoCoverage[][].detailPrsHydrated` | `number` | PRs whose detail/reviews/check-runs were fetched (i.e. the ones relevant to this agent). |
| `repoCoverage[][].reason` | `string \| null` | Failure detail when `status != "ok"`. |

And on every PR-derived queue item:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | `"<owner>/<name>#<number>"` — collision-free composite. |
| `repo` | `string` | `"<owner>/<name>"`. |
| `number` | `number` | The repo-local PR number (unchanged). |
| `url` | `string` | Full PR URL (already repo-qualified). |

The existing `prHydrationDegraded` envelope key is unchanged.

---

## AC verification matrix

This matrix lives in this document only. It is **not** copied into a PR body.

| AC | How it is verified | Test |
|---|---|---|
| **AC1** — the scanned repo set is a parameter, not a module constant; every GitHub call site uses it | The configured repo set is threaded through every GitHub call. The fake `_gh_api` records every endpoint; the suite asserts the set of repos listed equals the configured set exactly, and that **no** endpoint names a repo outside it. The source-level tripwire asserts `REPO` no longer exists as a module constant. | `test_scan_covers_every_configured_repo`, `test_every_github_endpoint_targets_a_configured_repo`, `test_no_hardcoded_single_repo_constant` |
| **AC2** — PR identity in every emitted collection is repo-qualified, so `workspace#83` and `sindustries#83` coexist without colliding | Two same-numbered PRs from different repos are pushed through `classify_github_prs` and must both survive in the same collection, with distinct `id`s. A separate test proves a linked delivery URL in the workspace repo is fetched from the workspace repo (the URL parser no longer discards owner/repo). | `test_repo_qualified_ids_coexist_across_repos`, `test_linked_delivery_pr_is_fetched_from_its_own_repo` |
| **AC3** — a regression test proves both repos are actually projected; the "empty list means no coverage" false-clean shape is impossible | `repoCoverage` carries one record per configured repo, and a repo whose fetch fails is reported `degraded` with a reason rather than silently contributing nothing. Partial failure is proven to degrade only the failing repo. | `test_repo_coverage_reports_every_configured_repo`, `test_failed_repo_fetch_is_reported_not_silently_empty` |
| **AC4** — any queue-produced item identifies its repository | Every item in all four PR collections is asserted to carry a non-empty `repo`, an `id` of exactly `<repo>#<number>`, and a `url` whose path contains the repo. | `test_every_emitted_pr_item_identifies_its_repo` |

### E2E coverage note

None of the four ACs is user-visible app behaviour. AC1–AC4 are properties of a read-only agent script's output contract, so the appropriate verification layer is the **unit/integration suite** that drives the scanner with a fake `gh api`. An E2E test through the OpenClaw heartbeat would assert the same facts at ten times the cost and with a live GitHub dependency, so it is deliberately not planned; the unit suite already exercises the real classification and hydration code paths with only the network boundary mocked.

---

## Test plan

**Command** (the exact command CI runs, `.github/workflows/ci.yml:113`):

```bash
python -m unittest discover -s agents/skills/ops/tasks-api/scripts -p 'test_*.py'
```

**Manual verification before the PR is opened:**

```bash
# 1. Both repos are projected, with coverage per repo.
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 \
  agents/skills/ops/tasks-api/scripts/agent_task_queue.py \
  --assignee Rowan --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["scannedRepos"]); print(json.dumps(d["repoCoverage"], indent=2)); print([i["id"] for i in d["reviewRequests"]])'

# 2. The workspace review requests that were structurally invisible now appear.
#    Expected at design time: workspace#83, workspace#85, workspace#87, workspace#88.

# 3. The repo set is a parameter, not a constant.
python3 agents/skills/ops/tasks-api/scripts/agent_task_queue.py \
  --assignee Rowan --repos Stoffer-Industries/sindustries --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["scannedRepos"], [r["repo"] for r in d["repoCoverage"]])'
```

**Latency check.** The heartbeat slot is the binding constraint, so the parallel fan-out must be confirmed: compare `--verbose` wall-time output before and after. The total must stay within the pre-change envelope (not 2×).

---

## Open questions

**Q1 — should the repo set be uniform across agents, or per-agent?**
This design proposes one default set for every agent, overridable with `--repos`. The workspace repo holds shared agent infrastructure (runbooks, cron definitions, infra docs) rather than app code, so it is plausibly relevant to every agent — but Ivy and Quinn may have different working patterns. **Recommendation:** ship the uniform default, because a per-agent default is one more thing that can silently diverge. If an agent genuinely needs a different set, the `--repos` flag already provides it without a code change.

**Q2 — does the workspace repo's reviewer set need to differ from sindustries'?**
The design keeps `_blocking_reviewers` agent-based, on the grounds that the same agent identities (Quinn, Rowan, Ivy, Ash, Lox) and the same "Quinn is the blocking reviewer, Tom is visibility-only" convention apply in both repos. **Question for Quinn:** is that convention actually correct for workspace PRs, where the authoring agent is usually Quinn herself? If workspace PRs need "the requester is the blocker" rather than "Quinn is the blocker", that is a repo-aware reviewer table and belongs in a separate design.

**Q3 — should the queue show workspace PRs to agents who have not asked for them?**
Today `fetch_github_prs` includes a PR only if the agent authored it or is a requested reviewer. Workspace PRs #83/#85/#87/#88 all request `rowanstoffer`, so they appear for Rowan. If a future workspace PR requests no agent reviewer (as #83 and #84 were reported to have done on 2026-10-29), it remains invisible. **Question for Quinn:** should the queue also surface unassigned PRs as a "nobody is watching this" signal? That is a new queue kind with new routing, and it is deliberately out of scope here — but it should be a conscious decision rather than a repeat of the same gap.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Latency doubles** — the scan now covers twice the repos, and the current per-PR hydration is serial | Medium | Move hydration to the existing bounded `ThreadPoolExecutor` fan-out; verify with `--verbose` wall-time before/after. The 2026-08-20 hang design's contract (wall time bounded by max, not sum) is preserved and extended. |
| **Rate limiting on `gh api`** — roughly double the API calls per heartbeat | Medium | The list call per repo is cheap; only PRs authored by or requesting the agent get hydrated (4 of 8 open workspace PRs today are relevant to Rowan). Per-call timeout stays at 10s and per-repo failures degrade one repo only. |
| **Identity scope** — an agent whose token can read `sindustries` but not `workspace` would see one repo's coverage degrade | Low | `repoCoverage` names the failing repo and its reason; `_is_identity_provisioned` already guards the whole-hydration case. Rowan's profile was verified to read both repos at design time. |
| **Downstream consumers keying on bare `number`** | Low | The new `id` field is additive; `number` stays. `build_unified_queue` already prefers `id`. Consumers in this repo are `agent_task_queue.py` itself, the heartbeat `HEARTBEAT.md` instructions (which read `kind`, not `number`), and the `pending_tech_design_approvals.py` helper (Tasks API scoped, untouched). |
| **The queue's daily shape changes** — once workspace PRs are visible, `reviewRequest` outranks `task` in `QUEUE_KIND_ORDER`, so Rowan's top candidate becomes a workspace review rather than his current task | Certain (intended) | This is the task working. It is called out in the task comment so the next heartbeat's owner understands why the queue order changed. The four workspace reviews are real work that was already owed. |
| **A second scanner creeps into the workspace repo** | Low | The design states one-scanner-two-repos explicitly, and the copy is in the system doc on ship. |
