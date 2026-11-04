# Tech Design — Loopback Calls Never Break on the Secret Egress Proxy

**Task:** `73ea53f0-6a5f-4d02-ab72-59d7467510e1` — 🔧 Default NO_PROXY for Loopback Calls to Stop Silent Egress-Proxy 502s

**Product spec:** `brain/tasks/specs/open/default-no-proxy-for-loopback-calls-73ea53f0.md`

**Repository:** `Stoffer-Industries/sindustries`
**Branch:** `task-73ea53f0-no-proxy-default`
**Worktree:** `WD1/worktrees/quinn/task-73ea53f0-no-proxy-default`

---

## Current state (measured 2026-11-04)

The original observation — that loopback calls from agent processes are routed
into the secret egress proxy and fail with `502` — **no longer reproduces**.

The environment supplied to agent processes already carries:

```
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
```

A standard-library HTTP client call to the local task tracker returns `200`
with those variables present. With both removed, the identical call returns
`502 Bad Gateway`. Removing either variable alone still returns `200`, so
either spelling satisfies the exemption.

Two consequences for this design:

1. The **gap is closed at the runtime layer**, not in the repository. Nothing
   in the repo asserts it, so nothing fails if it is withdrawn.
2. The repository still carries workarounds that describe the old world. At
   least one states as fact that the environment provides no exemption.

**This design therefore does not "set NO_PROXY" — it makes the existing
guarantee durable, verifiable, and honestly documented.**

## Ownership boundary check

The natural source of truth for this feature is the **runtime environment**,
not the repository. The exemption is a property of the environment the OpenClaw
runtime hands to agent processes. The repository cannot grant it; it can only
assert it and fail when it is absent.

That makes the durable solution an **assertion plus a guard**, rather than
another configuration change:

| Boundary | Owner | What lives there |
|---|---|---|
| The exemption itself | Runtime environment | `NO_PROXY` / `no_proxy` covering loopback |
| Proof the exemption is present | Repository (this task) | A live check that fails when it is absent |
| Proof the check stays wired | Repository (this task) | CI job + merge-gate dependency + a contract test |
| Local-call hardening | Repository (this task) | Keep the proxy-free opener; correct its stated reason |

An interim shim is **not** appropriate here. The durable solution (a guard
that fails when the exemption is withdrawn) is no harder than the interim one
(a per-script bypass), and the interim option leaves the actual guarantee
unverified — which is what let this recur across four tools.

## Implementation plan

### File / module scope

| File | Change |
|---|---|
| `agents/lib/tests/test_loopback_proxy_exemption.sh` | **New.** Two-part suite: a static part that runs in CI, a live part that runs only where the runtime environment exists. |
| `agents/lib/tests/test_ci_shell_suite_coverage.py` | **New.** Contract test: every `agents/lib/tests/test_*.sh` must map to a CI job and a `merge-gate.needs` entry. |
| `.github/workflows/ci.yml` | **New** `loopback-proxy-exemption-tests` job running the static part; add to `merge-gate.needs`. |
| `agents/skills/ops/tasks-api/tasks_api_client.py` | Correct the stale justification on the existing `ProxyHandler({})` opener. Keep the opener. |
| `docs/systems/agent-runtime-environment.md` | **New.** Record the exemption, which layer owns it, and how to verify it. |

### 1. The guard — `agents/lib/tests/test_loopback_proxy_exemption.sh`

**Static part (runs in CI, no network, no proxy needed).** Asserts the
repository's own claims are true:

- No tracked file under `agents/` states that the environment provides no
  loopback exemption. This is the assertion that catches the stale comment
  in `tasks_api_client.py` and any future reintroduction of it.
- Every repo-local HTTP client that targets a loopback base URL either builds
  a proxy-free opener or documents that it relies on the runtime exemption.
  The check is derived by scanning for loopback base-URL usage, not by
  hard-coding one filename, so a new client is covered when it appears.

**Live part (runs where the runtime environment exists).** Asserts the
guarantee actually holds, and that the guard is load-bearing:

- `NO_PROXY` / `no_proxy` (either spelling) covers `localhost`,
  `127.0.0.1` and `::1`.
- A loopback HTTP call succeeds while those variables are present.
- The identical call **fails** once they are removed. This is the negative
  control: it proves the exemption is doing the work, rather than the call
  succeeding for some unrelated reason.

The live part **skips cleanly** where the runtime environment does not exist
(no egress proxy, no local service), so the same file is usable from CI and
from a heartbeat run.

### 2. Keeping the guard wired — `test_ci_shell_suite_coverage.py`

A suite that is not wired into CI is evidence that never runs — the exact
recurrence recorded in the 2026-10-26 retro note
(`regression-suite-not-wired-into-ci`). This contract test discovers every
`agents/lib/tests/test_*.sh` and requires each to appear in
`.github/workflows/ci.yml` as a `run:` step **and** in `merge-gate.needs`.

A new shell suite therefore cannot be added without being wired, which is the
only way the guard in step 1 keeps its value over time.

### 3. The CI job

A new `loopback-proxy-exemption-tests` job runs the static part of the shell
suite, and is added to `merge-gate.needs` so a failure blocks the merge. This
matches the existing `gh-with-agent-token-tests` and `gog-cli-tests` jobs.

### 4. Correcting the stale justification — `tasks_api_client.py`

The existing `urllib.request.build_opener(urllib.request.ProxyHandler({}))`
is **kept**. It is not a stale workaround — it is the only per-call guarantee
that a local Tasks API call never traverses the proxy, and it holds even if
the runtime stops providing the exemption. What changes is the comment above
it, which currently states that the environment provides no exemption. The
rewritten comment states the actual contract: the runtime provides the
exemption, this opener is belt-and-braces that does not depend on the
caller's environment, and here is the check that proves the runtime half.

### 5. Documentation — `docs/systems/agent-runtime-environment.md`

Records the exemption, names the runtime as its owner, gives the one-line
verification command, and points at the guard. An agent reading the tooling
documentation learns the exemption exists and who guarantees it, rather than
finding a per-script note telling it to strip proxy variables.

### `.openclaw` boundary notes

- The **runtime** change (providing `NO_PROXY` / `no_proxy` to agent
  processes) is outside this repository and outside this task's authority.
  This design assumes it is in place and verifies it. If it is ever withdrawn,
  the guard fails loudly — which is the intended signal, and the fix belongs
  in the runtime configuration, not in this repo.
- `~/.openclaw/openclaw.json` is likewise outside this repository. This
  design does not modify it. If the runtime's exemption turns out to be
  configured there rather than being injected by the gateway, the
  documentation in step 5 names that location; it is still not edited from
  this task.
- `agents/lib/gog-cli.sh` and `agents/lib/gog-with-direct-egress.sh` strip
  proxy variables **for a different reason** — the egress proxy presents a
  MITM leaf that the `gog` binary does not trust, which is an *external*
  destination problem. Those wrappers are **out of scope and must not be
  changed** by this task; removing their stripping would break external
  Google API calls. The only thing this task changes about them is that the
  documentation stops implying their stripping is about loopback.

## Data model / API contract changes

None. No API, schema, or persisted shape changes. This task adds a check and
corrects documentation.

## Workflow, cron, and skill changes

None. No skill behaviour changes. The live part of the guard is runnable by an
agent on demand (it is a shell script in the repo) but is not wired into any
cron; the repository-side guarantee is the CI job.

## Test plan — AC-by-AC verification matrix

| AC | Verification | Layer | Notes |
|---|---|---|---|
| AC1 | `agents/lib/tests/test_loopback_proxy_exemption.sh` — static part asserts no stale "no exemption" claim and that every loopback client is covered; live part asserts the exemption is present, the loopback call succeeds, and the same call fails once the variables are removed (negative control). | file (shell) + manual (live) | The live part skips where the runtime environment does not exist. The negative control is what proves the assertion is load-bearing. |
| AC2 | The static part runs as the new `loopback-proxy-exemption-tests` CI job, which is listed in `merge-gate.needs`; `infra/cloud/scripts/check-ci-results.py` fails the merge gate when it does not run. | CI wiring | Verified by reading the job's `needs` entry and by a failing-job simulation. |
| AC3 | The static part's stale-justification assertion fails against the current `tasks_api_client.py` comment and passes after it is rewritten. | file (shell) | Mutation-verified: the assertion is run against the pre-change comment to confirm it can fail. |
| AC4 | `docs/systems/agent-runtime-environment.md` states the exemption and its guarantee; the static part asserts that document exists and names the owning layer. | file (shell) | |
| AC5 | The same document records that the runtime owns the exemption, and the static part asserts the owning layer is named. | file (shell) | |

**E2E is not applicable.** The observable behaviour here is an environment
property of a local agent process, not an application flow. There is no
end-to-end user journey to cover, and an E2E harness would not exercise the
runtime's environment injection at all. The fallback layer is the shell
suite described above, which exercises the real environment and the real
HTTP client.

## Open questions and risks

- **Does the runtime's exemption cover every agent context?** This design
  verified the gateway-spawned agent shell. A cron-launched or otherwise
  differently-spawned process may not inherit the same environment. The live
  part of the guard skips rather than fails in that case, which means it
  would not catch that gap. **Mitigation:** the static part is the CI-guaranteed
  half; the live part is a best-effort confirmation. If a non-gateway context
  is found to lack the exemption, it becomes a follow-up task against the
  runtime rather than a change to this repo.
- **Removing the stale justification could be read as "the bypass is
  obsolete".** The comment rewrite states explicitly that the opener is
  deliberate belt-and-braces, precisely so a future reader does not delete
  it.
- **The contract test on shell-suite coverage could fail for suites added
  outside `agents/lib/tests/`.** Its discovery is scoped to that directory,
  matching where the existing suites live. Widening it is a separate change.
- **The exemption is a runtime behaviour, not a contract.** If OpenClaw
  changes how it provisions agent environments, the guard's live part is
  what detects it — but only if it is actually run. The CI-wired static part
  cannot detect a runtime change, which is why the documentation in step 5 is
  part of the deliverable rather than an optional extra.
