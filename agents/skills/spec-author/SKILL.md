---
name: spec-author
description: "Write implementation specs for bookmark-reviewed items. Reads workspace context files directly to produce code-factory-aligned product specs under brain/specs/<topic>/."
---

# Spec Author

Write an implementation spec from a reviewed item. This skill runs with full tool access — read the relevant context files, then write a grounded spec rather than reasoning blind from a payload.

## Inputs

The caller may provide any of these and any number of additional reference docs:

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
- Any source material provided (bookmark, review, reference docs)

**Sindustries system specs (already-implemented systems):**
- Read all specs at `codebases/sindustries/docs/specs/` — these describe what actually exists and is live. Read all of them; they are the ground truth for what to build on or supersede.

The goal: walk in knowing what the source material says, what systems already exist, and what frictions are live. A spec that duplicates an existing system or proposes something at odds with current state is a quality failure.

## Step 2 — Assess Before Writing

Before drafting:

1. **Does this overlap with something already implemented?** If an existing sindustries spec already covers the ground, either propose a narrower complementary slice and name what it builds on, or explain why a replacement is warranted.

2. **Are current frictions reflected honestly?** Use the state-of-the-nation as a relevance filter, not a target list to reshape the spec onto.

3. **How many specs?** Default to one. Split only when the work naturally separates into tracks with independent delivery value — different codebases, different rollout timelines, or clearly separable outcomes. Do not split by acceptance criterion alone.

## Step 3 — Write the Spec

### File location

```
/Users/quinnstoffer/.openclaw/workspace/brain/bookmarks/specs/<slug>-<bookmark_key>.md
```

Use kebab-case for the slug, derived from the spec title. No topic subfolder — flat.

### Relative link paths — important

The spec lives at `brain/bookmarks/specs/` (one level inside `brain/bookmarks/`). The `brain/` directory is a symlink to iCloud. Links must stay **within** the `brain/` tree.

- Bookmark link: `../x/<filename>.md` — one level up reaches `brain/bookmarks/`, then `x/`
- Summary link: `../summaries/<filename>.md` — same base, into `summaries/`
- Do **not** use `../../brain/...` or deeper — that exits the symlink boundary

Files outside the `brain/` vault (e.g. workspace `MEMORY.md`, sindustries specs) cannot be linked relatively. Reference by name only, no link.

### Format

The spec follows the code-factory product spec template so it can be used directly as a product spec when Tom approves it. Notes is intentionally lean — implementation detail belongs in Rowan's tech design, not here.

```markdown
# Spec — <Title>

## Source
- **Bookmark:** [<bookmark filename>](../x/<bookmark filename>)
- **Summary:** [<summary filename>](../summaries/<summary filename>)
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

Why this is worth doing now, grounded in the source material.

## Acceptance Criteria

- [ ] AC1: ...
- [ ] AC2: ...

Rules:
- Up to 10 ACs per spec, prefer fewer unless necessary
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

**Grounded in what exists:** Specs reference actual files and systems from the sindustries repo. "Extend `scripts/bookmarks/common.py`" beats "extend the pipeline".

**Honest scope:** If this spec only covers part of the source material, say why.

**No placeholder language:** "validate", "explore", "refine" only appear with a concrete deliverable. "Validate the schema by running it against fixture data" is fine. "Validate approach" is not.

**ACs are outcomes:** Each AC describes a state of the world, not a task to perform.

## Anti-patterns

- Writing the spec before reading all sindustries system specs — duplication is the most common quality failure
- Using current frictions as targets to reshape the spec onto (frictions are context, not spec drivers)
- Proposed tasks that are just ACs reworded as deliverables
- Vague stack touchpoints like "the bookmark pipeline" — name the actual file
- Splitting specs or tasks to match AC count rather than delivery boundaries
