---
name: sindustries-stale-content
description: "Check SIndustries website content for stale status/update dates."
---

# SIndustries Stale Content

Run from this skill directory:

```bash
python3 check_stale_content.py
```

For each `STALE:` line in the output, append a daily content note using the
`content-notes` skill. The note should identify the slug, stale status/date, why
it may need a website update, and the source content file.
