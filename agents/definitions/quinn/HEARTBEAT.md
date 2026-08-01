# HEARTBEAT

**SILENCE RULE: Default to HEARTBEAT_OK. Only produce output when there is a new, actionable item that Tom or Quinn needs to act on RIGHT NOW. Do not narrate zero-counts, unchanged state, chronic items already escalated, sections with nothing to do, or items already tracked in ops state with `escalatedAt` set. Each section below should contribute nothing to output unless it has a genuine new finding. When in doubt, stay silent.**

---

ASSIGNED ACTIVE TASK DISCOVERY — RUN FIRST

Before any specialised section or silent-success decision, run both mandatory preflight queries:

1. Classify every active task assigned to Quinn:
   `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Quinn --json`
2. Discover the global tech-design approval queue across all feature/code tasks, regardless of assignee:
   `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py --json`

The shared queue also returns read-only `reviewRequests`, `authoredPrFeedback`, and `mergeCandidates`; the **PR REVIEW** section owns every action through `pr-process`. It never auto-submits Quinn's reviews or merges. Quinn must never approve her own PR, and a self-authored PR is never a merge candidate based on Quinn's own review.

The assignee classifier covers Quinn's assigned `ready`, `doing`, and `acceptance` tasks and distinguishes actionable work from explicit blockers, dependency blockers, and external waits. **It is not the tech-design approval queue:** Quinn's delegated approval responsibility is global, so only `pending_tech_design_approvals.py` supplies that preflight result. The classifier also does not replace the separate **QUINN OPS TASKS** query for open tasks with no `taskType`; that query must still run in its section because open untyped ops tasks are outside the classifier's active-state query.

**Actionability gate:** if either preflight query identifies actionable work, or later discovery finds an actionable handoff, ops task, or PR review, take a concrete action in this pass. Concrete action means implementation or document progress, an approval/review, an applied handoff, a required task comment, or a newly evidenced blocker/escalation. Repeating existing state is not action. Do not return `HEARTBEAT_OK` or otherwise finish silently before both preflight queries and the open no-taskType ops query run, and do not return silent success while an actionable item remains untouched.

The top-level silence rule still applies after all required discovery and action: report only the action taken or genuinely new input needed.

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

Process the shared queue's `reviewRequests` and any `authoredPrFeedback`. Treat `mergeCandidates` as assignee-only: Quinn may merge only a PR she authored after a non-Quinn blocking reviewer approved and CI is green; she never self-approves. Rowan and Ivy own merging their own eligible PRs.

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

**Legacy compatibility:** The parser still accepts Quinn's pre-migration `ops` key. The live state has already been migrated separately, so the legacy normalizer is now only a safety net for older shapes.

**What to write entries for** (after each heartbeat section above):
- Guardrail skips on the same item for 2+ consecutive heartbeats
- State drift that couldn't be auto-fixed
- Pipeline stalls — tasks/items stuck with no forward movement
- Validate steps that silently no-op when they should have processed something
- Any finding that couldn't be resolved in this heartbeat pass

**What NOT to write entries for:**
- Routine "no items" / "0 candidates" outcomes
- Things successfully resolved in this heartbeat pass (mark existing entries resolved instead)

**Incident identity invariant:** one active entry represents one logical task/gate failure. Incident slugs are stable and date-free (for example `feature-task-<task-id-prefix>-ready_checks` or `backlog-untyped-<task-id-prefix>`). Never create `slug-YYYY-MM-DD` copies. When the same finding is observed again, update the existing entry in place and increment `attempts`; use `recurrenceCount` only when a resolved incident reappears.

**Update rules:**
1. Read `brain/state/quinn-ops-state.json` at the start of heartbeat
2. After each section: write or update entries for any unresolved findings
3. If an issue was resolved this pass: set `status: resolved`, `resolvedAt: <now>`, record what fixed it in `lastAction`
4. If an entry has `attempts >= 3` and is still unresolved: set `needsTom: true`, `severity` to at least `high`
5. Always increment `attempts` and update `lastCheckedAt` when re-checking an existing entry

**Escalation and incident queue reporting — validate before escalating, then surface the top unblock:**
After completing all sections, check both `quinn-ops-state.json` and `brain/state/lox-incident-state.json`:

**Before escalating any `needsTom` entry, re-validate it is still a real problem:**
- For feature task stalls: re-check the lobster output. If the task is no longer in the reported state, mark resolved.
- For any other stall: if the original condition is no longer detectable in live state, mark `false_positive` rather than escalating.
- Only escalate if the condition is confirmed present in live state this pass.

1. From `read_all_incidents()`, discard entries where `status` is `resolved` or `false_positive`. Call the remainder **active findings**. Count entries where `needsTom` is true OR `severity` is `high`/`critical` as **actionable incidents**; count the rest as **monitored findings**. Do not describe the monitored count as incidents waiting on Tom.
2. For any entry where `needsTom: true` AND `escalatedAt` is null: set `escalatedAt: <now>`.
3. **Always report the queue when active findings exist:**
   - Output: `Incident queue: <actionable count> actionable, <monitored count> monitored.`
   - If actionable count is 0, output no escalation line and do not reply `HEARTBEAT_OK`; the queue summary is the useful heartbeat output.
   - If actionable count > 0, also output: `<actionable count> incident(s) waiting on you.`
   - Sort actionable candidates by severity (critical → high → medium → low), then by `firstSeen` (oldest first). Pick the top candidate and output: `🔴 Top unblock: <what it is and exactly what Tom needs to do>` (or 🟠/🟡 for high/medium).
4. Repeat the compact queue summary while active findings exist, even if the counts are unchanged. Tom should be able to judge whether incident actioning needs prioritisation from the heartbeat alone.
5. If there are no active findings at all, output nothing and reply `HEARTBEAT_OK` instead.

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

Before writing, treat legacy keys ending in `-YYYY-MM-DD` as aliases for the
date-free slug and merge them into that single entry. Existing live state has
been migrated separately; do not recreate date-suffixed keys.

**Migration note:** The live state migration was run separately from this PR
with backups and schema validation. State files remain outside the repository;
the parser's legacy normalizer remains as a safety net for any older shape.
