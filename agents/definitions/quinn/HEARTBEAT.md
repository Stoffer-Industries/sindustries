# HEARTBEAT

<!-- Heartbeat reviews tasks and advances work when possible.

Workflow semantics are defined in `TASK_PROCESS.md`.
Heartbeat does not redefine workflow rules. -->

---
<!-- 
PURPOSE

Heartbeat acts as a workflow inspector.

For each task in the heartbeat set it:

1. reviews the current task state
2. determines whether the task can move state
3. if it can, applies the state change
4. if it cannot, decides whether the task owner should progress it
5. reports the outcome

If a task is assigned to Quinn and is actionable, Quinn may execute the next step directly instead of spawning a sub-agent.

--- -->

BOOKMARK STATE OBSERVABILITY

Heartbeat does not curate bookmarks, write specs, validate spec artifacts, or
advance bookmark review state. Production bookmark curation and spec generation
now run from the bookmark review cron.

Heartbeat only reports bookmark pipeline health:

1. Read the state analyzer skill:
   `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/bookmarks/state/SKILL.md`
2. Run the compact analyzer:
   `python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/bookmarks/state/scripts/run_bookmark_state_analyzer.py --json`
3. Report counts by `reviewStatus`, topic, and approval status.
4. Flag blocked or stale states across heartbeats:
   - approvals pending for Tom
   - specs requested but not created
   - specs created but no approval requested
   - tasks requested or task creation follow-up needed
   - repeated likely-follow-up buckets that have not changed since the last heartbeat
5. Track repeated stalls in `brain/state/quinn-ops-state.json` under OPS STATE MANAGEMENT.
6. Do not mutate bookmark state from heartbeat.

---

CONTENT TASK LOBSTER CHECK

Quinn dispatches content task workflow passes from heartbeat; Lobster owns all status transitions.
Run:
`TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/content-tasks/run.py --json`
Report only failures, blocked closed-unmerged PRs, or meaningful transitions.

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

Do not apply `.openclaw` changes speculatively. Only act on explicit `[openclaw-needed]` comments from Rowan.

PR REVIEW

Process any PRs that need your attention.

Read and follow the reviewer section of:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/pr-process/SKILL.md`

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

**If nothing passes the tweet test:** do not write a note. Silence is correct.

---

OPS STATE MANAGEMENT

Quinn maintains a persistent operational findings registry at `brain/state/quinn-ops-state.json`. This is the equivalent of Lox's `lox-incident-state.json` but for workflow/pipeline anomalies rather than infra issues.

**Schema for each entry:**
```json
{
  "firstSeen": "<ISO timestamp>",
  "lastCheckedAt": "<ISO timestamp>",
  "status": "watching | escalated | resolved | false_positive",
  "severity": "low | medium | high | critical",
  "needsTom": false,
  "attempts": 1,
  "lastAction": "what was tried / what happened",
  "resolvedAt": null,
  "escalatedAt": null
}
```

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

**Escape early — direct Tom ping:**
After completing all sections, check both `quinn-ops-state.json` and `brain/state/lox-incident-state.json`:
- For any entry where `needsTom: true` AND `escalatedAt` is null (not yet escalated):
  - Send a direct Telegram message to Tom (session key: `telegram:6435140143` or via main session) with a concise summary of what needs him
  - Set `escalatedAt: <now>` on the entry so it only fires once per incident
  - Do not re-escalate already-escalated items unless they've been updated

**State file read/write pattern:**
```python
import json, os
from datetime import datetime, timezone

STATE_FILE = '/Users/quinnstoffer/.openclaw/workspace/brain/state/quinn-ops-state.json'

def read_ops_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"ops": {}}

def write_ops_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def upsert_op(state, slug, severity, last_action, resolved=False):
    now = datetime.now(timezone.utc).isoformat()
    ops = state.setdefault("ops", {})
    if slug not in ops:
        ops[slug] = {"firstSeen": now, "attempts": 0, "needsTom": False, "escalatedAt": None, "resolvedAt": None}
    entry = ops[slug]
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

<!-- ---

HEARTBEAT PROCEDURE

Use the Tasks skill (`skills/ops/tasks-api/SKILL.md`) as the single entrypoint for all task operations during heartbeat:

1. **Get heartbeat tasks** via the Tasks API client heartbeat view:
   - See the Tasks skill for the exact `list --heartbeat` command (`tasks_api_client.py`).

2. **For each task** in that heartbeat set:
   - Call the task transition check script with GITHUB_TOKEN set (required for PR validation):
     ```
     GITHUB_TOKEN=$GITHUB_TOKEN TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/task_transition_check.py <task-id>
     ```
   - If it **can move** (no failed criteria), use the Tasks API client to apply the state change.
   - If it **cannot move** (has failed criteria):
     - Check if the failed criteria are things the assignee can fix (PR needed, tests failing, ACs missing) → spawn the owner
     - If the failed criteria show "waiting on Tom" (review requested) → do NOT spawn, report as blocked on Tom
     - Use the `failed_criteria` list from the transition check to tell the spawned agent exactly what to fix

A task is actionable when:
- It is NOT waiting on Tom (i.e., Tom hasn't been asked to review)
- It has remaining implementation work (PR not created, tests not passing, ACs not met)
- The transition check shows failed criteria that the assignee can fix

**Important:** A task with `blocked=true` is only truly blocked if it's waiting on Tom or an external human. If it's blocked on "PR not found" or "tests failing" - that's work the assignee (Rowan/Quinn) can do. Treat those as actionable and spawn the owner.

---

AGENT SPAWN CONTRACT

When spawning an agent include:
- task ID
- worktree information
- environment to use
- instruction to append progress comments using the tasks tools
- instruction to open a PR when implementation work is complete
- **Agents must NOT change task status, blocked, or completedAt fields**
- **Only Quinn manages task state during heartbeat**

---

REPORT FORMAT

Example heartbeat report:

Doing tasks

Rowan: Telegram buttons helper - in progress
Lox: Post-merge cleanup - in acceptance

Spawned:
🔧 Rowan

Started Doing:
None

Summary

🔧 Rowan progressing Telegram buttons helper
🔶 Lox in acceptance
🚫 Task blocked waiting on Tom

Emoji legend:

🔧 agent spawned
🚫 blocked
🔶 in acceptance
✅ done

---

GUARDRAILS

• Use the prodlike API for inspection:
  http://localhost:4001/api/v1

• Do not create duplicate tasks.

• Do not redefine workflow rules.

• Follow `TASK_PROCESS.md` for workflow semantics.

• Treat the transition check output as the source of truth for whether a task may move state.

• Do not mark tasks done unless completion conditions are clearly satisfied. -->
