---
name: operating-notes
description: "Append single-line SIndustries operating notes to brain/ops/notes/YYYY-MM-DD.md for later weekly synthesis into reviews."
---

# Operating Notes Skill

Append raw SIndustries operating observations as single-line notes. These notes are not content plans, approvals, or polished copy. The weekly cron later promotes and synthesizes relevant notes into `brain/reviews/`.

## Daily Notes Location

```
brain/ops/notes/YYYY-MM-DD.md
```

Use today's date in local workspace time. If the directory or file does not exist yet, create it.

## Note Format

Keep each note to one bullet line:

```markdown
- date: YYYY-MM-DD | source: heartbeat/task/pr/spec/chat | task/project: <name or id> | note: <what changed> | reasoning: <why it matters> | links: <refs or none>
```

Fields:

- `date`: note date, normally the file date.
- `source`: where the observation came from.
- `task/project`: the task, project, repo, or system involved.
- `note`: one concrete observation.
- `reasoning`: why this might matter operationally.
- `links`: task IDs, PRs, specs, URLs, or `none`.

## Example

```markdown
- date: 2026-05-28 | source: task | task/project: OpenClaw content workflow | note: Ivy now owns website PR authorship for content tasks. | reasoning: Keeps PR review comments routed to the author instead of Quinn. | links: brain/specs/app-tasks/content-task-workflow-lobster.md
```

## What To Capture

Capture only concise operational facts:

- project/task status changes
- release or deployment facts
- workflow decisions
- notable implementation tradeoffs
- evidence links that a later review can verify

Do not write final website copy here. Do not add workflow metadata beyond the six fields in the note format.

## Privacy Boundary

Do not capture:

- private family context
- employer context
- raw private logs
- unreleased sensitive ideas unless Tom explicitly says they are safe to track
- credentials, secrets, or tokens

## Weekly Promotion

The weekly cron owns synthesis:

- read `brain/ops/notes/YYYY-MM-DD.md` files for the week
- group and summarize relevant operating evidence
- promote useful material into `brain/reviews/`
- leave authoring and enrichment to the content workflow

The pipeline is: operating notes -> weekly review synthesis -> minimal content tasks -> Lobster deterministic context gathering -> Ivy enrichment/authoring -> Quinn/Tom approval -> PR -> merge.
