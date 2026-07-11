# Lox Heartbeat

Purpose: catch and safely advance reliability issues between scheduled cron runs — across all agents, not just Lox's own infra checks.

My operating principles are in `SOUL.md`. The 3-rule framework (investigate → permanent fix → runbook) applies to everything I encounter here.

Do not run broad maintenance or updates from heartbeat. Exact scheduled checks belong in cron.

## Incident feed

Incidents are created in Telegram DMs with Tom channel by cron and heartbeat agents when a failure is detected. Lox reads new messages from that channel, investigates, applies fixes if safe, and escalates to Tom with `openclaw message send --channel telegram --account lox --target 6435140143 --message "<message>"`.

Heartbeat keeps incident state in `brain/state/lox-incident-state.json` to avoid repeating the same recovery attempt on every run.

> **Path convention:** All paths in this document are relative to the workspace root (`/Users/quinnstoffer/.openclaw/workspace/`). The incident state file lives at `brain/state/lox-incident-state.json` — do NOT create a duplicate under `agents/lox/brain/` or any other agent-specific subfolder. The canonical location is shared across all agents.

## Procedure

Heartbeat has one primary input:

1. The latest Lox daily review path recorded in `brain/state/lox-latest-daily-review.txt`.

**Pre-flight self-check (run BEFORE the procedure):** confirm the OpenClaw gateway config is loadable. If `openclaw cron list` errors with `Invalid config at .../openclaw.json: agents.list.<N>.heartbeat: Invalid input`, the gateway has rejected the whole config and no agent heartbeats are firing — including this one. **The procedure below assumes the heartbeat is reaching you; if it isn't, none of it runs.** This check is what would have caught the 2026-06-07 outage (9h 53m of silence caused by Ivy's `isoatedSession` typo) without Tom having to probe.

```bash
# Pre-flight: confirm config validates. Capture stderr for diagnosis.
if ! err=$(openclaw cron list 2>&1 >/dev/null); then
    # Gateway config is broken. Do NOT continue with the procedure — it depends on
    # the heartbeat reaching us, and if cron list errors, the gateway is rejecting
    # the config and no heartbeats are firing.
    if echo "$err" | grep -q "heartbeat: Invalid input"; then
        # Likely the typo pattern. Backup, locate the broken block, and escalate.
        cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y-%m-%d-%H%M)
        # Show Tom the broken block via Telegram
        openclaw message send --channel telegram --account lox --target 6435140143 --message "Gateway config invalid — all heartbeats blocked. Error: $err. Backup created. Broken block: $(grep -B1 -A8 \"heartbeat\" ~/.openclaw/openclaw.json | head -40). Lox cannot auto-fix per SOUL guardrails — please review and either apply the fix yourself or explicitly approve Lox to apply it."
        # DO NOT auto-restart, DO NOT auto-fix. Tom must approve.
    else
        # Unknown config error — escalate
        openclaw message send --channel telegram --account lox --target 6435140143 --message "Gateway config error — all heartbeats blocked. Error: $err. Investigating."
    fi
    exit 0
fi
```

This self-check should run on every heartbeat cycle, not just when something looks wrong. It's a **silent-failure detector** — a class of check that catches the cases where the absence of activity is itself the bug.

On every heartbeat:

1. Read `infra/RUNBOOKS.md`.
2. Read `brain/state/lox-incident-state.json` if it exists.
3. Read the latest daily review for today if it exists.
   - Prefer the exact path in `brain/state/lox-latest-daily-review.txt`.
   - If that pointer is missing, fall back to the canonical path `brain/infra/daily-reviews/lox-daily-YYYY-MM-DD.md`.
4. Derive stable incident keys for each.
   - Use the checked item text when possible, e.g. `tasks-api-prodlike-down`.
   - Include the daily review date in the state entry, not in the incident key.
5. For each unresolved item:
   - If state is `resolved`, skip it.
   - If state is `repair_attempted` or `blocked` and `nextRetryAt` is still in the future, skip it.
   - Otherwise, look up the runbook in `infra/RUNBOOKS.md`.
6. For each unresolved item that maps to a safe automatic runbook, run that runbook's status command.
7. If the status is healthy, write/update state as `resolved` and stay quiet unless another item needs action.
8. If the status is unhealthy and the runbook says repair is safe, run the repair command once.
9. Verify the service after repair.
10. Update state (unified agent incident schema — task 75ec1c8c, see `docs/systems/agent-incidents.md`):
    - repair succeeded + verify healthy: `status: "resolved"`, `resolvedAt: <now>`
    - repair attempted + still unhealthy: `status: "watching"`, `nextRetryAt` at least 2 hours in the future, increment `attempts`
    - repair blocked/not safe/no runbook: `status: "escalated"`, `nextRetryAt` tomorrow unless new evidence appears, set `needsTom: true`

    Lox must also record the four new unified fields the schema requires:
    `firstSeen` (ISO-8601 UTC; fall back to `dailyReviewDate` if absent),
    `attempts` (int ≥ 0), `needsTom` (bool, true when escalated), and `severity`
    (one of `low`/`medium`/`high`/`critical`). The shared parser
    (`agents/lib/incident_state.py`) auto-fills missing values, but Lox should
    record them at write time so the live file validates against the schema.

    The legacy statuses `repair_attempted` and `blocked` are accepted by the
    parser and normalized to `watching` / `escalated` respectively. Stop using
    them in new writes; only emit the canonical four (`watching` /
    `escalated` / `resolved` / `false_positive`).
11. Escalate to Tom with `openclaw message send --channel telegram --account lox --target 6435140143 --message "<message>"` when:
    - a repair was attempted, or
    - a repair is blocked/failed, or
    - a non-safe issue needs human action.
12. If no open incidents, do not sweep and do not send a message.

## Failure Response Framework

See `SOUL.md` for the 3-rule framework. Shorthand:
- No runbook for a recurring failure → investigate, fix if safe, create the runbook.
- Runbook exists but repair fails → report to Tom, set `repair_attempted` with `nextRetryAt` 2h out.
- Cause unclear → report findings and wait for approval before applying anything.

When in doubt, report and wait. Never apply an unapproved permanent fix.

### Owner notification (parallel to runbook, not after)

A runbook captures the failure pattern. It does NOT fix the root cause. When Lox can identify:
- the **bug** (specific, not just symptoms), AND
- the **fix** (concrete options, ideally ranked by effort/risk), AND
- the **owner** (which agent or human can actually change the offending code),

…then Lox should notify the owner **in the same turn** as creating/updating the runbook, not wait for a 3rd recurrence or a Tom escalation. Don't pre-stage the runbook and hope someone reads it.

Default routing (verify against current SOUL):
- **Quinn** owns: personal-assistant/cron work, the `bookmark-review-lobster` cron, the code-factory lobster, the `tasks-api` workflow. Quinn's main session is `agent:quinn:main`.
- **Rowan** owns: builder work, product feature implementation, deployed product code. (See SOUL Out-of-Scope note.)
- **Tom** is the human approval authority for fixes that aren't clearly safe/reversible. Use the Telegram message CLI, not `sessions_send` to Tom.
- **Unknown owner** → use `sessions_send` to the agent whose cron emitted the failure, OR ask Tom.

The notification is a heads-up, not a demand. Keep it short: bug, root cause, why-Lox-can't-fix, fix options, tracking pointer. Let the owner decide priority and routing.

## State Shape

```json
{
  "incidents": {
    "tasks-api-prodlike-down": {
      "dailyReviewDate": "2026-05-27",
      "status": "resolved",
      "lastCheckedAt": "2026-05-27T09:20:00Z",
      "lastAction": "repair succeeded",
      "nextRetryAt": null
    }
  }
}
```

## Guardrails

- Never reset, migrate, seed, or delete databases from heartbeat.
- Never kill existing listeners automatically.
- Never run macOS updates, OpenClaw updates, or gateway restarts from heartbeat.
- If the safe repair path does not match the observed failure, report and stop.

## Heartbeat-staleness check (peer agent main sessions)

The OpenClaw native heartbeat is a separate path from cron and is only routed to sessions whose **provider is the OpenClaw gateway** (`openclaw`, `minimax-portal`, etc.). Sessions on `claude-cli` (Claude Code CLI proxy) get user-prompt traffic but no native heartbeat. A `claude-cli` session that reaches a clean terminal state will sit idle indefinitely until Tom (or some external trigger) sends a new message or runs `/reset`.

When scanning peer agent sessions during heartbeat, apply this check. **Important**: for agents with `isolatedSession: true` (ivy, quinn, lox), heartbeats go to isolated sessions — check the latest *heartbeat* session, not the main session. Only check the main session for agents with `isolatedSession: false/absent`.

```
# Read openclaw.json agents[].heartbeat to get each agent's real cadence and isolatedSession flag
for agent in [quinn, lox, ivy, rowan, ...known agents]:
    if agent.heartbeat.every == 0 or agent.heartbeat absent:
        skip  # heartbeat disabled
    
    isolated = agent.heartbeat.isolatedSession  # true for ivy, quinn, lox
    expected_cadence_min = agent.heartbeat.every_in_minutes
    # Current values (verify against openclaw.json): ivy=240, quinn=30, lox=120, rowan=0 (disabled)
    
    if isolated:
        session = latest session with key matching agent:<agent>:main:heartbeat
        # (the native heartbeat creates/reuses this session for isolated agents)
    else:
        session = latest transcript of agent:<agent>:main
    
    if session is null:
        FLAG: "<agent> has no heartbeat sessions at all"
    else:
        last_msg_ts = session.endedAt
        age_min = (now - last_msg_ts) / 60
        if age_min > 3 * expected_cadence_min:
            FLAG: "<agent> heartbeat session is stale: <age_min> min since last run (expected ~<expected_cadence_min> min)"
            provider = session last assistant provider  # verify it's minimax-portal / openclaw, not claude-cli
            if provider == 'claude-cli':
                ROOT CAUSE: "session is on claude-cli provider, which does not receive native heartbeat"
                RECOMMEND: "Tom to run /reset in <agent>'s webchat (puts new session on openclaw provider) or migrate <agent> to gateway provider long-term"
            else:
                RECOMMEND: "page Tom — heartbeat not reaching this session for a non-provider reason"
```

This check is the **same diagnostic that caught Ivy's stall on 2026-06-05** (her main session was idle for 2 days 23 hours on the `claude-cli` provider; Tom reset it and the heartbeat resumed). Future-Lox should run this check on every heartbeat cycle, not just when Tom asks.

**Known false-positive history (2026-06-07):** Lox incorrectly flagged Ivy's main session as stale because (a) the staleness check was reading the wrong session type for isolatedSession agents, and (b) the expected cadence was listed as 10 min when the actual config is 4h. Both bugs are fixed in this update.

See `infra/runbooks/agent-main-session-stale-no-heartbeat.md` for the full diagnostic + recovery procedure.
