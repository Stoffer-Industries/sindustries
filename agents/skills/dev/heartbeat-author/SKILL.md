---
name: heartbeat-author
description: "Create, restructure, or review repository-owned HEARTBEAT.md files so each polling unit has an isolated trigger, action, output contract, state boundary, and promotion path to a cron or workflow."
---

# Heartbeat author

## RULES

- **Keep HEARTBEAT.md as the polling loop, not the execution playbook.** It owns discovery order, triggers, skip conditions, per-pass priorities, and cadence. Put detailed execution in WORKFLOW.md, reusable mechanics in a SKILL.md, and exact scheduled work in a cron prompt.
- **Every heartbeat activity is a named unit.** A unit is an independently understandable block with its own trigger, action, output contract, state boundary, and growth trigger. Do not interleave one unit's output rules, state writes, or escalation rules with another unit's procedure.
- **A unit must be extractable without semantic surgery.** A future editor should be able to lift the unit into a cron prompt by carrying its complete block plus explicitly named shared scheduler policy; no hidden dependency on the preceding or following unit is allowed.
- **Separate unit policy from scheduler policy.** Global heartbeat defaults, turn/time budgets, concurrency rules, and final aggregation belong in a clearly marked scheduler section. They must not be embedded inside whichever unit happens to be nearby.
- **One unit owns one output channel.** Define whether the unit is silent, returns a structured marker, sends a notification, writes a task comment, or emits another artifact. Do not mix multiple units' output requirements in one prose paragraph or one ambiguous global silence rule.
- **State ownership is explicit.** Name every file, task/API surface, cron scratch area, or external system the unit reads or writes. A unit must not silently write another unit's state or infer ownership from a filename.
- **Discovery precedes silence.** A heartbeat may only return HEARTBEAT_OK/NO_REPLY after every required discovery unit has run or has explicitly recorded its safe skip condition. A unit's empty result must not suppress another unit's required discovery.
- **Stop after the useful work for this pass.** Once the unit has taken its one bounded action, or recorded a newly evidenced blocker, stop that unit. Do not start a second item merely because time remains. The scheduler may proceed to the next independent unit only if the turn budget permits and the unit has not reached a pass-level stop condition.
- **Bound the pass.** A heartbeat should have a fixed per-pass turn/time budget, a maximum number of units to act, and a defined stop response on budget exhaustion. Prefer one concrete action per unit; do not allow an unbounded loop over tasks, PRs, incidents, or files.
- **Promote growth instead of extending indefinitely.** When a unit becomes large, slow, stateful, or independently schedulable, spin it out into a special cron first. When two or more crons need ordering, shared state, retries, or handoffs, define a workflow that owns that orchestration. Do not solve scheduler pressure by adding more prose to HEARTBEAT.md.
- **Prefer existing skills before writing inline procedure.** Before adding execution detail to a heartbeat, search the repository's skills and use the most specific applicable skill. If one exists, the heartbeat names the trigger and points to it; it does not duplicate or reinvent the procedure. Create or update a skill when the primitive is reusable, stable, or shared by more than one unit/agent.
- **Human-facing docs are not a skill substitute.** A `docs/` or `docs/systems/` reference may define the human-facing contract and belongs in the skill's knowledge files, but it does not satisfy a reusable execution-procedure requirement. If no suitable `SKILL.md` exists for a reusable, stable, or shared procedure, create or update one using `skill-author` before finalizing the heartbeat; do not leave the runbook inline and claim the skill gap is resolved.
- **Cross-cutting duplication is a defect.** Shared retro-note, failure-notification, environment-loading, or output rules belong in a referenced skill or canonical shared section. Do not copy them into every unit unless the unit-specific difference is explicit.
- **Cron prompts inherit the cron-author contract.** Any unit promoted to a cron must use the cron-author skill and end with the exact notify-soft-fails block from that skill. The heartbeat must not absorb, rewrite, or omit that block; it only defines the unit's trigger, handoff, and visibility contract.
- **Preserve behavior during restructuring.** Move content to the correct boundary; do not silently remove operational guidance. If a rule cannot be assigned to a unit or scheduler policy, stop and report the ambiguity instead of guessing.
- **Use evidence for promotion decisions.** Recommend a cron/workflow based on observed duration, cadence collisions, repeated trigger patterns, repeated output/state coupling, or a concrete task/PR correction—not merely line count.

## PROCESS

1. **Establish the contract.** Read the target HEARTBEAT.md, its agent definition README, the agent's WORKFLOW.md/SOUL.md where referenced, linked skills and cron prompts, and the governing task or direct request. Record the agent, schedule/cadence, output surface, state files, and existing stop conditions.
2. **Inventory the current units.** Mark each independent activity in the file. For each, capture the trigger and cadence; discovery inputs and action boundary; current output/silence/escalation requirements; reads, writes, and owner of each state surface; maximum intended work in one pass; and linked workflow, skill, cron, or lobster.
3. **Draw the boundaries before editing.** Classify every paragraph as scheduler policy, unit policy, execution reference, shared policy, or unexplained/ambiguous. A paragraph that serves two units must be split or moved to shared scheduler policy; do not leave it intermingled.
4. **Apply the unit contract.** Rewrite each unit using the OUTPUT FORMAT below. Keep the unit self-contained and use pointers rather than duplicating execution details. A unit may have subsections, but its output contract and stop condition must remain visible at the unit's top level.
5. **Define the scheduler envelope.** Add one clearly named scheduler section containing only cross-cutting rules: discovery-before-silence, ordering, turn/time budget, maximum actions, concurrency, final aggregation, and what happens when the budget is exhausted. The scheduler must not decide a unit's domain-specific output.
6. **Run the skill-gap audit.** Search the installed/repository skill catalog before drafting execution prose. For every unit containing reusable, stable, or shared procedure, record one disposition: point to the most specific existing skill; create/update a repository-owned skill with `skill-author`; or prove that the detail is heartbeat-specific trigger/stop/handoff policy. Treat human-facing `docs/` references as knowledge inputs, not as a skill disposition. Do not leave a reusable runbook inline or claim completion with an unresolved skill gap.
7. **Decide whether to promote work.** For each unit, choose one outcome:
   - **Keep in heartbeat:** small, bounded, every-pass discovery or routing; no independent long-running workflow.
   - **Spin out to a special cron:** a distinct cadence/trigger, isolated model or tools, long-running work, optional maintenance, or a unit whose runtime regularly consumes the heartbeat budget. Replace the old body with a pointer to the cron prompt and retain only the heartbeat handoff/visibility rule.
   - **Create or extend a workflow:** two or more crons/units require serialization, dependency ordering, shared state transitions, retries, approval gates, or a durable handoff. The workflow owns sequencing; heartbeat only discovers whether it needs to start or report it.
   - **Extract a reusable skill:** the same execution primitive is useful to multiple agents or has a stable input/output contract.
8. **Define stop conditions explicitly.** For each unit specify when it stops after one action, one item, a bounded batch, a blocker, an external failure, or budget exhaustion. At scheduler level specify the order in which remaining units are skipped or continued. Never imply “continue until done” without a hard bound.
9. **Check output isolation.** Read the final document as if extracting each unit into a fresh cron session. Verify that each unit's output can be understood without neighboring prose and that a unit cannot accidentally emit another unit's marker, notification, or task comment.
10. **Validate preservation and structure.** Diff against the original; confirm all old operational facts are either preserved, moved to the correct file, or replaced by an explicit pointer. Check that the file has one title, consistent section headings, named scheduler policy, named units, and no orphaned paragraphs. Run repository-specific validation and focused tests named by touched resources.
11. **Report the promotion map.** Return a compact table of unit → keep/cron/workflow/skill, with evidence, stop condition, output surface, and any unresolved ambiguity. Do not claim the heartbeat is finished until every unit has a disposition.

## OUTPUT FORMAT

Use this shape for every repository-owned HEARTBEAT.md. The exact unit names vary by agent, but the boundaries do not.

~~~~markdown
# HEARTBEAT.md — <Agent>

**Scope of this file:** polling cadence, discovery order, per-pass triggers,
priority, and stop conditions. Execution details live in WORKFLOW.md/skills.

## Scheduler policy

- **Fresh-pass contract:** what is loaded and what must run before silence.
- **Order:** Unit A → Unit B → Unit C, with explicit dependency rationale.
- **Budget:** target wall-clock/turn budget and hard maximum.
- **Action cap:** maximum items/actions per unit and per pass.
- **Concurrency:** what may run in parallel and what must be serialized.
- **Exhaustion:** what happens when budget/cap is reached; how remaining units
  report a bounded skip without claiming clean success.
- **Final output:** how unit outputs are aggregated without changing their
  individual contracts.

## Unit: <stable-name>

**Purpose:** one sentence describing this activity only.

**Trigger:** exact condition/cadence that activates this unit.

**Inputs and state:** files, APIs, queues, comments, cron state, or other
surfaces read; name the owner and permitted writes.

**Action boundary:** what this unit may do in one pass. Point to WORKFLOW.md,
a skill, or a cron prompt for execution details.

**Output contract:** exact output marker/notification/artifact, and the only
conditions under which this unit produces it. State its silent result explicitly.

**Stop condition:** the hard bound for one pass, for example one top candidate,
one task, one bounded batch, first external blocker, or budget exhaustion.

**Growth trigger:** evidence that moves this unit to a dedicated cron, reusable
skill, or ordered workflow.

## Unit: <next-stable-name>

...

## Shared failure policy

Point to the canonical notify-soft-fail or incident-routing skill. Keep only
heartbeat-specific routing/stop behavior here.

If a unit is promoted to a cron, its cron prompt must end with this exact
cron-author block (not a paraphrase):

~~~markdown
# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
~~~

## Retro notes scan

A bounded pointer to the retro-notes skill; do not duplicate its procedure.
~~~~

### Unit output contract rules

- A unit may return silent, HEARTBEAT_OK, a structured line, a task comment, a PR marker, or a direct notification—but the choice must be explicit.
- “Only output if...” must name the unit's own event and output surface. Never rely on a global silence rule to explain what belongs to the unit.
- If multiple units produce output, the scheduler aggregates them as separate labeled records or lines. It must not merge them into an unlabelled narrative where ownership is lost.
- A unit's output must not claim another unit's success, failure, or state transition.

### Stop and promotion decision table

| Evidence | Keep in heartbeat | Special cron | Ordered workflow |
|---|---|---|---|
| Small read-only check, bounded one-action routing | Yes | No | No |
| Distinct cadence, optional maintenance, isolated tools/model, or repeated budget pressure | No | Yes | Maybe |
| Long-running or independently retryable work | No | Yes | Maybe |
| Two or more crons need ordering, shared transitions, retries, or handoffs | No | No | Yes |
| Shared primitive used by multiple agents | No | Maybe | No—extract a skill |
| Unit cannot be bounded without “continue until done” | No | Yes | If sequencing is also required |

## KNOWLEDGE FILES

Read these in order before authoring or reviewing a heartbeat:

1. The target agent's HEARTBEAT.md, WORKFLOW.md, SOUL.md, and DoD.md where present.
2. agents/definitions/README.md for the canonical HEARTBEAT vs WORKFLOW split and source-of-truth rules.
3. The installed/repository skill catalog: search for an applicable skill before writing inline execution procedure.
4. The agent's linked skills, cron prompts, and workflow/lobster definitions.
5. agents/skills/dev/skill-author/SKILL.md for the repository's 5+1 skill blueprint and evidence-preservation conventions.
6. agents/skills/ops/cron-author/SKILL.md for cron prompt ownership and the notify-soft-fails requirement.
7. agents/skills/ops/notify-soft-fail/SKILL.md for external-failure routing.
8. docs/systems/agent-incidents.md when the heartbeat reads or writes incident state.
9. Recent task/PR/review evidence establishing duration, collisions, regressions, or repeated corrections.

## ONBOARDING

The caller must provide:

- create, restructure, or review;
- target agent and HEARTBEAT.md path;
- the activities that must remain in the heartbeat and any known cron/workflow candidates;
- governing task/spec or concrete evidence justifying the change;
- execution resources and behavior that must be preserved;
- schedule, output destinations, state surfaces, and reviewer/branch context when repository workflow requires a PR.

For a review, the caller may provide only the target path and bounded goal; the author must inventory every unit and return a promotion map. For a restructure, a complete final file is required in the repository diff; do not leave a half-migrated unit with its output contract in one section and its stop condition in another.

## IDENTITY

> Read the invoking agent's AGENTS.md for role, authority, and voice. This skill supplies only the heartbeat authoring procedure.
