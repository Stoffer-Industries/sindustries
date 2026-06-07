---
name: spec-author
description: "Write implementation specs for bookmark-reviewed items. Reads workspace context files directly to produce code-factory-aligned product specs under brain/specs/<topic>/."
---

# Spec Author

Write an implementation spec from a reviewed item. This skill runs with full tool access — read the relevant context files, then write a grounded spec rather than reasoning blind from a payload.

## Inputs

The caller must supply:

| Input | Description |
|---|---|
| `bookmark_path` | Absolute path to the bookmark markdown file |
| `review_path` | Absolute path to the review markdown file |
| `topic` | Topic slug (e.g. `infra`, `app-assistant`, `app-tasks`, `crypto`, `design`) |
| `bookmark_key` | Short unique key used to name the output file |

These are passed in; do not guess paths from state files.

## Step 1 — Read Context

Before writing anything, read these files:

**Always:**
- `/Users/quinnstoffer/.openclaw/workspace/docs/state-of-the-nation.md` — current frictions, active projects, what's already being worked on
- `bookmark_path` — the source material the spec is derived from
- `review_path` — the review analysis and decision

**Sindustries system specs (already-implemented systems):**
- Read the listing at `codebases/sindustries/docs/specs/` — these describe what actually exists and is live. Skim titles and read any that look relevant to the topic. These are the ground truth for what to build on or supersede.

**Sindustries implementation specs (other specs in the repo):**
- `codebases/sindustries/docs/specs/content-factory.md` — always read if topic is `app-assistant` or `app-tasks`
- Any other spec that looks relevant from the listing

The goal: walk in knowing what the source material says, what the review decided, what systems already exist, and what frictions are live. A spec that duplicates an existing system or proposes something at odds with current state is a quality failure.

## Step 2 — Assess Before Writing

Before drafting:

1. **Is the bookmark's framing preserved?** The spec's center of gravity is the bookmark and review — not our frictions. If the bookmark covers multiple ideas, all of them must appear. Frictions and system state are relevance signals, not targets to reshape the bookmark onto.

2. **Is the review decision right?** If the bookmark is only partially relevant (one useful idea out of four), say so in `## Why` and flag whether the review should be reclassified to `monitor` instead of producing a spec that drops most of the source material.

3. **Does this overlap with something already implemented?** Read the sindustries system specs first. If an existing system already covers the ground, either propose a narrower complementary slice and name what it builds on, or explain why a replacement is warranted.

4. **How many specs?** Default to one. Split only when the work naturally separates into tracks with independent delivery value — different codebases, different rollout timelines, or clearly separable outcomes. Do not split by acceptance criterion alone.

## Step 3 — Write the Spec

### File location

```
/Users/quinnstoffer/.openclaw/workspace/brain/specs/<topic>/<slug>-<bookmark_key>.md
```

Use kebab-case for the slug, derived from the spec title.

### Format

The spec follows the code-factory product spec template so it can be used directly as a product spec when Tom approves it. Notes is intentionally lean — implementation detail belongs in Rowan's tech design, not here.

```markdown
# Spec — <Title>

## Source
- **Bookmark:** [<bookmark filename>](<bookmark_path>)
- **Review:** [<review filename>](<review_path>)
- **Topic:** `<topic>`
- **Spec Type:** `<infra workflow | assistant feature | app feature | data pipeline | tooling>`
- **Systems:** [<system name>](<path to relevant system spec or state file>) — omit if none
- **Previous revision:** _none_ (or link if this is a revision)
- **Created:** <YYYY-MM-DD>

**Status:** Draft
- [ ] **Approved by Tom**

---

## Outcome

One paragraph: what is demonstrably different after this ships? Name the capability, artifact, or behaviour change. Avoid "improved" or "enhanced".

## Why

Why this is worth doing now, grounded in the bookmark and review. If only a subset of the bookmark is relevant, name it here. If the review decision looks wrong (partial relevance that should be `monitor`), say so.

## Acceptance Criteria

- [ ] AC1: ...
- [ ] AC2: ...

Rules:
- 2–6 ACs per spec
- ACs are outcomes, not steps ("X is functional/visible/tested", not "write a script for X")
- Sub-ACs for multi-codebase work:
  - [ ] AC2.1 workspace: ...
  - [ ] AC2.2 sindustries: ...

## Non-Goals

What this spec deliberately does not cover. Name adjacent things that are out of scope for this slice.

## Notes

One short paragraph on the intended approach and a brief stack touchpoints line. This is orientation for Rowan, not a tech design — keep it to what can't be inferred from the ACs. If a tech design already exists, link it here instead of repeating its content.

**Stack touchpoints:** `path/to/file.py` (what changes), `lobster/example.yaml` (pattern to follow).
```

### Proposed Tasks (add when warranted)

```markdown
## Proposed Tasks

### <Task Title>

- **Priority:** `high | medium | low`
- **Assignee:** _blank_
- **Why:** One sentence — what problem does this task solve, and why now?
- **Deliverable:** The concrete artifact or change that lands in the PR.
- **Acceptance Criteria:**
  - Matches a parent AC or sub-AC from the spec above
  - ...
```

Task rules:
- 1–3 tasks per spec; more only if work clearly separates into distinct PRs with independent value
- Each task maps to a single reviewable PR with a noticeable outcome — not a phase, not a spike
- A task that re-builds something already live must name the existing thing and explain why
- Assignee is always blank

## Step 4 — Return Metadata

If the caller expects pipeline-consumable output, print this JSON to stdout after writing the file(s):

```json
{
  "specs": [
    {
      "title": "Spec title",
      "specDoc": "brain/specs/<topic>/<slug>-<key>.md",
      "specType": "infra workflow",
      "proposedTasks": [
        {
          "title": "Task title",
          "priority": "high",
          "summary": "Why this task",
          "deliverable": "What lands in the PR",
          "acceptanceCriteria": ["AC1 text", "AC2 text"]
        }
      ]
    }
  ]
}
```

If invoked interactively, skip the JSON — just confirm the path written.

## Quality Bar

**Faithfulness:** The spec reflects the bookmark's framing. If the bookmark describes four ideas, all four appear — even if only one maps to a known friction.

**Grounded in what exists:** Specs reference actual files and systems from the sindustries repo. "Extend `scripts/bookmarks/common.py`" beats "extend the pipeline".

**Honest scope:** If this spec only covers part of the bookmark, say why. Don't silently drop half the source material.

**No placeholder language:** "validate", "explore", "refine" only appear with a concrete deliverable. "Validate the schema by running it against fixture data" is fine. "Validate approach" is not.

**ACs are outcomes:** Each AC describes a state of the world, not a task to perform.

## Anti-patterns

- Writing the spec before reading the sindustries system specs — duplication is the most common quality failure
- Reshaping the bookmark around known frictions (frictions are context, not spec targets)
- Proposed tasks that are just ACs reworded as deliverables
- Vague stack touchpoints like "the bookmark pipeline" — name the actual file
- Splitting specs or tasks to match AC count rather than delivery boundaries
