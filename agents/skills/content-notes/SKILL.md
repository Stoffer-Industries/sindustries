---
name: content-notes
description: "Append SIndustries-relevant daily ops notes for the weekly content review."
---

# Content Notes

Track SIndustries-relevant signals during heartbeat by appending structured daily notes. The weekly cron reads them and creates content tasks.

---

## When to use

Append a note whenever something happens that could become public SIndustries content:
- a system or experiment changes status
- something ships or gets killed
- Tom shares context about a project in chat
- a lesson or decision is worth capturing

---

## Storage

```
brain/ops/notes/YYYY-MM-DD.md
```

One file per day. Each heartbeat appends to today's file.

## File format

```markdown
# SIndustries Notes — YYYY-MM-DD

<!-- heartbeat appends here -->
```

---

## Append a daily note (heartbeat)

Only append when you have observed something genuinely worth capturing. Do not append noise.

**Row format:**

```
- [YYYY-MM-DD] **<system or experiment slug>** — <what happened or changed> | why: <why this is content-relevant> | ref: <memory file, brain file, or workspace path relevant to this note>
```

Each row must be self-contained. The weekly cron agent will have no session context, so the row needs to explain itself. The `ref:` field should point to the most useful context file — a memory entry, a brain spec, a content JSON, or a relevant workspace path.

**Example:**

```
- [2026-06-01] **openclaw** — shipped Telegram group routing fix | why: marks a milestone in the OpenClaw experiment worth updating on the website | ref: codebases/sindustries/apps/website/src/content/experiments.json
```

**Append snippet** (substitute values before running):

```python
import datetime, pathlib

WORKSPACE = pathlib.Path("/Users/quinnstoffer/.openclaw/workspace")
TEMPLATE = "# SIndustries Notes — {date}\n\n<!-- heartbeat appends here -->\n"

note_text = "<formatted row as above>"
today = datetime.date.today()
notes_path = WORKSPACE / "brain" / "ops" / "notes" / f"{today}.md"

notes_path.parent.mkdir(parents=True, exist_ok=True)
if not notes_path.exists():
    notes_path.write_text(TEMPLATE.format(date=today))

content = notes_path.read_text()
notes_path.write_text(content.replace(
    "<!-- heartbeat appends here -->",
    f"<!-- heartbeat appends here -->\n{note_text}"
))
print(f"Appended note to {notes_path}")
```

---

## Stale content check (heartbeat, once per day)

Run:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/content/sindustries-stale-content/check_stale_content.py
```

For each `STALE:` line in the output, append a daily note with the format:

```
- [YYYY-MM-DD] **<slug>** — listed as <status> but updatedAt is <date> (>30 days) | why: website content may need a status update | ref: codebases/sindustries/apps/website/src/content/<file>
```
