---
name: retro-notes
description: "Append a note when you repeatedly see the same good or bad pattern, for periodic retro review. Not for single-instance issues — use incident/ops-state for those."
---

# Retro Notes

Any agent (Quinn, Rowan, Ivy, Lox) can append a note here when they notice the **same
kind of thing happening more than once** — a recurring source of friction, or a
recurring thing that's working well. Notes accumulate for periodic (weekly) retro
review; nothing reads them urgently and nothing pages anyone.

---

## When to use — and when not to

**Use retro-notes when:**
- You've now seen the same failure shape, workaround, or friction point at least twice
  (e.g. "this is the third time a PR patch call silently mutated a field nobody asked
  it to touch")
- You've noticed a working pattern worth reinforcing or copying elsewhere (e.g. "the
  bearer-token auth pattern the lobster uses has never had an auth regression, unlike
  the cookie-based frontends")
- The point is retrospective signal, not something that needs fixing right now

**Do not use retro-notes for:**
- A single-instance problem that needs action now — that's Quinn's `quinn-ops-state.json`
  or Lox's `lox-incident-state.json` (see `docs/systems/agent-incidents.md`). Retro-notes
  has no `needsTom`, no severity, no escalation — it is pure pattern-tracking.
- The first time you see something. Wait for the second occurrence before logging a
  pattern, or note it as a single observation only if you're confident it'll recur.

---

## Storage

```
brain/ops/retro-notes/YYYY-MM-DD.md
```

One file per day, same layout as `agents/skills/content-notes/SKILL.md`. A weekly retro
reads the last 7 days of files.

## File format

```markdown
# Retro Notes — YYYY-MM-DD

<!-- agents append here -->
```

---

## Append a note

Only append when you're confident this is a recurring pattern, not noise.

**Row format:**

```
- [YYYY-MM-DD] **<agent>** — <good|bad> — **<pattern-slug>** — <what you observed, one line> | evidence: <task ids / PR numbers / file paths>
```

Each row must be self-contained — the weekly reader has no session context. `pattern-slug`
should be a short, stable kebab-case label so the same pattern can be grouped across
multiple observations (e.g. `patch-field-drift`, `bearer-token-auth-resilience`).

**Examples:**

```
- [2026-08-18] **quinn** — bad — **patch-field-drift** — Task priority silently flipped high→urgent after a title/description-only PATCH; second time a partial patch call has mutated an untouched field (first was a cron `update` stripping tools). | evidence: task f6a4d56a, cron d0779b38
- [2026-08-18] **quinn** — good — **bearer-token-auth-resilience** — The feature-task lobster's Bearer-token auth (agents/workflows/feature-task/src/main.rs) was completely unaffected by the db967e2 cookie-auth regression that broke two browser frontends; worth defaulting system-to-system Tasks API calls to bearer tokens over cookies going forward. | evidence: PR #467, agents/workflows/feature-task/src/main.rs
```

**Append snippet** (substitute values before running):

```python
import datetime, pathlib

WORKSPACE = pathlib.Path("/Users/quinnstoffer/.openclaw/workspace")
TEMPLATE = "# Retro Notes — {date}\n\n<!-- agents append here -->\n"

note_text = "<formatted row as above>"
today = datetime.date.today()
notes_path = WORKSPACE / "brain" / "ops" / "retro-notes" / f"{today}.md"

notes_path.parent.mkdir(parents=True, exist_ok=True)
if not notes_path.exists():
    notes_path.write_text(TEMPLATE.format(date=today))

content = notes_path.read_text()
notes_path.write_text(content.replace(
    "<!-- agents append here -->",
    f"<!-- agents append here -->\n{note_text}"
))
print(f"Appended note to {notes_path}")
```

---

## Consumption

Nothing reads this automatically yet. `agents/skills/ops/factory-retro/SKILL.md` is the
natural weekly consumer alongside its gate-failure analytics — wiring that in is a
separate follow-up, not part of this skill.
