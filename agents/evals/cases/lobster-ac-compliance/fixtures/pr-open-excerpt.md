### AC evidence annotations (priority-ordered)

The lobster enforces a per-AC evidence rule at the `doing → acceptance` gate. **Every task AC must appear in the PR body as a `- [x]` checkbox.** Each `- [x]` AC line must end with one of the following annotations, in priority order:

| Priority | Annotation | When to use |
|---|---|---|
| 1st | `(🧪 testID: <id>)` | Playwright e2e test or unit test ID — **always prefer this** |
| 2nd | `(⚠️ not tested: <reason>)` | When automation is genuinely impractical — requires a substantive reason |
| — | `(📄 not code: <reason>)` | AC fulfilled outside the codebase (doc, spec, config update) |
| — | `(🔗 pr: #<n>)` | Covered by a different merged PR |

`file:` has been removed. If you wrote a unit test, reference it via `testID` or explain in `not tested` why it wasn't feasible to add a Playwright test. Emojis are optional but encouraged for visual clarity.

Other rules that apply:

- **Never nest parentheses inside AC evidence annotations.** Use `-` or `:` separators in test names instead:
  - **Breaks:** `AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-render (desktop))`
  - **Flat form (correct):** `AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-render - desktop)`
- **Never omit AC checkboxes from a feature-task PR body.** Use `- [x]`, not bullet, not `- [ ]`, not `✅` emoji, not plain prose. Every task AC must appear in the PR body, with the original task AC sentence copied verbatim before the evidence annotation.
- **Never paraphrase or shorten the AC sentence text.** Copy the task AC sentence exactly.
- **Never append implementation commentary to the verbatim AC sentence outside the recognised trailing evidence annotation.** A suffix such as `— implemented by ...` is parsed as part of the criterion. Put concise evidence inside the final annotation, or move additional explanation to a separate paragraph outside the AC checkbox line.
- **Never use `file:` as an AC evidence annotation.** It has been removed; use `testID` or record a substantive reason in `not tested`.

The PR body must include a `## Acceptance Criteria` section. For multi-task combined deliveries, group ACs under `### Task <task-id> — <short description>`.

For feature-task PRs, verify the read-back still has the exact `## Acceptance Criteria` heading and every completed line has the shape `- [x] AC<n>: <verbatim task AC sentence> (<recognised evidence>)`. Treat an unparenthesised em-dash explanation, an altered sentence, or evidence outside the final annotation as a failed postcondition and fix the body before posting `[implementer-prs]` or merging.

Files changed in this PR:
```
agents/skills/growth/prospect-finder/SKILL.md
agents/skills/growth/prospect-finder/tests/test_validate_prospect_artifact.py
agents/skills/growth/prospect-finder/scoring.py
```
