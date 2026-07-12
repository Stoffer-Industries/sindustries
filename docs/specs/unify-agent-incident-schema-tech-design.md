---
status: shipped
task_id: 75ec1c8c-5d53-4c9b-9c5b-97dc-982d3b841783
product_spec: brain/tasks/specs/unified-agent-incident-schema-2026-07-07.md
shipped_pr: "214"
shipped_date: "2026-07-11"
---

# Unify agent incident schema across Quinn and Lox — tech design

## Links

- Product spec: `brain/tasks/specs/unified-agent-incident-schema-2026-07-07.md` *(spec stub; design derived from the task description and idea doc)*
- Idea: `brain/ideas/unified-agent-incident-schema.md`
- Task: `75ec1c8c-5d53-4c9b-9c5b-97dc-982d3b841783`
- Quinn incident state file: `brain/state/quinn-ops-state.json` (currently `ops` key)
- Lox incident state file: `brain/state/lox-incident-state.json` (currently `incidents` key)
- Quinn HEARTBEAT (incident section): `agents/definitions/quinn/HEARTBEAT.md` (the "OPS STATE MANAGEMENT" section)
- Lox HEARTBEAT: `agents/definitions/lox/HEARTBEAT.md`
- Lox daily-review script (precedent for a Python helper that touches the state file): search under `agents/definitions/lox/scripts/` and any cron-managed helpers invoked by Lox

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-75ec1c8c-unify-agent-incidents`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-75ec1c8c-unify-agent-incidents`
- No secondary repos. The state files live in `brain/state/` in the workspace, not the repo, but the parser/normalizer and JSON Schema live in this repo's `agents/lib/` and `agents/schemas/`. The migration of existing JSON values happens via a one-shot script in `agents/lib/incident_migrate.py` run by Quinn; no automated write to live state from this PR.

## Product intent (from approved product spec + idea)

- Outcome: Lox and Quinn both track operational incidents in `brain/state/*.json` but with divergent schemas. Define a single unified superset schema, migrate both files in place, and ship a shared Python parser Quinn's heartbeat can call to roll up incidents from both agents in one pass and surface anything that needs Tom's attention.
- Why now: Quinn's heartbeat currently has to handle two formats. A shared schema removes that branching and makes cross-agent incident correlation (e.g. "is this a recurrence of something Lox saw yesterday?") trivial. Per the idea doc, no shared state file — each agent still owns its own JSON file; the only new thing is a shared schema and a shared parser.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals (per task description + idea doc):
  - No shared network/DB state file. Each agent keeps its own JSON.
  - No real-time cross-agent sync. The parser reads both files on demand; if a file is mid-write, the parser tolerates a malformed JSON (logs a warning, treats the file as empty).
  - No changes to Lox's daily review script's outputs beyond the schema.
  - No cron changes (Lox's existing cron continues to fire; the only thing that changes is what shape the resulting state file uses).

## Acceptance criteria recap

Note: the task description's "Acceptance Criteria" section enumerates seven bullets, but the "Workstreams" block at the bottom lists "ACs: AC1, AC2, AC3, AC4, AC5". The seven bullets in the body are the real list (the Workstreams block is a typo or stale numbering). This design addresses all seven.

- **AC1 — Shared schema defined.** `docs/systems/agent-incidents.md` defines the canonical schema with field semantics. `agents/schemas/agent-incident-state.schema.json` provides a JSON Schema 2020-12 document that both state files validate against.
- **AC2 — Quinn file migrated.** `quinn-ops-state.json` keys migrate from `ops` → `incidents`; each entry gains `owner: "quinn"`, `recurrenceCount`, `nextRetryAt`, `details`.
- **AC3 — Lox file migrated.** `lox-incident-state.json` entries gain `firstSeen`, `attempts`, `needsTom`, `severity` (all Lox-only fields).
- **AC4 — Quinn HEARTBEAT.md OPS STATE section updated** to write the unified schema. The new entries Quinn writes use the unified shape; old entries are rewritten on first write.
- **AC5 — Lox daily health-check scripts updated** to write unified schema fields. The Lox scripts that append to `lox-incident-state.json` gain the new fields when they record an incident.
- **AC6 — Quinn heartbeat roll-up reads both files with shared parser.** A new `agents/lib/incident_state.py` module exposes `load_all_incidents()`, `needs_tom()`, and `parse_file()` functions. Quinn's heartbeat calls these and surfaces `needsTom: true` or `severity: high|critical` from either agent.
- **AC7 — Both state files valid against new schema after migration.** After the migration script runs against the live files, `jsonschema -i <file> agents/schemas/agent-incident-state.schema.json` exits 0 for both files.

## `.openclaw` boundary

- The state files (`brain/state/quinn-ops-state.json`, `brain/state/lox-incident-state.json`) live in the workspace, not the repo. This PR does **not** commit them.
- The migration script (`agents/lib/incident_migrate.py`) is **not** executed by this PR. It is shipped as code, with a clear `[openclaw-needed]` task comment instructing Quinn (or whoever runs ops migrations) to invoke it once on the live state files. This keeps live-state mutations in the operator's hands.
- HEARTBEAT.md files (`agents/definitions/quinn/HEARTBEAT.md`, `agents/definitions/lox/HEARTBEAT.md`) **are** in the repo and **are** modified by this PR — these are doc/instruction files for the agents, not runtime state.
- The shared parser (`agents/lib/incident_state.py`) and JSON Schema (`agents/schemas/agent-incident-state.schema.json`) **are** in the repo and committed.

## Implementation plan

### File / module scope

#### Schema doc — `docs/systems/`

- **`docs/systems/agent-incidents.md`** *(new)* — Durable system spec for the unified incident shape. Required sections (per `docs/CONVENTIONS.md` §2):
  - **Architecture and ownership:** Quinn writes `brain/state/quinn-ops-state.json`, Lox writes `brain/state/lox-incident-state.json`. Each agent owns its own file. There is no shared network state.
  - **Runtime behaviour:** when an agent detects an incident, it appends a slug-keyed entry to its `incidents` map. Quinn's heartbeat calls `load_all_incidents()` and surfaces anything matching the "needs Tom" criteria.
  - **Data contracts:** the unified `incidents` shape (see below), field-by-field semantics, migration guidance from legacy schemas.
  - **Runbook notes:** how to add a new incident slug, how to mark an incident `resolved`, what `recurrenceCount` means, when to escalate to `escalated` vs `watching`.
  - **Common failure modes:** malformed JSON (parser logs and treats as empty), missing owner field (legacy entries default to filename-derived owner), missing optional fields (treated as null/default).
  - **Related specs, tasks, and PRs:** link to this task, the idea doc, the JSON Schema file.

#### JSON Schema — `agents/schemas/`

- **`agents/schemas/agent-incident-state.schema.json`** *(new)* — JSON Schema 2020-12 document. Validates a state file as a whole:
  ```json
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://sindustries.co.nz/schemas/agent-incident-state.schema.json",
    "title": "Agent incident state",
    "type": "object",
    "required": ["incidents"],
    "additionalProperties": false,
    "properties": {
      "incidents": {
        "type": "object",
        "additionalProperties": { "$ref": "#/$defs/incident" }
      }
    },
    "$defs": {
      "incident": {
        "type": "object",
        "required": ["owner", "status"],
        "properties": {
          "owner":              { "type": "string", "enum": ["lox", "quinn"] },
          "firstSeen":          { "type": "string", "format": "date-time" },
          "lastCheckedAt":      { "type": "string", "format": "date-time" },
          "status":             { "type": "string", "enum": ["watching", "escalated", "resolved", "false_positive"] },
          "severity":           { "type": "string", "enum": ["low", "medium", "high", "critical"] },
          "needsTom":           { "type": "boolean" },
          "attempts":           { "type": "integer", "minimum": 0 },
          "escalatedAt":        { "type": ["string", "null"], "format": "date-time" },
          "resolvedAt":         { "type": ["string", "null"], "format": "date-time" },
          "nextRetryAt":        { "type": ["string", "null"], "format": "date-time" },
          "recurrenceCount":    { "type": "integer", "minimum": 0 },
          "lastAction":         { "type": "string" },
          "details":            { "type": "object" }
        }
      }
    }
  }
  ```

#### Shared parser — `agents/lib/`

- **`agents/lib/incident_state.py`** *(new)* — Pure Python 3 helper module. Three public functions:
  - `load_all_incidents() -> list[Incident]` — reads both state files in the workspace, normalizes legacy shapes on the fly, returns a flat list. Malformed JSON is logged and treated as empty.
  - `parse_file(path: Path) -> list[Incident]` — reads one file, applies the legacy normalizer for that file's known shape (Quinn: legacy `ops` shape; Lox: legacy `incidents` shape), returns the unified `Incident` list.
  - `needs_tom(incidents: list[Incident]) -> list[Incident]` — filters to entries where `needsTom is True` or `severity in {"high", "critical"}`. Used by Quinn's heartbeat.
  - **Legacy normalizers (private):**
    - `_normalize_quinn_ops_legacy(entry: dict) -> Incident` — maps Quinn's legacy fields (`firstSeen`, `attempts`, `needsTom`, `severity`) onto the unified shape, adds `owner: "quinn"`, defaults `recurrenceCount`/`nextRetryAt`/`details` to 0/null/{}.
    - `_normalize_lox_incidents_legacy(entry: dict) -> Incident` — maps Lox's legacy fields (`recurrenceCount`, `nextRetryAt`, `owner`, `details`) onto the unified shape, adds defaults for `firstSeen`/`attempts`/`needsTom`/`severity` if missing.
  - **Validation:** `validate_with_schema(state: dict) -> None` — calls `jsonschema.validate` against the bundled schema file. Used by the migration script and tests; not on the hot heartbeat path (heartbeat tolerates schema drift and logs a warning).
- **`agents/lib/incident_state.py`** *(tests)* — `agents/lib/test_incident_state.py`:
  - `parse_file` returns the unified shape when fed a freshly-migrated Quinn file.
  - `parse_file` returns the unified shape when fed a legacy Quinn file (using the legacy normalizer).
  - `parse_file` returns the unified shape when fed a legacy Lox file (using the legacy normalizer).
  - `parse_file` returns an empty list and logs a warning when the file is missing or malformed.
  - `needs_tom` returns the expected subset.
  - `validate_with_schema` accepts a freshly-migrated file and rejects a clearly malformed one.
  - Round-trip: a fresh legacy Quinn file → `parse_file` → write back → `parse_file` again returns the same list (idempotency).
- **`agents/lib/incident_migrate.py`** *(new)* — One-shot migration script. Reads both live state files, applies the legacy normalizer, writes back in the unified shape. **Not executed by this PR.** Invoked manually by Quinn via `[openclaw-needed]` after the PR merges:
  ```bash
  python3 agents/lib/incident_migrate.py --workspace /Users/quinnstoffer/.openclaw/workspace --in-place
  ```
  Flags: `--dry-run` (print changes without writing), `--in-place` (write the migrated file back; default for safety is dry-run), `--schema agents/schemas/agent-incident-state.schema.json` (override default).
- **`agents/lib/incident_migrate.py`** *(tests)* — `agents/lib/test_incident_migrate.py`:
  - Dry-run produces a migrated shape without writing.
  - In-place produces a file that validates against the JSON Schema.
  - Idempotent: running migrate twice on the same file produces no further changes.

#### HEARTBEAT.md updates

- **`agents/definitions/quinn/HEARTBEAT.md`** *(modified)* — Update the "OPS STATE MANAGEMENT" section to:
  - State that entries use the unified schema (link to `docs/systems/agent-incidents.md`).
  - State that the file path is `brain/state/quinn-ops-state.json` with key `incidents` (rename from `ops`).
  - Add a one-line example of writing a new entry using the unified shape.
  - Add a step to call `python3 agents/lib/incident_state.py` (or import the module via the heartbeat's Python invocation pattern) when surfacing roll-ups.
- **`agents/definitions/lox/HEARTBEAT.md`** *(modified)* — Update the incident recording guidance to use the unified shape:
  - State that entries use the unified schema.
  - Add the four new fields (`firstSeen`, `attempts`, `needsTom`, `severity`) to Lox's recording examples.
  - Note that Lox keeps writing to `brain/state/lox-incident-state.json` (path unchanged; key already `incidents`).

### Data model summary

Two existing files, one new schema, one new parser module, one new migration script:

| File | Status | Owner |
|---|---|---|
| `brain/state/quinn-ops-state.json` | Live; key renamed `ops` → `incidents`, entries gain 4 fields | Quinn writes |
| `brain/state/lox-incident-state.json` | Live; entries gain 4 fields, key already `incidents` | Lox writes |
| `docs/systems/agent-incidents.md` | New | Rowan owns |
| `agents/schemas/agent-incident-state.schema.json` | New | Rowan owns |
| `agents/lib/incident_state.py` | New | Rowan owns |
| `agents/lib/incident_migrate.py` | New (not run by this PR) | Rowan ships, Quinn runs |

The unified `incidents` entry shape:

```json
{
  "owner": "lox" | "quinn",
  "firstSeen": "ISO-8601 UTC",
  "lastCheckedAt": "ISO-8601 UTC",
  "status": "watching" | "escalated" | "resolved" | "false_positive",
  "severity": "low" | "medium" | "high" | "critical",
  "needsTom": false,
  "attempts": 0,
  "escalatedAt": null,
  "resolvedAt": null,
  "nextRetryAt": null,
  "recurrenceCount": 0,
  "lastAction": "string",
  "details": {}
}
```

Field-by-field semantics live in `docs/systems/agent-incidents.md`. All fields are optional except `owner` and `status` (the two required-by-schema fields); the rest default to safe values on read.

### Cross-context coordination

None. The shared parser reads two files in the same workspace; no IPC, no HTTP. Both agents run in the same `brain/state/` directory.

### Workflow / cron / skill changes

- **No cron changes.** Lox's existing daily-review cron continues to fire; the script it invokes writes the unified schema instead of the legacy shape.
- **Skill changes:** none in this PR. A future `agents/skills/ops/incident-rollup/` skill could wrap `incident_state.py` for non-Quinn agents, but that's a follow-up.
- **HEARTBEAT.md changes** (described above) are doc/instruction changes, not skill changes.

### Design system usage

None. This is a backend / Python / docs change.

## Test plan

- **Unit — `agents/lib/test_incident_state.py`:**
  - Each case listed above; covers both legacy and migrated file shapes, malformed-JSON tolerance, schema validation.
- **Unit — `agents/lib/test_incident_migrate.py`:**
  - Each case listed above; idempotency, dry-run safety, schema validation post-migration.
- **Integration (manual):**
  1. Copy a legacy Quinn file fixture into a scratch workspace.
  2. Run `python3 agents/lib/incident_migrate.py --in-place` against the scratch workspace.
  3. Confirm `ops` key is gone, `incidents` key is present, each entry has `owner: "quinn"`.
  4. Run `jsonschema -i brain/state/quinn-ops-state.json agents/schemas/agent-incident-state.schema.json` → exit 0.
  5. Repeat for Lox fixture; confirm each entry now has `firstSeen`, `attempts`, `needsTom`, `severity`.
- **JSON Schema validation (AC7):**
  - Run the migration script on real fixture copies (NOT live state).
  - `jsonschema -i <file> agents/schemas/agent-incident-state.schema.json` exits 0 for both files.
- **Heartbeat roll-up smoke (manual, optional):**
  - Stand up a Python REPL, call `incident_state.load_all_incidents()` against a scratch workspace, confirm it returns the expected flat list and `needs_tom()` returns the right subset.

## Open questions / risks

- **Q1 — Schema strictness.** The JSON Schema marks only `owner` and `status` as required. The other fields are optional. This means legacy entries written without all 14 fields still validate, which keeps the migration forgiving. If we want stricter validation later, a follow-up task promotes more fields to required.
- **Q2 — Migrate vs start fresh.** Per the idea doc, this is an open question. The design migrates (preserves slug-keyed history). If Tom prefers to start fresh, the migration script supports a `--reset` flag (drops existing entries, writes an empty `incidents: {}`). Default is migrate.
- **Q3 — When does Quinn run the migration.** This PR ships the migration code. Quinn runs it manually after merge, against live state. We add `[openclaw-needed]` on the task once the PR merges so Quinn has the trigger. The migration is reversible (the script writes a `.bak` next to each file before replacing).
- **Q4 — Live state drift.** If Quinn's heartbeat writes the unified shape but the migration hasn't run yet, Quinn's heartbeat reads the legacy shape via the legacy normalizer. Both shapes work; no crash. The normalizer is the safety net.
- **Q5 — Cross-agent recurrence detection.** A future task could correlate incidents across agents by slug (e.g. the same webhook failure surfaces in both agents). The unified schema enables this; the implementation is a separate task. Out of scope here.
- **Q6 — JSON Schema validator dependency.** The shared parser uses the `jsonschema` PyPI package. Need to check whether the existing workspace Python has it available. If not, add to a `requirements.txt` or `pyproject.toml` in `agents/` (whichever is the convention). Documented in the task PR.
- **Q7 — Path conventions.** Lox's HEARTBEAT.md already documents `brain/state/lox-incident-state.json` as the canonical path (per the `> Path convention` block we observed). The design follows that; no path change.
- **Q8 — Backwards-compat window.** After the migration runs, both files are unified. But if either agent writes a legacy-shaped entry by mistake, the parser still handles it. We don't break anything by introducing the schema; we just add the superset.
- **Q9 — AC count discrepancy.** The task description's "Acceptance Criteria" lists 7 bullets; the "Workstreams" block says AC1–AC5. This design addresses all 7 (they're the real list). If Tom confirms only AC1–AC5 are in scope, drop AC6 and AC7 — but the design recommends keeping them since they're cheap and complete the picture.

## Phase 2 — Active resolution + cross-agent handoff (not yet tasked)

Tom's post-ship feedback surfaced two new capabilities that extend the unified schema into runtime behaviour. These are not part of the original AC1–AC7 scope but are the natural next step once the unified schema is live.

### AC8 — Quinn active resolution via runbooks

**Problem:** Quinn's current OPS STATE MANAGEMENT loop is passive. It detects incidents, increments `checkCount`, and escalates after N passes — but never *attempts remediation*. Lox already uses runbooks to attempt fixes before escalating; Quinn should follow the same pattern.

**Design:**

- Add remediation metadata fields to the schema (all optional, default null):
  - `attemptCount` — how many remediation attempts have been made (distinct from detection `checkCount`)
  - `lastAttemptAt` — ISO timestamp of most recent attempt
  - `nextRetryAt` — backoff fence; Quinn skips re-attempt until this time passes
  - `linkedRunbook` — path to the runbook Quinn should invoke for this incident type
- Quinn's heartbeat OPS STATE MANAGEMENT section changes from passive-log to active-remediation loop:
  1. Load all incidents where `owner == "quinn"` and status is not `resolved`/`false_positive`.
  2. For each incident, skip if `nextRetryAt` is in the future.
  3. Look up `linkedRunbook` (or fall back to deterministic default by incident type).
  4. Attempt remediation per the runbook.
  5. On success: mark `status: resolved`, set `resolvedAt`.
  6. On failure: increment `attemptCount`, set `lastAttemptAt`, compute `nextRetryAt` (exponential backoff, e.g. 15m → 30m → 60m).
  7. After N failed attempts (suggested N=3): set `needsTom: true`, `status: escalated`, `escalatedAt`, and ping Tom via Telegram.
- Missing or invalid `linkedRunbook` → escalate immediately; don't silently skip.

**Runbook stubs Quinn will need** (paths in `infra/runbooks/quinn/`):
- `task-workflow-stall.md`
- `agent-pipeline-stall.md`
- `bookmark-pipeline-stall.md`
- `feature-task-lobster-stall.md`

**Schema additions (additive, backwards-compatible):**
```json
"attemptCount":     { "type": "integer", "default": 0 },
"lastAttemptAt":    { "type": ["string", "null"], "format": "date-time" },
"nextRetryAt":      { "type": ["string", "null"], "format": "date-time" },
"linkedRunbook":    { "type": ["string", "null"] }
```

### AC9 — Lox → Quinn cross-agent handoff

**Problem:** When Lox detects a problem in Quinn's domain (lobster workflow stall, bookmark pipeline issue), it currently either misses it or escalates directly to Tom. The unified schema's `owner` field enables a cleaner path: Lox writes an incident with `owner: "quinn"` and Quinn picks it up via `load_all_incidents()`.

**Design:**

- No shared file. Each agent keeps its own state file.
- Lox writes an incident to `lox-incident-state.json` with `owner: "quinn"` and `linkedRunbook` pointing at the relevant Quinn runbook.
- Quinn's `load_all_incidents()` already reads both files — so Quinn discovers Lox-assigned incidents automatically. No polling or queue needed.
- Add optional `reportedBy` / `sourceAgent` field for provenance (so we know Lox created it, not Quinn).
- Quinn updates the incident **in the source file** (Lox's state file) when it attempts remediation or resolves. This requires `load_all_incidents()` to tag each incident with its `sourceFile` at parse time so Quinn knows where to write back.
- Lox escalates to Tom for Quinn-domain incidents **only if**:
  - The handoff itself fails (e.g. Quinn's state file is unreadable)
  - The incident is an infra/safety concern that can't wait for Quinn's next heartbeat
  - Owner assignment is ambiguous

**Domain boundary:**
- **Lox owns:** infra, containers, hosts, network, process crashes, service availability
- **Quinn owns:** task workflow stalls, agent pipeline state, bookmark pipeline, feature-task lobster stalls

**Schema additions:**
```json
"reportedBy":   { "type": ["string", "null"] },
"sourceFile":   { "type": ["string", "null"], "description": "Runtime-only: set by parser, not stored" }
```
Note: `sourceFile` is injected by the parser at load time, not persisted to disk.

### Open questions for Phase 2

- Exact retry threshold N and backoff schedule.
- Whether `reportedBy` becomes required or stays optional.
- Whether a Lox-assigned incident can be re-assigned back to Lox if Quinn can't fix it (one bounce allowed? immediate escalation?).
- Whitelist/allowlist for runnable runbook paths (prevent arbitrary code execution).
- Migration: add new fields to existing entries via a `--phase2` flag on `incident_migrate.py`, or let them default-null on first read.

## Out of scope

- Cross-agent recurrence detection.
- A REST endpoint for surfacing incidents to a UI (the parser is callable from Python; an endpoint is a future task).
- Push notifications to Telegram when `severity: high|critical` is recorded (Lox already does this for some incidents; the unified schema just makes the trigger condition richer).
- Migration of historical entries beyond slug key + legacy fields (e.g. dropping entries older than 90 days is a separate cleanup task).
- Real-time cross-agent sync (the schema enables this; a future transport is a separate task).
- Schema versioning (the JSON Schema has a `$id` but no `version` field; if schema breaks compat in the future, bump the `$id` and add a v2 parser).

## Companion doc updates

- `docs/systems/agent-incidents.md` *(new)* — durable system spec.
- `agents/definitions/quinn/HEARTBEAT.md` *(modified)* — OPS STATE MANAGEMENT section.
- `agents/definitions/lox/HEARTBEAT.md` *(modified)* — incident recording guidance.
- `agents/lib/incident_state.py` and `agents/lib/incident_migrate.py` have inline docstrings; no separate README needed.
- `agents/schemas/agent-incident-state.schema.json` has the schema embedded; no separate README needed.

## Later todos (parking lot)

- Cross-agent recurrence detection (slug-keyed join).
- Pulse UI tab for incident roll-ups (the parser is the foundation; UI is a future task).
- A small `incident-rollup` skill wrapping `incident_state.py` for non-Quinn agents.
- Schema versioning (`$id: v2` after first breaking change).
- Drop entries older than 90 days as a periodic cleanup.
- Real-time cross-agent sync (transport-agnostic; the schema is the prerequisite).