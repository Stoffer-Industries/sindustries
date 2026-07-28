---
title: Agent Incidents
type: System reference
last_updated: 2026-07-13
owner: Rowan
repos: Stoffer-Industries/sindustries
related_pr: 214
shipped_date: 2026-07-11
---

# Agent Incidents

**Type:** System reference (keep updated as the unified schema evolves)
**Last updated:** 2026-07-13
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries` (parser, schema, migration script)
**Related PR:** https://github.com/Stoffer-Industries/sindustries/pull/214 — task 75ec1c8c
**Shipped date:** 2026-07-11

## Purpose

Quinn (workflow/pipeline anomalies) and Lox (infra/host reliability) both maintain operational incident state files in the workspace. Before task 75ec1c8c, the two files used divergent shapes — Quinn's `brain/state/quinn-ops-state.json` used an `ops` key and lacked `recurrenceCount`/`nextRetryAt`/`details`; Lox's `brain/state/lox-incident-state.json` already used an `incidents` key but lacked `firstSeen`/`attempts`/`needsTom`/`severity`. Quinn's heartbeat had to branch on the two formats to roll up cross-agent incidents. This system doc is the durable record of the unified schema and the shared parser.

Related systems: `docs/systems/agent-orchestration.md` (agent map), `docs/systems/tasks.md` (feature-task gates; unrelated but co-located).

## Architecture and ownership

- **Quinn writes** `brain/state/quinn-ops-state.json` (top-level key `incidents`).
- **Lox writes** `brain/state/lox-incident-state.json` (top-level key `incidents`).
- Each agent owns its own file. There is no shared network state file and no IPC. The two files are read-only from the perspective of the *other* agent.
- The unified schema (`agents/schemas/agent-incident-state.schema.json`, JSON Schema 2020-12) is the superset both files must conform to. The schema marks only `owner` and `status` as required; the rest default to safe values on read so legacy entries still validate.
- The shared parser (`agents/lib/incident_state.py`) reads both files, normalizes legacy shapes on the fly, and returns a flat list of unified incident records. Quinn's heartbeat calls this on every tick.

## Runtime behaviour

1. When an agent detects an incident (failed cron, blocked workflow, stale pipeline item), it upserts a stable slug-keyed entry in its `incidents` map. A logical task/gate failure has at most one active entry; repeated observations increment `attempts` and refresh `lastCheckedAt` rather than creating a new dated key.
2. Each entry carries enough context (`lastAction`, `details`, `linkedPr`, `linkedRunbook`) for Tom to triage without opening the agent's logs.
3. On every heartbeat tick, Quinn calls `agents.lib.incident_state.load_all_incidents()`, reports the queue as separate actionable and monitored counts, and surfaces anything matching `needs_tom()` (entries where `needsTom` is True OR `severity` is `high`/`critical`). Resolved and false-positive entries are excluded from both counts.
4. Lox's daily-review script is the source of most Lox entries; Lox's heartbeat updates existing entries (increments `attempts`, refreshes `lastCheckedAt`, sets `nextRetryAt`, marks resolved) but does not create new entries outside of the daily review.
5. Quinn's heartbeat updates existing Quinn entries in place and never mutates Lox entries (read-only on Lox's file).
6. Quinn escalates to Tom via Telegram the first time a `needsTom` entry has `escalatedAt == null`, then sets `escalatedAt`. Quinn does not re-escalate already-escalated items unless they are updated.

## Data contract

The unified entry shape (top-level `incidents` map, slug keys → entry dict):

| Field | Type | Required | Default on read | Description |
|---|---|---|---|---|
| `owner` | `"lox"` \| `"quinn"` | yes | (filename-derived) | Which agent owns this entry. |
| `status` | `"watching"` \| `"escalated"` \| `"resolved"` \| `"false_positive"` | yes | `"watching"` | Current state. Legacy Lox `"repair_attempted"` → `"watching"`; legacy `"blocked"` → `"escalated"`. |
| `severity` | `"low"` \| `"medium"` \| `"high"` \| `"critical"` | no | `"medium"` | `high` and `critical` are auto-surfaced to Tom. |
| `firstSeen` | ISO-8601 UTC | no | `now()` | When first observed. |
| `lastCheckedAt` | ISO-8601 UTC | no | `now()` | Most recent check. |
| `attempts` | int ≥ 0 | no | `0` | Recovery attempts. |
| `recurrenceCount` | int ≥ 0 | no | `0` | Times re-appeared after resolution. |
| `needsTom` | bool | no | `false` | Set true once escalated or severity is high/critical. |
| `escalatedAt` | ISO-8601 UTC \| null | no | `null` | First escalation time. |
| `resolvedAt` | ISO-8601 UTC \| null | no | `null` | Resolution time. |
| `nextRetryAt` | ISO-8601 UTC \| null | no | `null` | Earliest allowed next retry. |
| `lastAction` | string | no | `""` | Most recent action description. |
| `details` | object | no | `{}` | Operator-defined structured context. Open shape. |
| `linkedPr` | string | no | — | Shortcut for primary remediation PR. Mirrors `details.linkedPr`. |
| `linkedRunbook` | string | no | — | Shortcut for runbook path. |
| `followUp` | string[] | no | — | Follow-up items (tasks, PRs, notes). |
| `dailyReviewDate` | `"YYYY-MM-DD"` | no | — | Lox-specific: the daily review date that produced the entry. |

The top-level object **must** have an `incidents` key (object). An optional `_meta` key holds operator-only bookkeeping (e.g. `lastHeartbeatAt`); it is not part of the incident contract and never required.

**Legacy normalization (safety net):**
- Quinn's pre-migration files used an `ops` key and lacked `owner`, `recurrenceCount`, `nextRetryAt`, `details`. The parser reads either key and applies `_normalize_quinn_entry`.
- Lox's pre-migration files lacked `firstSeen`, `attempts`, `needsTom`, `severity`. The parser applies `_normalize_lox_entry`. If a Lox entry has `dailyReviewDate` but no `firstSeen`, `firstSeen` is derived from the daily review date at midnight UTC.
- These normalizers exist so agents can roll forward without breaking each other; they are not an excuse to leave files in legacy shape forever. The migration script (see below) brings both files to the canonical shape in one shot.

## API surface

`agents/lib/incident_state.py` exposes:

- `load_all_incidents(workspace: Path | None = None) -> list[dict]` — read both state files, return a flat list. `workspace` defaults to the `OPENCLAW_WORKSPACE` env var, falling back to `/Users/quinnstoffer/.openclaw/workspace`.
- `parse_file(path: Path, owner: str | None = None) -> list[dict]` — read one file with the legacy normalizer for that file's known shape.
- `needs_tom(incidents: list[dict]) -> list[dict]` — filter to entries where `needsTom is True` or `severity in {"high", "critical"}`.
- `validate_with_schema(state, schema_path: Path | None = None) -> None` — validate a state dict against the JSON Schema. Raises `jsonschema.ValidationError`. The `jsonschema` package is imported lazily so the hot `parse_file()` path does not need it installed.

The live state was migrated separately before this PR was opened. State files
remain outside the repository and are not committed; the parser's legacy
normalizer remains as the compatibility path for any older shape encountered
at read time.

## Runbook notes and common failure modes

**Adding a new incident slug:** choose a stable kebab-case identifier derived from the failure pattern (e.g. `tasks-api-prod-down`, `firewall`, `bookmark-acpx-openai-401-no-scopes`). Slugs must be stable — they are how cross-recurrence is detected. Do not append observation dates to incident keys. For task workflow findings, include the task prefix and gate in the stable identity, for example `feature-task-0bda7aa7-ready_checks` or `backlog-spec-missing-87744315`.

There must be one active entry per logical task/gate. Repeated observations
update that entry's `attempts`, `lastCheckedAt`, and `lastAction`. Use
`recurrenceCount` only when a previously resolved incident reappears.

**Marking an incident resolved:** set `status: "resolved"` and `resolvedAt: <now>`. Do not delete the entry — keep it for `recurrenceCount` trending. If the same failure reappears, increment `recurrenceCount` rather than creating a new entry.

**Escalation policy:** Quinn auto-escalates the first time a `needs_tom` entry has `escalatedAt == null`. Quinn does not re-escalate already-escalated items unless they are updated with new evidence.

**`recurrenceCount`:** the number of times the same slug has re-appeared after resolution. Use it to drive runbook improvements — a recurring slug with a runbook that keeps failing means the runbook is wrong, not the agent.

**Common failure modes:**
- *Malformed JSON:* the parser logs a warning and treats the file as empty (so heartbeat does not crash).
- *Missing owner field on a legacy entry:* defaults to the filename-derived owner (`quinn-ops-state.json → "quinn"`, `lox-incident-state.json → "lox"`).
- *Legacy status `"repair_attempted"` (Lox):* mapped to `"watching"` so the entry stays open and visible.
- *Legacy status `"blocked"` (Lox):* mapped to `"escalated"` so it auto-surfaces to Tom.
- *Schema drift:* if either agent writes a shape that doesn't normalize, the parser logs a warning and emits a best-effort entry. The schema validator catches drift at write-time when `jsonschema` is installed.
- *Cross-agent correlation:* out of scope for this task. A future task can join entries by slug to detect incidents affecting both agents at once.

## State and `.openclaw` boundary

The state files live in `brain/state/` in the workspace, NOT in this repo. The
PR does not commit them. The live files were migrated separately with backups
and schema validation before this PR was opened; rollback remains an
operator-level restore of those backups if ever required.

The HEARTBEAT.md files (`agents/definitions/quinn/HEARTBEAT.md`, `agents/definitions/lox/HEARTBEAT.md`) are doc/instruction files in this repo and ARE modified by this PR. They are agent instruction files, not runtime state.

## Related specs, tasks, and PRs

- **Task:** 75ec1c8c — Unify agent incident schema across Quinn and Lox
- **Tech design:** `docs/specs/unify-agent-incident-schema-tech-design.md`
- **Idea doc:** `brain/ideas/unified-agent-incident-schema.md`
- **JSON Schema:** `agents/schemas/agent-incident-state.schema.json`
- **Parser:** `agents/lib/incident_state.py` + `agents/lib/test_incident_state.py`
- **Live migration:** completed separately before this PR; no migration utility is shipped in the repository.
- **Heartbeat docs:** `agents/definitions/quinn/HEARTBEAT.md`, `agents/definitions/lox/HEARTBEAT.md`

## Lifecycle / update rules

- When an agent adds a new top-level field to an incident entry, update this doc first, then update the JSON Schema, then update the normalizer in `incident_state.py`, then update the tests, then update the agent's HEARTBEAT.md so it writes the new field.
- When an agent adds a new top-level file (e.g. Ivy starts tracking incidents), add the file path to `load_all_incidents()`, update the parser, update this doc.
- Schema changes that break backwards compat (dropping a required field, renaming a key) require bumping the JSON Schema `$id` and adding a `v2` normalizer. Out of scope for now.
