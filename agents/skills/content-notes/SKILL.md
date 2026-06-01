# content-notes

Track SIndustries-relevant signals during heartbeat by appending structured daily notes to this week's review file. The weekly cron reads and distils them.

This skill has two modes: **append** (heartbeat) and **distil** (weekly cron). They are separate steps.

---

## Storage

```
brain/reviews/website-content/YYYY-MM-DD.md
```

One file per week, dated to the Friday of that week.

## File format

```markdown
# SIndustries Weekly Notes — YYYY-MM-DD

## Daily notes

_Raw notes appended by heartbeat. Not yet triaged._

<!-- heartbeat appends here -->
```

---

## Mode 1: Append a daily note (heartbeat)

Only append when you have observed something genuinely worth capturing — a meaningful system event, experiment update, content signal, or SIndustries-relevant observation from this session. Do not append noise.

**Row format:**

```
- [YYYY-MM-DD] **<system or experiment slug>** — <what happened or changed> | why: <why this is content-relevant> | ref: <workspace path or URL>
```

Each row must be self-contained. The weekly cron agent will have no session context, so the row needs to explain itself.

**Example:**

```
- [2026-06-01] **openclaw** — shipped Telegram group routing fix | why: marks a milestone in the OpenClaw experiment worth updating on the website | ref: codebases/sindustries/apps/website/src/content/experiments.json
```

**Append snippet** (substitute values before running):

```python
import datetime, pathlib

WORKSPACE = pathlib.Path("/Users/quinnstoffer/.openclaw/workspace")
TEMPLATE = """\
# SIndustries Weekly Notes — {date}

## Daily notes

_Raw notes appended by heartbeat. Not yet triaged._

<!-- heartbeat appends here -->
"""

note_text = "<formatted row as above>"
today = datetime.date.today()
days_since_friday = (today.weekday() - 4) % 7
review_date = today - datetime.timedelta(days=days_since_friday)
review_path = WORKSPACE / "brain" / "reviews" / "website-content" / f"{review_date}.md"

review_path.parent.mkdir(parents=True, exist_ok=True)
if not review_path.exists():
    review_path.write_text(TEMPLATE.format(date=review_date))

content = review_path.read_text()
review_path.write_text(content.replace(
    "<!-- heartbeat appends here -->",
    f"<!-- heartbeat appends here -->\n{note_text}"
))
print(f"Appended note to {review_path}")
```

---

## Mode 2: Stale content check (heartbeat, once per day)

Run:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-review/check_stale_content.py
```

For each `STALE:` line in the output, append a daily note with the format:

```
- [YYYY-MM-DD] **<slug>** — listed as <status> but updatedAt is <date> (>30 days) | why: website content may need a status update | ref: codebases/sindustries/apps/website/src/content/<file>
```

---

## Mode 3: Distil for weekly wrap (weekly cron only)

The weekly cron (`sindustries-weekly-review`) calls `distil_daily_notes.py`, which extracts the raw notes from the file and passes them to the agent for triage.

Triage rules:
- **Needs approval from Tom**: first-person Tom voice, strategy/revenue claims, employer or family references, public commitments.
- **Needs approval from Quinn**: factual updates, stack/status changes, experiment status with supporting evidence.
- **Leave as-is**: too vague to action without more context — flag it but don't move it.

Do not invent content. Each distilled item keeps the original `ref:` link so the reviewer can verify.
