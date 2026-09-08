---
name: initiative-learning-update
description: "Update an existing initiative after evidence, stage, score, or decision changes; keep its current state and changelog auditable."
---

# Initiative Learning Update

Use this when new evidence or a stage change affects an existing initiative. Use `initiative-author` for the initiative document shape and `strategy-graph` for scoring.

## Workflow

1. Read the strategy graph entry, the initiative `index.md`, relevant working artifacts, and the evidence that triggered the update. Identify the exact mismatch between current documentation and observed state. **Done when:** every proposed change traces to a source, decision, or explicitly marked unknown.

2. Preserve one initiative while its hypothesis is still being tested. Update the same hypothesis, current stage, output, evidence, open questions, and next experiment as learning accumulates. Split, graduate, park, or replace it only after an explicit continue/change/stop decision or an explicit Tom/Quinn instruction. **Done when:** lifecycle structure reflects the decision boundary rather than delivery phases.

3. Keep the initiative index current near the top. Add or update a concise `## Current stage` section when the active constraint or experiment changes; refresh success-metric state and dates without inventing values. Put detailed research in `market-research.md` and execution detail in its owning artifact. **Done when:** a reader can identify the current hypothesis, stage, next experiment, and unresolved decision without reading history first.

4. Recalculate strategy-graph inputs only when the evidence changes value, time criticality, risk/opportunity enablement, or remaining job size. Treat shipped work as evidence, but estimate job size from all work remaining to reach the initiative's hypothesis decision—not only the remaining build. Update the ranked list when the score changes. **Done when:** the formula, rationale, and ranking agree, and no score is copied into the initiative index or campaign.

5. Append one dated `## Changelog` entry to the initiative index for material hypothesis, stage, score, evidence, owner, status, or next-experiment changes. State what changed and why; keep detailed findings in their owning artifacts. Do not add entries for formatting-only edits. **Done when:** the current edit has an auditable summary without turning the index into a diary.

6. Check adjacent artifacts for stale stage, score, or decision language and update only affected references. Preserve verified history and unrelated work. **Done when:** no touched initiative artifact contradicts the graph or index.

## Verification

- The initiative remains intact until its hypothesis decision unless an explicit governance decision says otherwise.
- Current state appears before changelog history.
- Evidence and unknowns are distinguishable.
- Remaining job size includes validation work needed to reach the decision.
- Graph arithmetic and active ranking are correct.
- The index contains no WSJF score.
- Every material update has one dated changelog entry.
