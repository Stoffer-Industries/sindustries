---
status: draft
task_id: 8a2df49c-791b-4f09-a37a-446fa8c6fd5d
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Consolidate subprocess timeout handling via shared `safe_run` helper

## Links and scope

- Task: `8a2df49c-791b-4f09-a37a-446fa8c6fd5d` — chore(agent-scripts): consolidate subprocess timeout handling via shared helper
- Originating incident: `agent-task-queue-gh-api-hang-2026-08-17`
- Originating PR (predecessor, minimal fix): PR #464 (merged 2026-08-17T00:57:42Z, merge commit `3981c94b`) — added `timeout=30` to the lone `_gh_api` call site
- Runbook: `infra/runbooks/agent-script-subprocess-no-timeout-hang.md`
- Incident state: `brain/state/lox-incident-state.json` key `agent-task-queue-gh-api-hang-2026-08-17` (already `resolved` from PR #464; this task does not change that unless a regression surfaces)
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-8a2df49c-agent-script-subprocess-safe-run`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-8a2df49c-agent-script-subprocess-safe-run`
- Primary surfaces: `agents/lib/` (new `subprocess_safe.py` + tests), `agents/skills/`, `agents/workflows/` (13 files migrated), `infra/RUNBOOKS.md` (runbook entry status update)

## Why this exists (not bundled with PR #464)

Originating PR #464 was right-shaped: minimal, scoped, reversible. Bundling a 13-file migration into "fix the hang" would have inflated the diff and blurred the review. Helper consolidation is a different class of change — it introduces a shared module and changes the import surface of every consumer — so it deserves its own branch, its own review, and its own merge.

## Product summary

Consolidate the systemic pattern surfaced by `agent-task-queue-gh-api-hang-2026-08-17` onto a single shared helper so the next script author cannot reintroduce the unguarded-`subprocess.run` class of bug. The originating symptom was an indefinite heartbeat hang; the helper bounds every subprocess call site under `agents/skills/` and `agents/workflows/` at a default of 30s and propagates `subprocess.TimeoutExpired` unchanged for callers to handle.

## Ownership boundary check

**Natural source of truth:** a shared Python module at `agents/lib/subprocess_safe.py`. This is a cross-script contract, not a single-call-site concern, so it belongs in the shared infra library (`agents/lib/`) — the same location that already houses `agents/lib/incident_state.py` and is re-exported via `agents/lib/__init__.py`. A per-script timeout kwarg would re-introduce the very pattern the task is closing out, so the boundary is "shared module + explicit import path" rather than "inline timeout per call".

**Rowan posture:** this is a chore, not a feature, but it is the kind of small-increment consolidation that pays off across every future call site. Per `SOUL.md`, when the durable solution (a shared helper) is about as easy as an interim shim (leaving inline `timeout=` calls in place), build the durable boundary now. The interim shape would be 13 call sites still owning their own `timeout=` kwarg — same review surface as the helper pass, but leaves the bug class open.

**No service boundary change.** No API routes, database tables, queues, cron entries, or external integrations are touched. The change is local to Python agent scripts.

## `.openclaw` boundary

None. No secrets, no OpenClaw runtime config, no cron changes. The shared module is checked into `agents/lib/` alongside `incident_state.py`.

## API surface — `agents/lib/subprocess_safe.py`

```python
from __future__ import annotations

import subprocess
from typing import Any

DEFAULT_TIMEOUT_SECONDS: float = 30.0


def safe_run(
    cmd: list[str],
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """subprocess.run with a default timeout. **kwargs forwards verbatim.

    Raises:
        subprocess.TimeoutExpired — after `timeout` seconds if the child has not exited.
            Callers own the policy (raise, retry, or record-and-skip).
        subprocess.CalledProcessError — only when `check=True` and the child exits non-zero.

    No swallowing. No entry-print log. No default for `timeout` other than the module constant.
    """
    return subprocess.run(cmd, timeout=timeout, **kwargs)


__all__ = ["safe_run", "DEFAULT_TIMEOUT_SECONDS"]
```

### Re-export

`agents/lib/__init__.py` adds `from .subprocess_safe import safe_run, DEFAULT_TIMEOUT_SECONDS` so callers can do `from agents.lib import safe_run`. Existing `from .incident_state import ...` line stays; the new line goes alongside it.

### Deliberate non-features

- **No entry-print on every `safe_run` call.** The runbook recommends `print(f"[<script>] {cmd}", file=sys.stderr, flush=True)` before each subprocess call for future hang diagnosability. AC1 of the task description explicitly omits this from `safe_run`'s contract; it is a separate follow-up chore that can land independently. Mentioned in `## Out of scope` below.
- **No `TimeoutExpired` swallowing.** Callers that want graceful degradation wrap the call site themselves. Existing `request_topic_approval.py` and `angle_model.py` already have explicit `try/except subprocess.TimeoutExpired` handlers — those are preserved across the call-site rewrites.
- **No JS-side equivalent.** Only `subprocess.run` / `Popen` / etc. in Python. `node:child_process.exec` / `Bun.spawn` are out of scope per AC4's "Python only here" boundary.

## Test plan — `agents/lib/test_subprocess_safe.py`

Per AC3, covers (b)–(e) plus a smoke test:

| # | Test | What it asserts |
|---|---|---|
| (a) | `safe_run(["true"])` | returns `CompletedProcess` with `returncode == 0` |
| (b) | `safe_run(["sleep", "5"], timeout=0.5)` | raises `subprocess.TimeoutExpired` after ~0.5s |
| (c) | `safe_run(["false"], check=True)` | raises `subprocess.CalledProcessError` |
| (d) | `safe_run(["sh", "-c", "echo hi"], capture_output=True, text=True)` | returns stdout `"hi\n"` |
| (e) | parameterized per existing inline `timeout=` in the 13-file scope | migration preserves observable behaviour (timeout duration honoured, stdout/stderr preserved, exception types unchanged) |

Tests are pure stdlib (`unittest` style to match `agents/lib/test_incident_state.py` precedent — or `pytest` if that's the convention elsewhere under `agents/lib/`; verify before committing). No new dependencies.

## AC-by-AC verification matrix

| AC | What it claims | How it verifies | Failure mode |
|---|---|---|---|
| AC1 | Helper API + default timeout + kwargs forwarding + no TimeoutExpired swallowing | tests (a)–(d) above; static read of `subprocess_safe.py` shows `**kwargs` passthrough and zero `try/except` wrapping | n/a (lint) |
| AC2 | `from agents.lib import safe_run` works | Add an import smoke to test file (e) | Module-load failure |
| AC3 | Five-test coverage of the helper | The test file itself exists and `python3 -m pytest agents/lib/test_subprocess_safe.py` exits 0 | Test failure |
| AC4 | 13 files migrated to `safe_run`; no unguarded `subprocess.*` calls remain in listed scope | Per-file `git diff --stat` shows the call-site rewrite; re-grep below returns zero hits | Missed call site |
| AC5 | Re-grep returns zero unguarded call sites in `agents/skills/` + `agents/workflows/` (excluding `.venv/`, `node_modules/`, `site-packages/`, `__pycache__/`) | Run the awk from the runbook; expect empty stdout | Any line returned = missed site |
| AC6 | `python3 -m py_compile` passes for all 13 migrated files | Iterate over the file list, run `python3 -m py_compile <path>` for each; expect exit 0 | Syntax error / import cycle |
| AC7 | `infra/RUNBOOKS.md` entry updated to "closed via chore PR — see <PR link>" | `git diff infra/RUNBOOKS.md` shows the update | n/a (text-only) |

### Re-grep verification (from the runbook)

```sh
for f in $(grep -rln --include='*.py' \
    'subprocess\.\(run\|Popen\|call\|check_output\|check_call\)' \
    codebases/sindustries/agents/{skills,workflows} \
    | grep -v '\.venv/' | grep -v 'node_modules/'); do
  awk -v f="$f" '
    /subprocess\.(run|Popen|call|check_output|check_call)\(/ {
      start=NR; depth=gsub(/\(/, "(", $0)-gsub(/\)/, ")", $0); buf=$0; next
    }
    start && NR>start {
      buf=buf"\n"$0
      depth+=gsub(/\(/, "(", $0)-gsub(/\)/, ")", $0)
      if (depth<=0) {
        if (buf !~ /timeout[ =]/) print f":"start
        start=0; buf=""
      }
    }
    ' "$f"
done | sort
```

Expected (post-migration): empty stdout. The four "already guarded but migrated for consistency" files (`request_topic_approval.py`, `content-tasks/scripts/common.py`, `angle_model.py`, `agent_task_queue.py`) become `safe_run(...)` calls without an inline `timeout=` because the helper default takes over — but the awk regex `/timeout[ =]/` would still match the `timeout=` keyword in `safe_run(timeout=...)` IF a caller passed it explicitly. To preserve a true zero-return shape, callers that previously used a non-default timeout pass it through: e.g. `request_topic_approval.py`'s 12s Telegram-CLI call becomes `safe_run(args, capture_output=True, text=True, timeout=12)` — the `timeout=12` keeps the awk happy AND preserves the tighter bound the script needs.

## Implementation plan — file/module scope

### Sequence

1. Add `agents/lib/subprocess_safe.py` with `safe_run` and `DEFAULT_TIMEOUT_SECONDS`.
2. Update `agents/lib/__init__.py` to re-export them.
3. Add `agents/lib/test_subprocess_safe.py` covering AC3 (a)–(e). Run locally; confirm green.
4. Migrate the 13 files in two sub-passes:
   - **Pass A — non-test, non-bookmark files first** (smaller blast radius, easier review):
     - `agents/workflows/feature-task/run.py` (2 sites)
     - `agents/workflows/content-tasks/run.py` (1)
     - `agents/workflows/content-tasks/scripts/common.py` (2 — already guarded, swap to `safe_run(args, ..., timeout=30)` to preserve the 30s existing bound)
     - `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/angle_model.py` (1 — already guarded with `try/except subprocess.TimeoutExpired`; preserve the except)
     - `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` (1 — PR #464 added `timeout=30,`; this PR replaces `subprocess.run([...], timeout=30, **kwargs)` with `safe_run([...], **kwargs)` so the helper default takes over. **Reviewer note:** this is the intended shape, NOT a revert of PR #464. The 30s default is identical to PR #464's explicit value; the only difference is whether the timeout is declared at the call site or inherited from the helper.)
     - `agents/skills/bookmarks/x-ingest/scripts/run_x_ingest.py` (1)
   - **Pass B — bookmark files** (largest group, batched for review):
     - `agents/workflows/bookmarks/run.py` (1)
     - `agents/workflows/bookmarks/scripts/handle_approval_reply.py` (3)
     - `agents/workflows/bookmarks/scripts/common.py` (2)
     - `agents/workflows/bookmarks/scripts/rebuild_revised_approval.py` (1)
     - `agents/workflows/bookmarks/scripts/request_topic_approval.py` (1 — already guarded at 12s; becomes `safe_run(args, ..., timeout=12)` to preserve the tighter bound)
     - `agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py` (1)
5. Migrate `agents/skills/bookmarks/x-ingest/tests/test_linked_articles.py` (1, test, lower priority — per AC4's "lower priority" annotation). Land with Pass B or as a final follow-up commit in the same PR.
6. Update `infra/RUNBOOKS.md` to reflect "closed via chore PR — see <PR link>" (AC7).
7. Re-run the awk re-grep (AC5); expect zero.
8. `python3 -m py_compile` each migrated file (AC6).
9. Smoke-run the bookmark workflow script that was the originating class of failure (`python3 agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Rowan --json` — should now finish in <2s, not hang).
10. Open PR; include the AC checklist in the PR body per WORKFLOW.md PR standards.

### Files NOT touched

- `services/` — no service changes
- `apps/` — no app changes
- `infra/runbooks/agent-script-subprocess-no-timeout-hang.md` — the runbook itself stays as the durable reference; only `infra/RUNBOOKS.md` (the index) gets the closed-via-chore note
- `agents/lib/incident_state.py` and its tests — unrelated surface

## Data model / API contract

No data model changes. The only "API" is the helper signature above — a private intra-repo Python contract. No HTTP endpoints, no DB schema, no JSON shapes.

## Workflow / cron / skill changes

None. Existing skills (`agents/skills/...`) that own the migrated scripts keep their contract unchanged from the outside. The migration is internal — same behaviour, same callers, same outputs, with the only difference being a default timeout floor where one didn't exist before.

## Open questions and risks

1. **Default timeout at 30s vs per-call-site tuning.** Two call sites currently use non-30s defaults (`request_topic_approval.py` uses 12s for Telegram CLI; `agents/workflows/content-tasks/scripts/common.py` uses 30s which matches). The migration preserves the tighter 12s by passing `timeout=12` explicitly; this is the only place the helper's default is overridden. **Risk:** if a future script's correct timeout is much smaller (e.g. <5s), the author must remember to pass it. **Mitigation:** this is exactly the same as the pre-helper world, and the helper's default is documented in its docstring. Acceptable.

2. **PR #464 sequencing risk.** The agent_task_queue.py change removes the inline `timeout=30,` kwarg that PR #464 added. A reviewer skimming the diff could read this as a revert. **Mitigation:** the AC4 reviewer note is in the PR description, and the 30s default is identical — observable behaviour is unchanged. Verified pre-write by reading PR #464 body and the current line 359 of `agent_task_queue.py`.

3. **Existing `try/except TimeoutExpired` handlers.** `request_topic_approval.py` (around line 348) and `angle_model.py` (around line 114) wrap their subprocess calls in `try/except subprocess.TimeoutExpired`. The migration must preserve these handlers — the helper does not swallow, so the exception still propagates. **Mitigation:** migration is mechanical `subprocess.run(...)` → `safe_run(...)`, leaving the surrounding `try/except` block intact.

4. **Inventory drift between PR #464 merge and this PR.** The runbook's "13 files / 18 call sites" inventory was captured 2026-08-17. If anyone has touched any of those files between then and the implementation commit, the count may have changed. **Mitigation:** the awk re-grep at AC5 verification time will surface any new call site or removed one; if the inventory has drifted, either update the implementation to match the new shape, or call out the drift in the PR description.

5. **What if a future script wants `timeout=None`?** Python's `subprocess.run` accepts `timeout=None` as "no timeout" (legacy behaviour). `safe_run` enforces a default of 30s; a caller passing `timeout=None` gets the same behaviour as before. **Mitigation:** this is documented in the docstring. No risk for the current 13-file scope.

## Out of scope (separate chores if wanted; do NOT bundle into this PR)

Per the task description's explicit out-of-scope list:

- **Entry-print on every `safe_run` call** — `print(f"[<script>] {cmd}", file=sys.stderr, flush=True)` immediately before each subprocess call. The runbook recommends this for future hang diagnosability, but it is a separate change from helper consolidation (it touches every call site again, and the helper cannot add it without owning call-site context). File as a follow-up chore if wanted.
- **`TimeoutExpired` swallowing policy at the helper layer** — graceful skip-the-task behaviour. The helper deliberately does not swallow; callers own the policy. File as a separate chore if a wrapper is wanted.
- **Migrating `node:child_process.exec` / `Bun.spawn` JS-side equivalents** — Python only here. Out of scope per AC4.

## References

- Originating PR: <https://github.com/Stoffer-Industries/sindustries/pull/464>
- Runbook: `infra/runbooks/agent-script-subprocess-no-timeout-hang.md`
- Precedent for `agents/lib/` as shared infra location: `agents/lib/incident_state.py` + `agents/lib/test_incident_state.py`
- Tech-design skill: `agents/skills/dev/tech-design/SKILL.md`
- Doc conventions: `docs/CONVENTIONS.md`