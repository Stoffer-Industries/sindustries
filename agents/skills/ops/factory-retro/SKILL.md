---
name: factory-retro
description: "Weekly retro scan of completed feature tasks. Checks comments and PRs for quality signals and surfaces recommendations."
---

# Feature Factory Retro

Scan feature tasks completed in the last 7 days. For each, check task comments and PR bodies for quality signals. Produce a short report with findings and recommendations.

Run this manually when asked, or via a scheduled cron.

---

## Step 1 — Fetch completed tasks

```bash
python3 << 'EOF'
import urllib.request, json, datetime

base = 'http://localhost:4001/api/v1'
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
with urllib.request.urlopen(f'{base}/tasks?status=done&limit=50') as r:
    tasks = [t for t in json.load(r).get('data', []) if t.get('completedAt', '') >= cutoff]

print(f"Tasks completed in last 7 days: {len(tasks)}")
for t in tasks:
    print(f"  {t['id'][:8]} — {t['title'][:60]}")
EOF
```

If 0 tasks: output "✅ No tasks completed this week." and stop.

---

## Step 2 — Per-task signals

For each task, run these checks and record findings.

### Gate failure count
Count comments where `author == "Lobster"` and text starts with `[feature-task-progress-checklist]`.

```python
gate_failures = sum(
    1 for c in task.get('comments', [])
    if c.get('author') == 'Lobster'
    and (c.get('text') or '').startswith('[feature-task-progress-checklist]')
)
```

- 0–1: normal — skip
- 2–3: mild friction — note it
- 4+: significant — flag it

### Evidence quality
For each PR URL in `[implementer-prs]` comments, fetch the PR body:

```bash
GITHUB_TOKEN="$QUINN_GITHUB_TOKEN" gh api repos/Stoffer-Industries/sindustries/pulls/<N> --jq '.body'
```

Parse the `## Acceptance Criteria` section. Count:
- Lines with `testID:` → good
- Lines with `not tested:` → scrutinise
- Lines with `not code:` → fine

Flag if `not tested:` > 50% of checked ACs **and** the task has frontend tags (`mission-control`, `content-scheduler`, `ui`, `pulse`).

Also flag any `not tested:` reason shorter than 20 characters — likely a thin justification.

### Backfill PR detection
Check if a second PR was opened for the same task within 48 hours of the first. Look for:
- Multiple URLs in `[implementer-prs]` comments with close timestamps
- PR titles containing "backfill", "docs", "follow-up" on a task that already has a feature PR

### System spec quality
In the latest PR body, read `## System Spec`. Flag if:
- Section says "No change" or is < 20 non-whitespace chars
- **And** the PR diff is large: `gh api repos/Stoffer-Industries/sindustries/pulls/<N> --jq '.additions + .deletions'` > 200 lines

---

## Step 3 — Write the report

Format as plain text for Telegram. Maximum 5 findings. Skip tasks with no signal.

```
🏭 Feature Factory Retro — week of <YYYY-MM-DD>

Tasks completed: <N>

Findings:
• [Task title] — <finding in one line>
• [Task title] — <finding in one line>
...

Recommendations:
• <specific, actionable — reference the workflow rule or gap>
• <one more if warranted>

✅ Nothing else flagged.
```

If everything looks clean: "🏭 Factory Retro — week of <date>\n✅ Clean week. <N> tasks completed, no quality signals."

---

## Step 4 — Deliver

If run from a session: output the report and let Quinn decide whether to message Tom.

If run from a cron: send directly to Tom via `sessions_send` to `agent:quinn:telegram:direct:6435140143`.
