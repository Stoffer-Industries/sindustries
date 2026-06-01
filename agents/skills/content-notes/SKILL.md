# content-notes

Manage the weekly SIndustries content review file. Use this skill during heartbeat to append daily notes, and during the weekly cron to distil them.

## File location

```
brain/reviews/website-content/YYYY-MM-DD.md
```

One file per week, dated to the Friday of that week.

## File format

```markdown
# SIndustries Weekly Review — YYYY-MM-DD

## Needs approval from Tom

_Items here require Tom's personal sign-off before becoming content tasks.
These include first-person voice copy, strategic claims, revenue/customer references,
or anything that could be read as a public commitment._

<!-- append items here as bullet points -->

## Needs approval from Quinn

_Items Quinn can approve without escalating to Tom.
Stack additions, factual metadata updates, experiment status changes with task evidence._

<!-- append items here as bullet points -->

## Daily notes

_Raw notes appended by heartbeat. Not yet triaged._

<!-- heartbeat appends here with date stamps -->
```

## Appending a daily note (heartbeat)

Run this Python snippet, substituting `<note_text>` with the note to append:

```python
import datetime, pathlib

WORKSPACE = pathlib.Path("/Users/quinnstoffer/.openclaw/workspace")
TEMPLATE = """\
# SIndustries Weekly Review — {date}

## Needs approval from Tom

_Items here require Tom's personal sign-off before becoming content tasks.
These include first-person voice copy, strategic claims, revenue/customer references,
or anything that could be read as a public commitment._

<!-- append items here as bullet points -->

## Needs approval from Quinn

_Items Quinn can approve without escalating to Tom.
Stack additions, factual metadata updates, experiment status changes with task evidence._

<!-- append items here as bullet points -->

## Daily notes

_Raw notes appended by heartbeat. Not yet triaged._

<!-- heartbeat appends here with date stamps -->
"""

note_text = "<note_text>"
today = datetime.date.today()
days_since_friday = (today.weekday() - 4) % 7
review_date = today - datetime.timedelta(days=days_since_friday)
review_path = WORKSPACE / "brain" / "reviews" / "website-content" / f"{review_date}.md"

review_path.parent.mkdir(parents=True, exist_ok=True)
if not review_path.exists():
    review_path.write_text(TEMPLATE.format(date=review_date))

note_line = f"\n- [{today}] {note_text}"
content = review_path.read_text()
review_path.write_text(content.replace(
    "<!-- heartbeat appends here with date stamps -->",
    f"<!-- heartbeat appends here with date stamps -->{note_line}"
))
print(f"Appended note to {review_path}")
```

Only append a note if there is something genuinely worth capturing — a meaningful system event, content signal, or SIndustries-relevant observation. Do not append noise.

## Stale content check (heartbeat)

Run the stale content check script:

```
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/crons/sindustries-weekly-review/check_stale_content.py
```

If it prints any `STALE:` lines, append each as a daily note using the snippet above with the text: `Stale content: <slug> in <file> — last updated <date>`.

## Distilling the weekly review (weekly cron)

When the weekly cron fires, the `distil_daily_notes.py` script extracts raw daily notes. Quinn then triages each into the approval sections:

- **Needs approval from Tom**: first-person Tom voice, strategy/revenue claims, employer or family references, public commitments.
- **Needs approval from Quinn**: factual updates, stack/status changes, experiment status with supporting evidence.
- **Leave in Daily notes**: too vague to action without more context.

Do not invent content. Distil only from what is in the daily notes. Add a short "why" alongside each distilled item.

## Creating content tasks from approved items

After Tom or Quinn approves an item in the weekly review PR:

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py create \
  --title "<item title>" \
  --type content \
  --description "<item body + link to weekly review PR>" \
  --priority normal
```
