# HEARTBEAT

**SILENCE RULE: Default to HEARTBEAT_OK. Only produce output when there is a new, actionable item that Tom or Quinn needs to act on RIGHT NOW. Do not narrate zero-counts, unchanged state, chronic items already escalated, sections with nothing to do, or items already tracked in ops state with `escalatedAt` set. Each section below should contribute nothing to output unless it has a genuine new finding. When in doubt, stay silent.**

---

TECH DESIGN APPROVAL

Quinn approves tech designs on behalf of Tom during heartbeat. Tom has delegated this.

Each heartbeat:
1. Find feature tasks with a `[tech-design]` comment but no proper `[tech-design-approved] true` comment:
   `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py --json`
   The script mirrors the lobster's parser (`tagged_values` + `tech_design_approved` in `agents/workflows/feature-task/src/main.rs`): a comment counts as approval only if its trimmed text STARTS WITH the tag and the first whitespace-separated token after the tag is `true` (case-insensitive). Substring matches in the lobster's progress-checklist complaints (e.g. `Missing task comment [tech-design-approved] true`) are intentionally NOT counted.
2. **If 0 pending: skip this section entirely. No output.**
3. For each pending task:
   - Read the design at the linked path.
   - Check: all required sections present, aligned with spec, no unbounded scope, `.openclaw` boundary notes where relevant.
   - If it looks good: post task comment `[tech-design-approved] true`
   - If something looks wrong or risky: flag to Tom via Telegram instead of approving.
4. Do not approve a design that was written in the same heartbeat pass (let Rowan write it, Quinn approves next pass).

---

QUINN OPS TASKS

Quinn-assigned tasks with no taskType (not feature/content) have no lobster. Heartbeat is the engine.

Each heartbeat:
1. Fetch open Quinn-assigned tasks:
   `curl -s "http://localhost:4001/api/v1/tasks?assignee=Quinn&status=open" | python3 -c "import json,sys; tasks=[t for t in json.load(sys.stdin)['data'] if not t.get('taskType')]; print(json.dumps(tasks, indent=2))"`
2. **If none: skip this section entirely. No output.**
3. Sort by `createdAt` ascending (oldest first). Take the top task.
4. Read the description fully. Determine if it can be completed this heartbeat pass:
   - **Yes (self-contained ops work):** Do it. Mark the task `doing`, complete the work, mark it `done`. Report to Tom what was done.
   - **Needs Tom input/approval:** Post a task comment explaining what's needed, ping Tom via Telegram. Log in ops state.
   - **Multi-step (takes >1 heartbeat):** Mark it `doing`, do the first meaningful chunk, post a progress comment, leave in `doing` for next pass.
5. Never start a second task in the same heartbeat pass. One task at a time.
6. If a task has been `doing` for >3 heartbeats with no progress comment from Quinn, escalate to Tom.

**Silence rule:** Only output if you actioned a task or need Tom's input. Do not narrate that you checked and found nothing.

---

OPENCLAW HANDOFFS (FEATURE FACTORY)

Quinn is the only agent that can write to `~/.openclaw/`. When a feature task has an unresolved `[openclaw-needed]` comment from Rowan, Quinn applies the change.

Each heartbeat:
1. List active feature tasks (status: doing or acceptance):
   `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --status doing --status acceptance`
2. For each task, scan comments for `[openclaw-needed]` entries that do not yet have a matching `[openclaw-done]`.
3. For each unresolved `[openclaw-needed]`:
   - Read the comment: it must include exact file paths, proposed diff summary, validation command, and rollback note.
   - If the change affects product behaviour, ask Tom before applying.
   - Apply the change to `~/.openclaw/`.
   - Validate using the command in the comment.
   - Post a task comment: `[openclaw-done] <changed paths> | validated: <command output summary> | <any follow-up notes>`
4. If `[openclaw-needed]` comments exist but are unclear or unsafe, mark the task blocked and post a comment explaining what is missing.
5. **If no unresolved handoffs: skip this section entirely. No output.**

Do not apply `.openclaw` changes speculatively. Only act on explicit `[openclaw-needed]` comments from Rowan.

PR REVIEW

Process any PRs that need your attention.

Read and follow the reviewer section of:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/pr-process/SKILL.md`

**Only output if you took a review action (submitted a review, requested changes, approved). Do not report PRs already reviewed or awaiting Tom.**

---

SINDUSTRIES CONTENT NOTES

Run this check every heartbeat. Write at most 1 ops note per run.

**Signal checklist — scan for any of these since the last ops note:**
- A PR merged to main in the sindustries repo (`git log origin/main --since="48 hours ago" --oneline`)
- A task moved to done or accepted in the Tasks API
- A bookmark pipeline milestone (spec created, approval resolved, task created)
- Something Tom mentioned in conversation that signals a shift, ship, or lesson

**The tweet test:** before writing, ask "could Tom post about this on X this week?" If no, skip it. Implementation steps, script renames, and config fixes almost never pass. Shipped capabilities, resolved hard problems, and pattern discoveries usually do.

**If a note is warranted:**
- One note per story — if multiple things are part of the same arc, write one note about the outcome
- Use the content-notes skill: `codebases/sindustries/agents/skills/content-notes/SKILL.md`
- The `why:` field must be specific ("first time the pipeline ran end-to-end without manual intervention") not vague ("shows how we're hardening the system")

**If nothing passes the tweet test:** do not write a note. Silence is correct. Do not report that you checked.

---

OPS STATE MANAGEMENT

Quinn maintains a persistent operational findings registry at `brain/state/quinn-ops-state.json`. This is the equivalent of Lox's `lox-incident-state.json` but for workflow/pipeline anomalies rather than infra issues.

**Schema (task 75ec1c8c — unified with Lox):** The state file uses the **unified agent incident schema** described in `docs/systems/agent-incidents.md`. Top-level key is `incidents` (renamed from the legacy `ops` key). The schema marks only `owner` and `status` as required; the rest default to safe values on read.

**Minimal entry shape Quinn should write:**
```json
{
  "owner": "quinn",
  "firstSeen": "<ISO timestamp>",
  "lastCheckedAt": "<ISO timestamp>",
  "status": "watching | escalated | resolved | false_positive",
  "severity": "low | medium | high | critical",
  "needsTom": false,
  "attempts": 1,
  "lastAction": "what was tried / what happened",
  "resolvedAt": null,
  "escalatedAt": null,
  "nextRetryAt": null,
  "recurrenceCount": 0,
  "details": {}
}
```

**Reading from both agents (preferred path):** Use the shared parser at `agents/lib/incident_state.py`. Import it from the agents package and call `load_all_incidents()` / `needs_tom()` instead of hand-rolling the schema. The parser handles Lox's file too and normalizes legacy shapes on the fly, so Quinn's heartbeat does not need to branch on file format.

```python
import sys
sys.path.insert(0, "/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries")
from agents.lib.incident_state import load_all_incidents, needs_tom

all_incidents = load_all_incidents()
for inc in needs_tom(all_incidents):
    # include in heartbeat output, set escalatedAt, etc.
    ...
```

**Legacy compatibility:** The parser still accepts Quinn's pre-migration `ops` key. Once the migration script (`agents/lib/incident_migrate.py`) has been run against live state (Quinn does this once after PR merge via `[openclaw-needed]`), all entries are in the unified shape and the legacy normalizer is just a safety net.

**What to write entries for** (after each heartbeat section above):
- Guardrail skips on the same item for 2+ consecutive heartbeats
- State drift that couldn't be auto-fixed
- Pipeline stalls — tasks/items stuck with no forward movement
- Validate steps that silently no-op when they should have processed something
- Any finding that couldn't be resolved in this heartbeat pass

**What NOT to write entries for:**
- Routine "no items" / "0 candidates" outcomes
- Things successfully resolved in this heartbeat pass (mark existing entries resolved instead)

**Update rules:**
1. Read `brain/state/quinn-ops-state.json` at the start of heartbeat
2. After each section: write or update entries for any unresolved findings
3. If an issue was resolved this pass: set `status: resolved`, `resolvedAt: <now>`, record what fixed it in `lastAction`
4. If an entry has `attempts >= 3` and is still unresolved: set `needsTom: true`, `severity` to at least `high`
5. Always increment `attempts` and update `lastCheckedAt` when re-checking an existing entry

**Escalation — validate before escalating, then surface the top unblock:**
After completing all sections, check both `quinn-ops-state.json` and `brain/state/lox-incident-state.json`:

**Before escalating any `needsTom` entry, re-validate it is still a real problem:**
- For feature task stalls: re-check the lobster output. If the task is no longer in the reported state, mark resolved.
- For any other stall: if the original condition is no longer detectable in live state, mark `false_positive` rather than escalating.
- Only escalate if the condition is confirmed present in live state this pass.

1. Collect all entries where `needsTom: true` AND `status` is not `resolved` or `false_positive`. Call this N.
2. For any entry where `needsTom: true` AND `escalatedAt` is null: set `escalatedAt: <now>`.
3. **Always end the heartbeat with a count + the top unblock:**
   - If N = 0: output nothing and reply HEARTBEAT_OK instead.
   - If N > 0: output two lines:
     - `N incident(s) waiting on you.`
     - Sort candidates by severity (critical → high → medium → low), then by `firstSeen` (oldest first). Pick the top candidate and output: `🔴 Top unblock: <what it is and exactly what Tom needs to do>` (or 🟠/🟡 for high/medium).
4. Both lines appear every heartbeat while items are open — even if previously escalated. Tom seeing it repeatedly is the point.

**State file read/write pattern (unified schema, task 75ec1c8c):**
```python
import json, os, sys
from datetime import datetime, timezone

STATE_FILE = '/Users/quinnstoffer/.openclaw/workspace/brain/state/quinn-ops-state.json'

# Prefer the shared parser; fall back to a hand-rolled read if the package
# isn't importable (e.g. when running outside the repo worktree).
try:
    sys.path.insert(0, "/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries")
    from agents.lib.incident_state import load_all_incidents, needs_tom as _shared_needs_tom
    def read_all_incidents():
        return load_all_incidents()
    def read_needs_tom():
        return _shared_needs_tom(load_all_incidents())
except Exception:
    def read_all_incidents():
        return []  # parser unavailable; callers should log and continue
    def read_needs_tom():
        return []

def read_ops_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"incidents": {}}  # unified key (was "ops" pre-75ec1c8c)

def write_ops_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def upsert_op(state, slug, severity, last_action, resolved=False):
    now = datetime.now(timezone.utc).isoformat()
    incidents = state.setdefault("incidents", {})  # unified key (was "ops")
    if slug not in incidents:
        incidents[slug] = {
            "owner": "quinn",  # unified schema: owner is required
            "firstSeen": now,
            "attempts": 0,
            "needsTom": False,
            "escalatedAt": None,
            "resolvedAt": None,
            "nextRetryAt": None,
            "recurrenceCount": 0,
            "details": {},
        }
    entry = incidents[slug]
    entry["lastCheckedAt"] = now
    entry["lastAction"] = last_action
    entry["severity"] = severity
    if resolved:
        entry["status"] = "resolved"
        entry["resolvedAt"] = now
    else:
        entry["attempts"] = entry.get("attempts", 0) + 1
        entry["status"] = "escalated" if entry.get("needsTom") else "watching"
        if entry["attempts"] >= 3:
            entry["needsTom"] = True
            entry["severity"] = severity if severity in ("high", "critical") else "high"
    return state
```

**Migration note:** After task 75ec1c8c's PR merges, Quinn runs `python3 agents/lib/incident_migrate.py --in-place` once against live state to convert the legacy `ops` key to `incidents` and add the unified fields. Until that runs, the legacy `ops` key is still readable through the parser's safety-net normalizer, so heartbeats do not block.
