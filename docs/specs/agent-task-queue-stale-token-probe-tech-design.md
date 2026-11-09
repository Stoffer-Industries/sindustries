---
status: draft
task_id: 76f00654-e31d-485b-9dcb-50305d021800
product_spec: "n/a"
shipped_pr: null
shipped_date: null
---

# Stale GitHub env token must not silently empty the agent task queue — tech design

> **Scope note (2026-11-10).** This task already carried a
> `[tech-design-not-required]` waiver (the spec author embedded the design and
> the patch in the task description) and Quinn's structured `tech_design`
> approval of 2026-10-10. The implementation on this branch therefore follows
> the **approved minimal scope** — a probe-and-fallback inside `_gh_api`, plus
> its test ladder and the runbook/system-doc updates — and deliberately does
> **not** implement the wider shared-helper boundary described below. The
> shared helper in `agents/lib/github_cli.py`, the `credentialSource` envelope
> field, and the identity-mismatch hard-degrade are proposed here for a
> follow-up task and need their own approval; this document records the
> reasoning, not a commitment to that shape.

## Product spec link

- Product spec: inline in the task description (no brain spec file). Task `76f00654` — "🔧 Harden agent_task_queue.py: probe-and-fallback on 401 instead of unconditional env-injection". Spec authored by Lox at Rowan's explicit ask; Rowan owns implementation and review.
- Source-of-truth context: `brain/ops/retro-notes/2026-09-16.md` (workspace repo) rows `agent-task-queue-script-stale-env-var-bad-credentials` and `heartbeat-status-update-spam-stable-blocker`.
- Existing runbook: `infra/runbooks/agent-github-identity-profile-unprovisioned.md`.
- Related shipped design: `docs/specs/ambient-gh-token-overrides-profile-tech-design.md` (task `b0d1b42e`, PRs #718/#726/#727/#728/#729) — that design removed the *ambient* token override; this design covers the *stale per-agent* token that survives the ambient cleanup.

## Product intent summary

The heartbeat's single source of work truth is `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`. It reads GitHub through a per-agent `GH_CONFIG_DIR` profile and an optional per-agent token env var (`ROWAN_GITHUB_TOKEN`). The script injects that token unconditionally. When the token in the process environment is **stale** (revoked or rotated out from under a long-lived session), every `gh api` call fails with `Bad credentials (HTTP 401)`, the PR-hydration fan-out degrades, and the queue reports **no PR work at all** — indistinguishable from "nothing to do". That is the exact failure that has repeatedly produced false "nothing assigned" conclusions and skipped heartbeat steps.

The fix must:

1. Never let a rejected token silently masquerade as a working credential.
2. Fall back to the cached keyring credential at `GH_CONFIG_DIR` when the env token is rejected, so the queue keeps working without operator intervention.
3. Never authenticate as a *different agent* as a side effect of the fallback.
4. Say clearly, on stderr and in the JSON envelope, which credential source was actually used — so Lox can attribute the cause in a soft-fail escalation without reading process internals.

## Task / branch / worktree

- Task ID: `76f00654-e31d-485b-9dcb-50305d021800`
- Title: 🔧 Harden agent_task_queue.py: probe-and-fallback on 401 instead of unconditional env-injection
- Branch: `task-76f00654-harden-agent-task-queue-token-probe`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/rowan-76f00654-token-probe`
- Repository: `sindustries` (`Stoffer-Industries/sindustries`)
- Workstream: Rowan owns AC1–AC4. Quinn approves the design; Tom's `spec` approval remains an upstream gate on the task itself (this design does not assume it).

## Why this design exists

The 2026-09-16 retro recorded the failure chain in detail: the parent process environment carried `ROWAN_GITHUB_TOKEN` = `ghp_ahbRK…` while `~/.openclaw/.env` had already been rotated to `ghp_AJfS5…`. Every `gh api` call returned `HTTP 401`; the queue returned empty PR state; three Lox escalations were raised for what turned out to be one stale environment variable, and the documented workaround (`set -a; source ~/.openclaw/.env; set +a`) had to be re-derived each time. The task spec (Lox) proposes the probe-and-fallback fix; this document is the design Quinn approves before implementation starts.

## Problem statement

Current behaviour, in `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`:

```python
def _gh_api(config_dir: str, token_env: str, endpoint: str) -> Any:
    token = os.environ.get(token_env)
    env = gh_env(config_dir=config_dir, token=token)   # -> OPENCLAW_GH_TOKEN
    ...
```

`gh_env` (`agents/lib/github_cli.py`) strips ambient `GH_TOKEN`/`GITHUB_TOKEN` and proxy vars, then hands the caller's token to the wrapper `agents/lib/github-cli.sh` as `OPENCLAW_GH_TOKEN`. The wrapper exports it as `GH_TOKEN` for the child `gh`. `gh` prefers the env token over the `GH_CONFIG_DIR` keyring credential, so a stale token wins over a perfectly good keyring credential.

Consequences:

1. `_gh_api` raises `subprocess.CalledProcessError` on 401 for every endpoint.
2. `fetch_github_prs` catches it per repo and records `repoCoverage[repo].status = "degraded"`, `reason = "gh-api-failure: exit 1"`.
3. The review-request / merge-candidate / authored-feedback sections of the queue all come from that hydration, so they come back **empty**.
4. `_is_identity_provisioned` returns `True` because the token env var *is set* — the stale value makes the script believe it is authenticated.

An empty PR projection is exactly the state that has produced false "nothing assigned" conclusions. `docs/systems/tasks.md` already requires that a silent empty list must not be a reachable state; today a stale token still reaches it.

## `.openclaw` boundary notes

- **Out of scope (operator authority):** rotating or refreshing `~/.openclaw/.env`, restarting an agent session so it picks up a fresh value, and any gateway change to refresh agent env at heartbeat turn start. These are explicitly excluded by the task spec. Rowan cannot write to `~/.openclaw/`.
- **In scope (this repo):** the script must keep working when the operator has not yet acted, and must make the stale credential visible so the escalation carries the right cause.
- The fallback is a **read-path resilience** measure, not a credential-refresh mechanism. The operator still owns the fix for the underlying stale value; this design makes the symptom non-silent and non-destructive in the meantime.
- If an `[openclaw-needed]` comment is posted, it records only the exact variable name (`ROWAN_GITHUB_TOKEN`), the file that must be refreshed (`~/.openclaw/.env`), and the rollback (`unset` the var) — never a token value.

## Ownership boundary check

**Natural source of truth: the repository-owned GitHub credential policy layer** — `agents/lib/github_cli.py` (env construction) + `agents/lib/github-cli.sh` (the wrapper that strips ambient credentials/proxies and decides what `gh` sees). That layer already owns this policy deliberately: *"All repository-owned `gh` subprocesses must enter through this wrapper. Keep proxy and ambient-token policy here so Python, Rust, and shell callers cannot drift apart again."*

**Why the shared layer, not the queue script alone.** Credential validity is a property of the credential, not of one caller. Putting the probe inside `_gh_api` would fix only the queue script and leave the next caller to rediscover the same 401. Today `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` is the only Python caller that passes a token (`agents/workflows/content-tasks/scripts/common.py` calls `gh_env(config_dir=...)` with no token), so the immediate blast radius is one caller — but the helper must live where a second caller can adopt it without copying logic.

**Why not the wrapper script (`github-cli.sh`).** The wrapper cannot probe without executing `gh` twice per call. The queue fans out to ~12 PR URLs × ~3 endpoints each; a per-invocation probe would add ~36 extra `gh api user` calls per heartbeat. Probing once per process, in Python, is both cheaper and observable.

**Why not a "fix the env" approach (source the `.env` inside the script).** It would make the script read a file outside the repo, resolve secrets itself, and silently pick a different identity than the one the session was launched with. Out of the repo's boundary and out of scope per the task spec.

**Durable vs interim.** The durable boundary is "the shared helper resolves *which credential to use*, and every caller asks the helper". This design builds that boundary now rather than adding an interim `if rc == 0` in one script and migrating later. The helper is opt-in per caller, so the change stays small and reversible.

## Implementation plan

### 1. `agents/lib/github_cli.py` — new shared credential-resolution helper

Add a `GhCredentials` result and a `resolve_gh_credentials()` function:

```python
@dataclass(frozen=True)
class GhCredentials:
    source: str          # "env-token" | "keyring" | "none"
    token: str | None    # token to inject into the child env; None => use the keyring
    login: str | None    # resolved GitHub login, when a probe succeeded
    reason: str | None   # why "none" / why the fallback happened
```

Algorithm (each step uses `gh_env()` + `gh_command()` so the probe sees exactly the environment a real call would see):

1. `token = os.environ.get(token_env)`.
2. **Token present** → probe `gh api user --jq .login` *with* the token injected. Cache the result per process.
   - rc == 0 → `source="env-token"`, `token=token`, `login=<probe output>`.
   - rc != 0 → classify the failure from the captured stderr: a `401`/`Bad credentials` marker means **stale credential**; anything else means **probe error** (network, DNS, gh missing). Log a WARN to stderr in both cases and fall through to step 3.
3. **Fallback** → probe `gh api user --jq .login` with **no** token (keyring only, through the same wrapper, so ambient tokens stay stripped).
   - rc == 0 and login == the agent's expected login → `source="keyring"`, `token=None`, `login=<login>`.
   - rc == 0 but login != the expected login → `source="none"`, `reason="identity-mismatch"` — the fallback would authenticate as a different GitHub account, which is never acceptable (it would attribute another agent's PRs to this agent). The caller degrades instead of projecting.
   - rc != 0 → `source="none"`, `reason="no-valid-credential"`.
4. **No token** → step 3 directly.

The result is cached per process, keyed by `(config_dir, token_env, sha256(token))`, so the ~36-call fan-out pays the probe once. The cache key includes the token fingerprint so a rotated token is re-probed rather than inheriting a stale verdict.

**Probe hygiene (non-negotiable):**
- The probe runs through `agents/lib/github-cli.sh`, never bare `gh`. A bare `gh api user` would inherit the ambient `GITHUB_TOKEN` and could report success for the *wrong* identity, masking the very failure we are detecting.
- The probe is bounded (`safe_run` with a 5 s timeout — shorter than the script's existing 10 s `_GH_API_TIMEOUT_SECONDS`) so a hanging probe cannot consume the heartbeat slot.
- **The token value is never logged.** The WARN names the env var (`ROWAN_GITHUB_TOKEN`), the config dir, the exit code, and a redacted stderr excerpt (PAT-shaped substrings are replaced with `***`).

### 2. `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` — use the resolution

- `_gh_api` stops reading the token env directly. It asks the shared helper for the resolved credentials (cached), and passes `token=credentials.token` to `gh_env`. With a valid token, behaviour is byte-for-byte identical to today. With a rejected token, the token is simply not injected and the wrapper lets `gh` use the `GH_CONFIG_DIR` keyring credential.
- `_is_identity_provisioned` keeps its current `or` semantics (profile dir **or** token env) — it is a *precondition* check, not a *validity* check, and tightening it would re-create the "silently empty queue" failure. The new resolution result supplies the validity signal separately.
- The JSON envelope gains two fields, so the credential outcome is observable without reading stderr:
  - `credentialSource`: `"env-token" | "keyring" | "none"`
  - `credentialReason`: `null` or a short cause (`stale-token-fallback`, `identity-mismatch`, `no-valid-credential`, `probe-error`)
- When resolution ends in `source="none"`, PR hydration degrades exactly as it does today for an unprovisioned identity, but with the specific reason recorded in `repoCoverage[].reason` and `credentialReason` — so "no credential" is never confused with "no open PRs".

### 3. Tests

- `agents/lib/test_github_cli.py` — unit tests for `resolve_gh_credentials` against a stub `gh` on `PATH` (no network): valid token; stale token + valid keyring; stale token + keyring owned by another login; no token + valid keyring; no token + no keyring; probe stderr redaction; probe caching (one probe per process for N calls).
- `agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py` — queue-level behaviour: stale token still projects PRs via the keyring; valid token unchanged; neither available → same degrade path as today, with the new reason; envelope exposes `credentialSource`.

### 4. Documentation

- `infra/runbooks/agent-github-identity-profile-unprovisioned.md` — new "Stale env token" section: symptom, what the queue now does automatically, and the operator action (refresh `~/.openclaw/.env`, restart the session) plus the manual workaround for an immediate unblock (`set -a; source ~/.openclaw/.env; set +a`).
- `docs/systems/tasks.md` — short subsection under the task-queue runbook documenting credential resolution and the `credentialSource` envelope field.

## Data model / API contract changes

- **No Tasks API change.** No new task field, approval type, or state transition.
- **No database change.**
- The queue's JSON envelope gains two read-only fields (`credentialSource`, `credentialReason`). The envelope is an agent-facing diagnostic surface, not a persisted contract; consumers that ignore unknown keys are unaffected.

## Workflow / cron / skill changes

- **No cron or Lobster workflow change.**
- **No skill change.** The `tasks-api` skill documents the queue as a read-only adapter; the credential-resolution behaviour is an internal detail of that adapter.

## Test plan — AC-by-AC verification matrix

| AC | Verification layer | Test | Notes |
| --- | --- | --- | --- |
| AC1 — stale env token + working keyring returns the same data as env unset | unit (helper) + integration (queue) | `test_github_cli.py`: stale token + valid keyring → `source="keyring"`, `token=None`; `test_agent_task_queue.py`: with a stale token env, `fetch_github_prs` still returns the PR list and the review-request section is populated | No network: `gh` is stubbed on `PATH` and returns the same payload whether or not `GH_TOKEN` is set |
| AC2 — working env token behaves unchanged | unit (helper) + regression (queue) | valid token → `source="env-token"`, token injected; existing `_gh_api` tests (`test_gh_api_passes_explicit_timeout_to_safe_run`, proxy-strip test) stay green unmodified | The env passed to the child keeps `GH_TOKEN` set and proxies stripped — asserted, not assumed |
| AC3 — no env token and no keyring keeps the current failure mode | unit + integration | no token, stub `gh` exits non-zero → `source="none"`, `reason="no-valid-credential"`; queue degrades PR hydration exactly as today instead of raising | Asserts the degrade path, not an exception |
| AC4 — probe failure logs clearly enough for Lox to attribute the cause | unit (log capture) | stderr WARN contains the token env var name, the config dir, the exit code, and the fallback sentence; the token value itself never appears | Redaction asserted with a PAT-shaped token |

**E2E coverage.** Not applicable: this change has no user-visible or app-flow surface — it is a credential-selection policy inside a read-only agent script. The highest-value equivalent is the manual smoke test below, run once before the PR is marked ready.

**Manual smoke test (pre-merge, one-off):** with a deliberately stale `ROWAN_GITHUB_TOKEN` exported in the shell and a working `~/.config/gh-rowan` keyring, run `agent_task_queue.py --assignee Rowan --json` and confirm the PR sections populate, `credentialSource` is `keyring`, and the stderr WARN names the stale env var.

**Not tested (and why):** the real network path of `gh api user` — the stub exercises the same command line and env, and a live-network test would make CI depend on GitHub availability.

## Milestones

1. **M1 — shared helper + unit tests** (`agents/lib/github_cli.py`, `agents/lib/test_github_cli.py`).
2. **M2 — queue integration + envelope fields** (`agent_task_queue.py`, `test_agent_task_queue.py`).
3. **M3 — documentation** (runbook section + `docs/systems/tasks.md` subsection).
4. **M4 — delivery** (draft PR → ready-for-review → Quinn's approval → merge; `[implementer-prs]` comment).

Each milestone is independently testable and mergeable; M1+M2 ship the behaviour, M3 ships the operator guidance.

## Clarification gate

**No clarification needed because** the source-of-truth spec is the task description itself (Lox-authored, inline, with explicit ACs and an explicit out-of-scope list), the existing implementation and its call sites have been read, the shipped sibling design (`ambient-gh-token-overrides-profile-tech-design.md`) establishes the credential-policy boundary, and the two design decisions that could reasonably have gone another way are put to Quinn as explicit open questions rather than silent choices.

Assumptions:

- The per-agent keyring credential at `GH_CONFIG_DIR` is the intended identity for the agent (true for `rowan` → `~/.config/gh-rowan`; `agents/lib/github_cli.py` and `GITHUB_IDENTITIES` in the queue script are the mapping).
- A rejected token is safe to drop for the duration of the process — the fallback is read-only; the queue never mutates GitHub state.
- The operator's `.env` rotation remains the real fix; this design only removes the silent-failure and the escalation noise.

## Open questions for Quinn

1. **Identity mismatch on fallback.** Proposed: hard-degrade (`source="none"`, reason `identity-mismatch`) when the keyring credential resolves to a login other than the agent's expected one. Alternative: use it anyway with a loud warning. Recommendation: hard-degrade — silently acting as another agent violates the repo's "never use another agent's token" rule and would mis-attribute PRs.
2. **Envelope surface.** Proposed: add `credentialSource` + `credentialReason` to the queue JSON. Is that acceptable to the agents that parse the envelope, or should the signal stay stderr-only?
3. **Scope of adoption.** Proposed: build the helper in `agents/lib/github_cli.py` but adopt it only in the queue script this task; other `gh` callers (Rust workflows, `content-tasks/scripts/common.py`) adopt it in follow-ups. Confirm that matches your intent.
4. **Probe timeout.** Proposed 5 s (bounded tighter than the script's 10 s API timeout). Confirm, or prefer the 10 s default.

## Risks

- **Fallback changes acting identity** (mitigated by the expected-login check and the hard-degrade answer to OQ1).
- **Extra network call.** One `gh api user` per process (~200 ms warm), capped at 5 s worst case, amortised across the fan-out by the cache.
- **Network outage misread as a stale token.** Distinguished by classifying the probe's stderr (401/Bad credentials vs other). A non-401 probe failure falls back to the keyring, and if that also fails the queue degrades with `probe-error` / `no-valid-credential` — never a false "no PRs".
- **Secret hygiene.** The token is never printed; the WARN carries only the env var name, exit code, and a redacted stderr excerpt. The repo is public.
- **Behaviour drift for other callers.** None — the helper is opt-in; `gh_env` keeps its current signature and semantics.
- **The underlying stale env var remains.** Explicitly out of scope; mitigated by making the cause visible in the envelope and the runbook so the operator action is unambiguous.
