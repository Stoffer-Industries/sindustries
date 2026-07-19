# Feature Factory Weekly Retro

You are Quinn, running a weekly retrospective scan of the feature task factory.

Goal: find quality patterns in tasks completed in the last 7 days and surface actionable recommendations to Tom. Keep the report short — 3–5 findings max. Skip items with no signal.

---

## Step 1 — Fetch completed tasks from the last 7 days

```bash
python3 -c "
import urllib.request, json, datetime, sys
base = 'http://localhost:4001/api/v1'
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
url = f'{base}/tasks?status=done&limit=50'
with urllib.request.urlopen(url) as r:
    data = json.load(r)
tasks = [t for t in data.get('data', []) if t.get('completedAt','') >= cutoff]
print(json.dumps(tasks, indent=2))
"
```

If no tasks completed in the last 7 days, output: "No tasks completed this week — nothing to retro." and stop.

---

## Step 2 — For each task, collect signals

For each task, check the following. Record findings per task ID (first 8 chars).

### 2a — Gate failure count
Count `[feature-task-progress-checklist]` task comments. Each one is a gate block Rowan had to fix.
- 0–1: normal
- 2–3: mild friction
- 4+: significant friction — note it

### 2b — Evidence quality on merged PRs
Fetch the PR body for each URL in `[implementer-prs]` comments using:
```bash
GITHUB_TOKEN="$QUINN_GITHUB_TOKEN" gh api repos/Stoffer-Industries/sindustries/pulls/<PR_NUMBER> --jq '.body'
```

In the `## Acceptance Criteria` section, count:
- `testID:` annotations (good — e2e or unit test)
- `not tested:` annotations (needs scrutiny — is the reason substantive?)
- `not code:` annotations (fine for doc/spec ACs)

Flag if:
- `not tested:` is > 50% of ACs on a task tagged with `mission-control`, `content-scheduler`, or any UI component
- Any `not tested:` reason is thin (< 20 chars or generic like "manual" with no specifics)

### 2c — Backfill PR detection
Look for two signals of a backfill:
1. Multiple PRs for the same task opened within 48h of each other (separate feature + docs PRs)
2. A PR title containing "backfill", "follow-up", or "docs-only" referencing this task's ID

### 2d — Blocked duration
Check if `blocked: true` appears in consecutive lobster-state JSON comments. More than 2 distinct block episodes on one task is worth noting.

### 2e — System spec quality
In the latest PR body, read the `## System Spec` section. Flag if:
- It says "No change" or "no system spec" on a PR diff > 200 lines (fetch line count via `gh api repos/Stoffer-Industries/sindustries/pulls/<n> --jq '.additions + .deletions'`)
- Section is present but the reason is < 20 non-whitespace characters

---

## Step 3 — Write the retro report

Format as a short Telegram message (plain text, no tables, bullet points only):

```
🏭 Factory Retro — week of <YYYY-MM-DD>

Tasks completed: <N>

<For each finding, one bullet. Skip tasks with no signal.>

Recommendations:
• <1–3 specific, actionable suggestions>

No action needed if nothing flagged.
```

Rules:
- Maximum 5 findings total across all tasks
- Name the task by its title (first 40 chars), not its ID
- For evidence findings, quote the thin `not tested:` reason verbatim
- Recommendations should reference specific workflow rules or tooling changes, not vague "improve quality" suggestions
- If all tasks look clean, say so explicitly: "✅ Clean week — no quality signals."

---

## Step 4 — Deliver

Send the report to Tom's Telegram main session:

```python
import subprocess
msg = """<your report here>"""
subprocess.run([
    'python3', '-c',
    f'''
import urllib.request, json
req = urllib.request.Request(
    "http://localhost:4001/api/v1/sessions/agent:quinn:telegram:direct:6435140143/messages",
    data=json.dumps({{"text": {repr(msg)}}}).encode(),
    headers={{"Content-Type": "application/json"}},
    method="POST"
)
urllib.request.urlopen(req)
'''
])
```

Or use the OpenClaw sessions_send tool if available.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If this retro errors (Tasks API down, GitHub auth failure, etc.), escalate to Lox's main session rather than silently dropping the run.
