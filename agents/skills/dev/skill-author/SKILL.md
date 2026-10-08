---
name: skill-author
description: Create or update repository-owned SKILL.md files using the canonical 5+1 blueprint and evidence-backed feedback loop.
---

# Skill author

## RULES

- **Always use the 5+1 section order:** `RULES`, `PROCESS`, `OUTPUT FORMAT`,
  `KNOWLEDGE FILES`, `ONBOARDING`, then `IDENTITY`.
- **Always preserve operational guidance when restructuring an existing skill.**
  Move facts to the right section; do not silently remove behavior.
- **Always derive rules from observed corrections, tests, task acceptance
  criteria, or review evidence.** Do not invent constraints while generalizing
  a one-off failure.
- **Never restate the agent's identity in full.** Use a minimal `IDENTITY`
  pointer to the invoking agent's `AGENTS.md`.
- **Never claim a skill is complete without validation.** Run skill validation,
  focused tests for touched helpers, and a diff review.
- **Always capture a recurring correction in the same work cycle.** Decide
  whether it changes future behavior; if it does, append a concise rule with
  its evidence to `RULES` and add or update a focused check where practical.
  If it is one-off, keep it in the task or review record instead.
- **Keep routing conditions in the frontmatter description and execution in
  `PROCESS`.** Put branch-only detail in referenced resources rather than
  bloating the main skill.

## PROCESS

1. Establish the contract. Read the existing skill and resources, or collect
   the new skill's triggers, expected outcome, and persistence target. Read the
   task/spec and concrete correction evidence; completion criterion: every
   workflow branch has an evidence-backed behavior.
2. Choose invocation. Set a model-facing description unless the skill is
   manual-only or a direct tool command; add optional frontmatter only when it
   changes runtime behavior. Completion criterion: frontmatter matches how the
   skill will be discovered and invoked.
3. Map the content. Place constraints in `RULES`, ordered actions in
   `PROCESS`, caller/result contracts in `OUTPUT FORMAT` and `ONBOARDING`,
   prerequisites in `KNOWLEDGE FILES`, and only an identity pointer in
   `IDENTITY`. Completion criterion: the six headings appear in canonical
   order and no required operational fact is orphaned.
4. Capture feedback. Inspect user corrections, review comments, test failures,
   and task evidence from this work cycle. Promote only recurring or
   generalizable corrections into concise `RULES` entries, preserving the
   evidence in the PR/task notes. Completion criterion: rule-worthy corrections
   are durable and one-off details are not encoded as policy.
5. Persist the repository-owned skill through the normal branch and review
   workflow. Keep the main `SKILL.md` under the repository's configured size
   limit; move substantial branch detail into directly linked resources.
   Completion criterion: every changed file is in the intended worktree and
   every resource pointer resolves.
6. Validate with
   `python <skill-creator>/scripts/quick_validate.py <skill-directory>`, run
   every touched helper's focused test, and inspect `git diff --check`.
   Completion criterion: validation, focused tests, and structural review all
   pass before handoff.

## OUTPUT FORMAT

Every authored or updated skill must contain this skeleton:

```markdown
---
name: <skill-name>
description: <trigger situations and produced outcome>
---

# <Skill title>

## RULES
<evidence-backed always/never constraints>

## PROCESS
<ordered actions with checkable completion criteria>

## OUTPUT FORMAT
<result contract, examples, or templates>

## KNOWLEDGE FILES
<prioritized files/resources to read first>

## ONBOARDING
<caller inputs and activation pattern>

## IDENTITY
> Read the invoking agent's `AGENTS.md` for role, authority, and voice.
```

The handoff summary must name the skill path, trigger description, resources
changed, validation commands and results, and any feedback promoted into
`RULES`.

## KNOWLEDGE FILES

Read these in order before authoring:

1. The existing target skill and every resource it links to, or the requested
   skill contract when creating a new skill.
2. The governing task/spec and its acceptance criteria.
3. `agents/skills/dev/pr-open/SKILL.md` — the proven 5+1 blueprint pilot and
   its preservation/evidence conventions.
4. The invoking agent's `AGENTS.md` — role, authority, and safety boundaries
   referenced by `IDENTITY`.
5. Relevant review comments, test failures, task comments, and prior skill
   corrections — source material for evidence-backed rules.
6. The skill validation script and focused tests named by the repository.

## ONBOARDING

The caller must provide:

- create or update;
- target skill path/name and trigger situations;
- the task/spec or concrete evidence that justifies the procedure;
- existing resources and behavior that must be preserved;
- required caller inputs, output contract, and identity-pointer target;
- reviewer/branch context when the repository workflow requires a PR.

For an update, callers may provide a bounded goal instead of a full rewrite;
the author must preserve unrelated content and return the complete final skill
body in the repository diff.

## IDENTITY

> Read the invoking agent's `AGENTS.md` for role, authority, and voice. This
> skill supplies only the shared skill-authoring procedure.

