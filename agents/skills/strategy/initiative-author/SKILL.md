---
name: initiative-author
description: "Create and maintain hypothesis-first initiative index documents without duplicating WSJF scores."
---

# Initiative Author

Use this skill when creating or reviewing an initiative at `brain/sindustries/initiatives/<slug>/`.

## Purpose

An initiative is a bounded business hypothesis with a concrete output. Its `index.md` is the stable front door for the initiative; it is not a task list, campaign plan, market-research log, or scorecard.

The strategy graph at `brain/sindustries/strategy/strategy-graph.md` remains the source of truth for initiative relationships, Impact tags, status, and WSJF inputs/scores. Never copy WSJF values into `index.md`.

## When to use

- Create `index.md` when an initiative is first recognised in the strategy graph.
- Review an index when the hypothesis, output, Impact relationship, or status changes.
- Use it before starting market research, campaign planning, or implementation work.
- Do not promote an `ideas/` file automatically. Promote only when the idea has a clear hypothesis, at least one Impact, and a deliberate status in the strategy graph.

## Required inputs

Read, in order:

1. `brain/sindustries/strategy/strategy-graph.md` — canonical initiative name, hypothesis, output, Impact relationships, and status.
2. `brain/README.md` — folder and output conventions.
3. Existing `brain/sindustries/initiatives/<slug>/index.md`, if present.
4. Existing initiative artifacts (`market-research.md`, `campaign.md`, `feature-ideas.md`, `prospects/`) for links and open questions.
5. Relevant task-board records when populating the Tasks section.

If the graph and an existing index disagree, do not silently choose. Preserve the graph as authoritative and note the mismatch for Quinn/Tom.

## Index shape

Create `brain/sindustries/initiatives/<slug>/index.md` with this structure:

```md
# Initiative — <Name>

**Status:** active | parked | blocked
**Impacts:** <Impact name(s)>
**Exec Owner:** <single named person accountable for driving this initiative — Tom, Quinn, or Ivy>
**Contributors:** <agents/people doing the work — may be a list>
**Strategy graph:** [`strategy-graph.md`](../../strategy/strategy-graph.md)

## Hypothesis

If <action/approach>, then <expected customer or business outcome>, because <reason>. We will know this is working when <observable proof>.

## Output

<What this initiative is intended to produce. Keep it outcome-oriented, not an implementation plan.>

## Success metrics

This is a living section. Define what success looks like at initiative level and update it as evidence changes. Link a dashboard when one exists; do not invent current values or dashboard URLs.

| Metric | Success looks like | Current | Target | Status | Last updated | Dashboard |
|---|---|---:|---:|---|---|---|
| <metric> | <observable proof> | <value or `TBD`> | <target or `TBD`> | not-started / tracking / hit / missed / not-instrumented | YYYY-MM-DD | <link or `—`> |

Campaign-specific targets and scores belong in `campaign.md`; link them from this section rather than duplicating them.

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

1. **Exec Owner is one name, not a list.** This is the single accountable person driving the initiative forward at the executive level — currently Tom, Quinn, or Ivy given the org structure. Rowan and Lox are contributors/executors, not exec owners; list them under Contributors instead. If it's unclear who should own an initiative, ask rather than guessing — ownership is a real accountability decision.
2. **Exec Owner is stable through the initiative's lifecycle.** Do not reassign ownership because the initiative moves phase (e.g. build → growth, validation → scale). The owner set at initiative creation carries it end-to-end and is accountable for the full arc of their analysis and outcomes — like a PnL owner. Pick the owner who should carry it from the start with this in mind, not the owner best suited to the current phase. Only change Exec Owner via an explicit, deliberate decision from Tom/Quinn — never as a side effect of updating status, artifacts, or success metrics.
3. **Hypothesis first.** Use an if/then/because/proof shape. Do not write a theme label or vague aspiration.
4. **Use the graph's wording as the starting point.** Expand it only enough to make the expected proof and decision boundary explicit.
5. **Do not invent evidence.** If proof, timing, or task links are unknown, say `TBD` or leave an explicit open question.
6. **Keep the output bounded.** Name what this initiative will produce and what it will not attempt.
7. **Make success observable.** Define one or more outcome metrics, a target where known, current value/status, and last-updated date. Use `TBD` or `not-instrumented` rather than guessing.
8. **Link evidence.** Add dashboard links when they exist. A missing dashboard is acceptable; a fabricated link is not.
9. **Keep strategy and execution separate.** Initiative index = why/what; market research and campaigns = working documents; task specs = implementation requirements.
10. **No WSJF duplication.** Scores live only in `strategy-graph.md`.
11. **Status mirrors the graph.** Do not change status in `index.md` independently.
12. **Links should be real.** Do not add links to files that do not exist unless the line is explicitly labelled `planned`.
13. **Tasks are references, not a second task system.** Use task IDs/titles and links where available; do not copy acceptance criteria into the index.
14. **Keep it current.** When a hypothesis is disproven, update the hypothesis/output/open questions and link the evidence rather than appending an unstructured diary.

## Creating a new index

1. Derive the canonical slug from the graph and create the initiative directory if needed.
2. Set the Exec Owner (single name) and Contributors before anything else — if it's not obvious, ask Quinn/Tom rather than defaulting.
3. Copy the graph's hypothesis, output, Impact tags, and status into the index.
4. Expand the hypothesis to include observable proof without adding unsupported claims.
5. Add only artifacts that exist or are explicitly planned.
6. Define the first version of `Success metrics`, even if current/target are `TBD` or status is `not-instrumented`.
7. Populate open questions from the graph's unresolved decisions, existing research, and Tom's stated concerns.
8. Populate Tasks from the task board only when verified; otherwise write `No linked tasks recorded yet.`
9. Check that no WSJF number appears in the file and that status/Impacts match the graph.

## Updating an existing index

- Preserve useful history, but keep the current hypothesis and status near the top.
- Replace stale links rather than accumulating duplicate sections.
- Add dated notes only when a decision or evidence changes the initiative; detailed findings belong in `market-research.md`.
- If the initiative is parked or blocked in the graph, update the index status but do not delete its artifacts.

## Validation checklist

Before considering an index complete:

- [ ] Exec Owner is a single named person (Tom, Quinn, or Ivy given current org), not a list or a role label.
- [ ] Canonical initiative name and slug match the strategy graph.
- [ ] Status matches the graph.
- [ ] Every graph Impact is represented; no new Impact was invented.
- [ ] Hypothesis states an expected outcome and observable proof.
- [ ] Output is bounded and not just a theme.
- [ ] Success metrics state what success looks like and include current/target/status/date.
- [ ] Dashboard links are real, or shown as `—`.
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
