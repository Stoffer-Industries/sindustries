---
name: spec-author
description: Write implementation-agnostic specs from direct requests, tasks, bookmarks, or reviews, choosing the correct brain/specs destination by intake type.
---

# Spec author

## RULES

- **Always describe observable outcomes and requirements.** A spec says what
  the system can do after the work ships, not how Rowan should build it.
- **Always choose intake mode before choosing a destination.** Direct user
  requests are manual task specs unless the caller explicitly provides
  bookmark/review/summary pipeline state.
- **Always use the caller's provided paths and references.** Search likely
  workspace locations once only when a named source is missing, then record
  the missing source honestly if durable context is sufficient.
- **Always keep acceptance criteria implementation-agnostic.** Describe
  observable behavior; do not name scripts, paths, schemas, CLI flags, class
  names, rollout steps, or migration plans in ACs.
- **Always verify a claimed third-party API capability live** before making it
  a settled assumption. If no live access exists, name the capability as an
  explicit open risk in Notes.
- **Never write a manual task spec to `brain/bookmarks/specs/`.** Bookmark
  destinations are only for explicit bookmark/review/summary pipeline items.
- **Never default an ambiguous request to bookmark mode.** Ask for or record
  the missing intake distinction; do not infer pipeline state from an idea.
- **Never duplicate an existing system spec.** Narrow the complementary slice
  or explain why replacement is warranted.
- **Never include roadmap, sequencing, or implementation design** unless Tom
  explicitly asks for it. Put adjacent work in Non-Goals.
- **Never split specs to match AC count.** Split only when independent delivery
  tracks have different codebases, timelines, or outcomes.
- **Never omit the bookmark-origin `Approved by Tom` checkbox** or the required
  classification metadata when the output feeds the bookmark pipeline.

## PROCESS

1. Choose intake mode. Classify the request as manual task spec or
   bookmark-origin spec before reading or writing; completion criterion: the
   mode and destination are explicit.
2. Read context. Always read `docs/state-of-the-nation.md` when available and
   every caller-provided source. For overlapping work, read relevant system
   specs and only the relevant older specs. For bookmark-origin work, read the
   bookmark, review, and/or summary files; completion criterion: existing
   systems and live frictions are understood.
3. Assess before writing. Check destination, overlap, scope, source honesty,
   implementation leakage, and third-party API feasibility. Run a live API
   capability check when the outcome depends on posting, replying, mentioning,
   permissions, pricing, or endpoint behavior; completion criterion: open risks
   are either verified or named explicitly.
4. Write one durable spec unless independent delivery value justifies a split.
   Use the correct destination, stable links, observable outcome, why, ACs,
   non-goals, and concise notes; completion criterion: the spec is
   implementation-agnostic and does not duplicate an existing system.
5. Return metadata. Confirm the path when invoked interactively; when the
   caller expects pipeline output, emit the JSON bundle with `title`,
   `specDoc`, `specType`, `classification`, and
   `classification_rationale`; completion criterion: every returned spec has a
   valid classification and rationale.

## OUTPUT FORMAT

Write the following document shape:

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
- [ ] **Approved by Tom**

---

## Outcome
<one paragraph describing the demonstrable post-ship difference>

## Why
<why this is worth doing now, grounded in the source>

## Acceptance Criteria
- [ ] AC1: <observable outcome>
- [ ] AC2: <observable outcome>

## Non-Goals
<adjacent work deliberately excluded>

## Notes
<one short paragraph of insight and hard constraints>
```

For pipeline consumers, return:

```json
{
  "specs": [
    {
      "title": "Spec title",
      "specDoc": "brain/tasks/specs/open/<slug>.md",
      "specType": "infra workflow",
      "classification": "feature",
      "classification_rationale": "Why this is feature-typed and not code/research."
    }
  ]
}
```

Use `brain/bookmarks/specs/<slug>-<bookmark_key>.md` for bookmark-origin
outputs and `brain/tasks/specs/open/<slug>.md` for manual task specs. Keep
bookmark links within the `brain/` symlink boundary; for bookmark specs use
`../x/<filename>.md` and `../summaries/<filename>.md`.

## KNOWLEDGE FILES

Read these in priority order:

1. `/Users/quinnstoffer/.openclaw/workspace/docs/state-of-the-nation.md` when
   available — current shipped system context.
2. Caller-provided request, reference, bookmark, review, and summary paths —
   source material for the spec.
3. Relevant existing system specs under
   `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/systems/`.
4. Relevant older specs under
   `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/specs/`.
5. The governing task/initiative and any named memory references.
6. A live third-party API surface when the outcome depends on its capability;
   do not rely on cached documentation alone.

## ONBOARDING

The caller may provide:

| Input | Meaning |
|---|---|
| `request` | Direct user request or task/initiative description |
| `reference_path` | Source/reference document |
| `bookmark_path` | Bookmark markdown; implies bookmark-origin mode |
| `review_path` | Review markdown; usually implies bookmark-origin mode |
| `summary_path` | Bookmark summary markdown; implies bookmark-origin mode |
| `topic` | Topic slug such as `infra`, `app-assistant`, or `app-tasks` |
| `bookmark_key` | Stable key for bookmark-origin naming |

Use provided paths. Do not guess paths from state files unless pipeline
recovery is explicitly requested. If intake mode is ambiguous, stop before
writing and request the missing distinction.

## IDENTITY

> Read the invoking agent's `AGENTS.md` for role, authority, and voice. This
> skill supplies only the implementation-agnostic spec-authoring procedure.
