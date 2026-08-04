---
name: initiative-author
description: "Create and maintain hypothesis-first initiative index documents without duplicating WSJF scores."
---

# Initiative Author

Use this skill when creating or reviewing an initiative at `brain/initiatives/<slug>/`.

## Purpose

An initiative is a bounded business hypothesis with a concrete output. Its `index.md` is the stable front door for the initiative; it is not a task list, campaign plan, market-research log, or scorecard.

The strategy graph at `brain/sindustries/strategy-graph.md` remains the source of truth for initiative relationships, Impact tags, status, and WSJF inputs/scores. Never copy WSJF values into `index.md`.

## When to use

- Create `index.md` when an initiative is first recognised in the strategy graph.
- Review an index when the hypothesis, output, Impact relationship, or status changes.
- Use it before starting market research, campaign planning, or implementation work.
- Do not promote an `ideas/` file automatically. Promote only when the idea has a clear hypothesis, at least one Impact, and a deliberate status in the strategy graph.

## Required inputs

Read, in order:

1. `brain/sindustries/strategy-graph.md` — canonical initiative name, hypothesis, output, Impact relationships, and status.
2. `brain/README.md` — folder and output conventions.
3. Existing `brain/initiatives/<slug>/index.md`, if present.
4. Existing initiative artifacts (`market-research.md`, `campaign.md`, `feature-ideas.md`, `prospects/`) for links and open questions.
5. Relevant task-board records when populating the Tasks section.

If the graph and an existing index disagree, do not silently choose. Preserve the graph as authoritative and note the mismatch for Quinn/Tom.

## Index shape

Create `brain/initiatives/<slug>/index.md` with this structure:

```md
# Initiative — <Name>

**Status:** active | parked | blocked
**Impacts:** <Impact name(s)>
**Owner:** <agent/person/role>
**Strategy graph:** [`strategy-graph.md`](../../sindustries/strategy-graph.md)

## Hypothesis

If <action/approach>, then <expected customer or business outcome>, because <reason>. We will know this is working when <observable proof>.

## Output

<What this initiative is intended to produce. Keep it outcome-oriented, not an implementation plan.>

## Why now

<Current reason this deserves attention; include time sensitivity only as narrative. Do not add a WSJF score.>

## Open questions

- [ ] <Question that could change the hypothesis, output, or next decision>

## Artifacts

- Market research: [market-research.md](market-research.md) — add only when present or planned
- Campaign: [campaign.md](campaign.md) — add only when present or planned
- Feature ideas: [feature-ideas.md](feature-ideas.md) — add only when present or planned
- Prospect runs: [`prospects/`](prospects/) — add only when present or planned

## Tasks

- <Task title or ID with a link if available>
```

## Authoring rules

1. **Hypothesis first.** Use an if/then/because/proof shape. Do not write a theme label or vague aspiration.
2. **Use the graph's wording as the starting point.** Expand it only enough to make the expected proof and decision boundary explicit.
3. **Do not invent evidence.** If proof, owner, timing, or task links are unknown, say `TBD` or leave an explicit open question.
4. **Keep the output bounded.** Name what this initiative will produce and what it will not attempt.
5. **Keep strategy and execution separate.** Initiative index = why/what; market research and campaigns = working documents; task specs = implementation requirements.
6. **No WSJF duplication.** Scores live only in `strategy-graph.md`.
7. **Status mirrors the graph.** Do not change status in `index.md` independently.
8. **Links should be real.** Do not add links to files that do not exist unless the line is explicitly labelled `planned`.
9. **Tasks are references, not a second task system.** Use task IDs/titles and links where available; do not copy acceptance criteria into the index.
10. **Keep it current.** When a hypothesis is disproven, update the hypothesis/output/open questions and link the evidence rather than appending an unstructured diary.

## Creating a new index

1. Derive the canonical slug from the graph and create the initiative directory if needed.
2. Copy the graph's hypothesis, output, Impact tags, and status into the index.
3. Expand the hypothesis to include observable proof without adding unsupported claims.
4. Add only artifacts that exist or are explicitly planned.
5. Populate open questions from the graph's unresolved decisions, existing research, and Tom's stated concerns.
6. Populate Tasks from the task board only when verified; otherwise write `No linked tasks recorded yet.`
7. Check that no WSJF number appears in the file and that status/Impacts match the graph.

## Updating an existing index

- Preserve useful history, but keep the current hypothesis and status near the top.
- Replace stale links rather than accumulating duplicate sections.
- Add dated notes only when a decision or evidence changes the initiative; detailed findings belong in `market-research.md`.
- If the initiative is parked or blocked in the graph, update the index status but do not delete its artifacts.

## Validation checklist

Before considering an index complete:

- [ ] Canonical initiative name and slug match the strategy graph.
- [ ] Status matches the graph.
- [ ] Every graph Impact is represented; no new Impact was invented.
- [ ] Hypothesis states an expected outcome and observable proof.
- [ ] Output is bounded and not just a theme.
- [ ] No WSJF score or copied scoring inputs appear.
- [ ] Open questions are explicit where uncertainty remains.
- [ ] Artifact links are real or marked planned.
- [ ] Tasks are references only and acceptance criteria were not duplicated.
- [ ] The document passes a direct read-through for unsupported certainty.

## Boundaries

This skill does not:

- change `strategy-graph.md`;
- change initiative status, Impact tags, or WSJF scores;
- create Tasks API tasks;
- write product specs or tech designs;
- conduct market research;
- send outreach or publish campaigns.

Flag graph changes to Quinn/Tom and route concrete implementation work through the normal task workflow.