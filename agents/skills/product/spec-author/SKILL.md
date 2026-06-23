---
name: spec-author
description: "Write product specs for bookmark-reviewed items. Reads workspace context files directly to produce durable, implementation-agnostic specs under brain/bookmarks/specs/."
---

# Spec Author

Write a product spec from a reviewed item. This skill runs with full tool access — read the relevant context files, then write a grounded spec rather than reasoning blind from a payload.

**Key principle:** A spec describes what the system *can do* after this ships. It does not describe how to build it. Rowan will read the approved spec plus the reference docs and produce the implementation plan. The spec must stay useful even if the codebase changes before work begins.

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

One paragraph: what is demonstrably different after this ships? Name the capability, artifact, or behaviour change. Avoid "improved" or "enhanced". Write this as a user/operator observation — what can someone *do* or *see* that they couldn't before?

## Why

Why this is worth doing now, grounded in the source material.

## Acceptance Criteria

- [ ] AC1: ...
- [ ] AC2: ...

Rules:
- Up to 8 ACs per spec, prefer fewer
- Each AC is an **observable outcome**: a behaviour, capability, or property that can be verified without knowing how it was built
- ACs must be implementation-agnostic: no script names, file paths, field names, CLI flags, or class names
- ACs do not prescribe the approach — "the pipeline can retrieve relevant prior knowledge before writing a review" is correct; "build_index.py scans brain/bookmarks/ and writes bookmark-corpus-index.jsonl with fields path, topic, kind..." is not
- Sub-ACs only for genuinely independent delivery tracks (different codebases, different timelines):
  - [ ] AC2.1 workspace: ...
  - [ ] AC2.2 sindustries: ...

## Non-Goals

What this spec deliberately does not cover. Name adjacent things that are out of scope for this slice.

## Notes

One short paragraph: the key insight from the source material and any hard constraints or non-obvious integration points Rowan should know before designing the implementation. Do not describe the implementation — that is Rowan's job.

Optionally, name the area of the codebase this work lands in (e.g. "bookmark pipeline", "tasks API", "OpenClaw gateway extension") so Rowan knows where to start reading. Do not name specific files, scripts, or schemas.
```

## Step 4 — Return Metadata

If the caller expects pipeline-consumable output, print this JSON to stdout after writing the file(s):

```json
{
  "specs": [
    {
      "title": "Spec title",
      "specDoc": "brain/bookmarks/specs/<slug>-<key>.md",
      "specType": "infra workflow"
    }
  ]
}
```

If invoked interactively, skip the JSON — just confirm the path written.

## Quality Bar

**Outcome-focused ACs:** Each AC describes a state of the world after the feature ships. A reader who has never seen the codebase should be able to understand every AC. If an AC requires knowing a file path or script name to make sense, rewrite it.

**Durable:** The spec should still be valid if Rowan starts work six months from now and the codebase has evolved. ACs that name specific scripts will rot; ACs that describe capabilities won't.

**Honest scope:** If this spec only covers part of the source material, say why.

**No placeholder language:** "validate", "explore", "refine" only appear with a concrete deliverable. "The system validates bookmark keys against the pipeline state" is fine. "Validate approach" is not.

**No duplication:** Specs don't re-implement what's described in the sindustries system specs. Reference existing systems by name in Source and Notes; don't rebuild them in ACs.

## Anti-patterns

- Writing implementation steps into ACs: "write a script at scripts/bookmarks/build_index.py that scans..." — this is a tech design, not a product spec
- Naming specific scripts, field schemas, CLI flags, or class names anywhere except Notes (and even there, only if they are hard constraints, not proposals)
- Using current frictions as targets to reshape the spec onto (frictions are context, not spec drivers)
- Writing the spec before reading all sindustries system specs — duplication is the most common quality failure
- Splitting specs to match AC count rather than delivery boundaries
- Notes longer than one paragraph — if it needs more than that, it is leaking into tech design
