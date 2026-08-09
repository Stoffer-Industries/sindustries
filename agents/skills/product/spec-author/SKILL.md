---
name: spec-author
description: "Write implementation-agnostic specs from direct requests, tasks, bookmarks, or reviews, choosing the correct brain/specs destination by intake type."
---

# Spec Author

Write durable, implementation-agnostic specs. A spec describes what the system can do after the work ships, not how Rowan should build it.

This skill supports two intake modes:

1. **Manual task spec** — Tom/Quinn directly asks for a spec, references an initiative/task, or provides a reference document that is not a bookmark pipeline item.
2. **Bookmark-origin spec** — the bookmark/review pipeline provides a bookmark, review, summary, bookmark key, or bookmark workflow state.

If the intake mode is ambiguous, do **not** default to bookmark mode. Direct user requests are manual task specs unless explicitly tied to the bookmark pipeline.

## Key Principle

A spec describes observable outcomes and requirements. It does not describe implementation details, code structure, scripts, schemas, CLI flags, rollout sequencing, or migration steps. Rowan will produce the implementation plan separately.

## Inputs

The caller may provide any of these and any number of additional reference docs:

| Input | Description |
|---|---|
| `request` | Direct user request or task/initiative description |
| `reference_path` | Absolute or workspace-relative path to source/reference material |
| `bookmark_path` | Absolute path to bookmark markdown; implies bookmark-origin mode |
| `review_path` | Absolute path to review markdown; usually implies bookmark-origin mode |
| `summary_path` | Absolute path to bookmark summary markdown; implies bookmark-origin mode |
| `topic` | Topic slug, e.g. `infra`, `app-assistant`, `app-tasks`, `crypto`, `design` |
| `bookmark_key` | Short unique key used to name bookmark-origin output |

Use provided paths. Do not guess paths from state files unless the caller explicitly asks for pipeline recovery.

## Step 1 — Choose Intake Mode

Before reading/writing, decide the destination mode:

- Use **manual task spec** when Tom asks directly for a spec, references an initiative/task, or names a non-bookmark reference document.
- Use **bookmark-origin spec** only when source material is explicitly a bookmark/review/summary pipeline item or a `bookmark_key` is provided.
- If a manual request mentions a bookmark-like idea but does not provide pipeline state, keep it manual unless Tom says it should enter the bookmark pipeline.

## Step 2 — Read Context

Before writing anything, read relevant context:

**Always:**
- `/Users/quinnstoffer/.openclaw/workspace/docs/state-of-the-nation.md` when available.
- Any source/reference material provided by the caller.

**Relevant existing systems:**
- Read existing system specs that may overlap the new work under `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/systems/`.
- Read older specs under `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/specs/` only when they are relevant to the area being specified. Do not blindly load unrelated historical specs.

**Bookmark-origin specs:**
- Read the provided bookmark, review, and/or summary files.

**Manual task specs:**
- Read any named reference documents or memory references.
- If a named reference is missing, search likely workspace locations once. If it is still missing but durable context is enough, explicitly note the missing source in the spec's Source section.

The goal: know what the source material says, what systems already exist, and what frictions are live. A spec that duplicates an existing system or proposes something at odds with current state is a quality failure.

## Step 3 — Assess Before Writing

Before drafting:

1. **Destination:** Confirm the output folder from the table below.
2. **Overlap:** If an existing system already covers the work, either propose a narrower complementary slice and name what it builds on, or explain why replacement is warranted.
3. **Scope:** Default to one spec. Split only when the work naturally separates into tracks with independent delivery value.
4. **Source honesty:** If source material includes roadmap/sequencing but Tom excluded it, keep it out and list it as a Non-Goal.
5. **Implementation leakage:** Remove technical design details from ACs.

## Step 4 — Write the Spec

### File locations

#### Manual task specs

New manually requested specs go here:

```text
/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/<slug>.md
```

Use kebab-case for the slug, derived from the spec title. Do not append a bookmark key for manual task specs unless the caller explicitly requests it.

If the spec is already attached to an in-progress task and the task points elsewhere, preserve the established task path rather than moving it unexpectedly.

#### Bookmark-origin specs

Bookmark pipeline specs go here:

```text
/Users/quinnstoffer/.openclaw/workspace/brain/bookmarks/specs/<slug>-<bookmark_key>.md
```

Use this only for bookmark/review pipeline items. Do not write direct/manual specs to `brain/bookmarks/specs/`.

#### Completed specs

Do not move specs to `done/` from this skill unless explicitly asked. Completion/archive movement belongs to task lifecycle cleanup.

### Relative link paths

The `brain/` directory is a symlink to iCloud. Keep links within the `brain/` tree when possible.

For bookmark-origin specs in `brain/bookmarks/specs/`:
- Bookmark link: `../x/<filename>.md`
- Summary link: `../summaries/<filename>.md`
- Do **not** use `../../brain/...` or deeper — that exits the symlink boundary.

For manual task specs in `brain/tasks/specs/open/`:
- Prefer source names or stable workspace-relative paths.
- Do not invent relative links to missing reference files.
- Files outside the `brain/` vault can be referenced by name/path, but do not rely on portable relative links.

### Format

```markdown
# Spec — <Title>

## Source
- **Reference:** <source name/path, or `_none_` if direct request>
- **Topic:** `<topic>`
- **Spec Type:** `<infra workflow | assistant feature | app feature | data pipeline | tooling | product feature>`
- **Systems:** <relevant existing systems, or `_none_`>
- **Previous revision:** _none_ (or link/name if this is a revision)
- **Created:** <YYYY-MM-DD>

**Status:** Draft

---

## Outcome

One paragraph: what is demonstrably different after this ships? Name the capability, artifact, or behaviour change. Avoid "improved" or "enhanced". Write this as a user/operator observation — what can someone do or see that they could not before?

## Why

Why this is worth doing now, grounded in the source material.

## Acceptance Criteria

- [ ] AC1: ...
- [ ] AC2: ...

## Non-Goals

What this spec deliberately does not cover. Name adjacent things that are out of scope for this slice.

## Notes

One short paragraph: the key insight from the source material and any hard constraints or non-obvious integration points Rowan should know before designing the implementation. Do not describe the implementation — that is Rowan's job.
```

## Acceptance Criteria Rules

- Up to 8 ACs per spec; prefer fewer.
- Each AC is an **observable outcome**: a behaviour, capability, or property that can be verified without knowing how it was built.
- ACs must be implementation-agnostic: no script names, file paths, field names, CLI flags, class names, schemas, or test file names.
- ACs do not prescribe the approach.
- Do not include roadmap, sequencing, or migration plan unless Tom explicitly asks for those to be part of the spec.
- Sub-ACs only for genuinely independent delivery tracks with different codebases, timelines, or outcomes.

## Step 5 — Return Metadata

If invoked interactively, confirm the path written.

If the caller expects pipeline-consumable output, print JSON after writing:

```json
{
  "specs": [
    {
      "title": "Spec title",
      "specDoc": "brain/tasks/specs/open/<slug>.md",
      "specType": "infra workflow"
    }
  ]
}
```

For bookmark-origin specs, `specDoc` should point at `brain/bookmarks/specs/...`.

## Quality Bar

**Outcome-focused ACs:** Each AC describes a state of the world after the feature ships. A reader who has never seen the codebase should be able to understand every AC.

**Durable:** The spec should still be valid if Rowan starts work six months from now and the codebase has evolved.

**Honest scope:** If this spec only covers part of the source material, say why.

**No placeholder language:** "validate", "explore", and "refine" only appear with a concrete deliverable.

**No duplication:** Specs do not re-implement what is described in existing system specs. Reference existing systems by name in Source and Notes; do not rebuild them in ACs.

**Correct destination:** Bookmark specs go to bookmark specs; manual task specs go to task specs/open.

## Anti-patterns

- Writing manually requested specs to `brain/bookmarks/specs/`.
- Using bookmark-specific source/filename/link rules for direct user-requested specs.
- Writing implementation steps into ACs.
- Naming specific scripts, field schemas, CLI flags, or class names anywhere except Notes, and even there only when they are hard constraints rather than proposals.
- Using current frictions as targets to reshape the spec onto; frictions are context, not spec drivers.
- Treating roadmap/sequencing as in scope after Tom excludes it.
- Splitting specs to match AC count rather than delivery boundaries.
- Notes longer than one paragraph — if it needs more than that, it is leaking into tech design.
