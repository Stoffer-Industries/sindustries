---
name: prospect-finder
description: "Produce an evidence-backed prospect shortlist for a product launch from public signals. Use when Ivy runs a growth-research pass and needs qualified early-customer candidates, each with an originating public source link, fit/timing/reachability scores, and a personalized outreach opener for Tom to review manually. Never sends, schedules, or publishes outreach."
---

# Prospect Finder

Turn one product URL (or a positioning brief) into a dated, evidence-backed
prospect shortlist that a human can act on: every candidate carries the public
source that justified including them, a score per dimension with a one-line
reason, and an opener that responds to the observed signal.

Used by Ivy during a market-research pass. Quinn orchestrates; Tom remains the
only person who contacts a prospect.

## RULES

- **Never send, schedule, queue, or publish outreach.** This skill produces a
  reviewed shortlist. Tom sends. Any send-shaped action belongs to a separate
  task routed through the normal approval flow.
- **Every retained prospect keeps its originating public source URL.** A
  candidate whose source cannot be verified is excluded, or is marked
  `unverified` and must not be presented as high-confidence.
- **Every score carries a one-line reason.** A bare number is not a score; it
  is a claim with no audit trail.
- **Never present inference as observation.** Facts read from a public source
  and assumptions drawn from it must be distinguishable in the artifact.
- **Never imply a relationship the source does not support.** An opener may
  reference what a prospect publicly said; it may not claim they asked for,
  received, or expect anything.
- **Never use non-public context.** Public professional signals only. Do not
  infer sensitive attributes and do not collect private contact data.
- **Always state coverage honestly.** Thin public-signal coverage produces an
  explicit confidence note and a short list, not a padded list.
- **Keep the skill reusable.** Do not hardcode a product, an initiative, or a
  customer segment into the procedure.
- **Preserve disagreement in the inputs.** If the product URL and the
  positioning brief disagree, record it as an open question and ask Tom or
  Quinn — do not silently pick one.

## PROCESS

1. **Read the initiative context.** Read `brain/sindustries/initiatives/<slug>/index.md`,
   the existing `market-research.md`, and any relevant `campaign.md` section.
   Record which question the run is meant to answer.
2. **Frame the ICP hypothesis.** From the product URL or brief, name the
   buyer, the buying context, the trigger that would make them look now, the
   explicit exclusions, and a confidence level. Separate what the input states
   from what is inferred. If the URL and the brief disagree, stop and ask.
3. **Select venues and record the search scope before searching.** Name the
   places where this buyer plausibly discusses the problem. Write the scope
   down first so thin coverage is visible afterwards.
4. **Search and fetch public sources.** Use the agent runtime's `web_search`
   and `web_fetch`. Keep the URL and enough surrounding context that a human
   can verify why the candidate qualified.
5. **Deduplicate and reject.** Drop generic mentions, unverifiable claims, and
   candidates with no identifiable problem signal.
6. **Score.** Apply the rubric below. Sort the shortlist by total, descending.
7. **Draft the opener.** It responds to the observed signal. It is a draft for
   Tom to review — never a message that has been sent.
8. **Write the artifact** to the requested `output_path` using the template
   below, and validate it:

   ```bash
   python3 agents/skills/growth/prospect-finder/scripts/validate_prospect_artifact.py <path-to-artifact>
   ```

   Fix every reported problem. A run that cannot produce a conforming
   artifact is a failed run, not a run with warnings.
9. **Hand off.** Append a dated entry to `market-research.md` — the question
   answered, what changed, what the output feeds. If the run reveals a
   campaign opportunity, add a proposal to `campaign.md` with a measurable
   target and a current success-score baseline. Do not create an outbound
   task without Tom approving the external action.

## OUTPUT FORMAT

### Artifact shape

One dated Markdown file per run, written to the explicit `output_path`. The
seven sections are required and must appear in this order:

| Section | Required labelled fields |
|---|---|
| `## Run metadata` | `Date`, `Initiative`, `Input`, `Search scope`, `Sources checked` |
| `## ICP hypothesis` | `Buyer`, `Buying context`, `Likely venues`, `Exclusions`, `Confidence` |
| `## Coverage note` | `Venues searched`, `Inaccessible`, `Signal coverage`, and `Confidence note` when coverage is `thin` |
| `## Prospect shortlist` | one `###` block per prospect (fields below) |
| `## Review queue` | one line per prospect naming it and its state |
| `## Market-research handoff` | `Question answered`, `Key implications`, `Links` |
| `## Approval boundary` | free text containing the no-send sentence |

### Prospect block

Each prospect is an `###` heading followed by these labelled bullets, in this
order:

```markdown
### Prospect 1 — Example Buyer (@example-buyer)

- **Source:** https://forum.example.com/t/thread-about-the-problem
- **Signal:** "Short quote or close paraphrase of what they actually wrote."
- **Fit:** 4 — one line on why the product solves this person's problem.
- **Timing:** 3 — one line on why now rather than later.
- **Reachability:** 2 — one line on how reachable they are today.
- **Total:** 9
- **Opener:** "Draft that references the signal above. Not sent."
- **Confidence:** medium
- **Caveats:** none
- **Review state:** proposed
```

- `Source` — an absolute `http(s)` URL. Required, and the reason the
  candidate is on the list.
- `Signal` — excerpt or close paraphrase of the public signal.
- `Fit` / `Timing` / `Reachability` — integer `0`-`5`, then ` — `, then the
  one-line reason. The em dash separator is required.
- `Total` — the sum of the three scores. Must equal them.
- `Opener` — a draft personalized to the signal. Never sent.
- `Confidence` — `high`, `medium`, or `low`.
- `Caveats` — disqualifying caveats, or `none`.
- `Review state` — `proposed` (default), `keep`, `drop`, or
  `needs-more-evidence`.

Prospects are listed in descending `Total` order.

### Scoring rubric

Each dimension is an integer `0`-`5` with a one-line reason. These are
decision aids, not calibrated conversion probabilities.

| Score | Fit | Timing | Reachability |
|---|---|---|---|
| 5 | The problem this solves is the core of their work | Actively signalling the problem now | Directly reachable on a channel they use |
| 4 | Clear, strong problem-solution match | Recent, visible signal | Reachable, minor friction |
| 3 | Plausible match, some assumptions | Signal exists but is undated or soft | Reachable with effort |
| 2 | Weak or partial match | No clear timing signal | Indirect or unclear route |
| 1 | Speculative match | Signal contradicts timing | Barely reachable |
| 0 | Not a match | No signal | Not reachable |

### Approval boundary

The artifact ends with a sentence stating that no outreach was sent or
scheduled, and that Tom acts on the shortlist manually.

## KNOWLEDGE FILES

Read in this order:

1. `agents/skills/growth/prospect-finder/examples/prospect-shortlist-example.md`
   — a complete, generic example artifact in the exact required shape.
2. `brain/sindustries/initiatives/<slug>/index.md` — the initiative being
   worked on.
3. `brain/sindustries/initiatives/<slug>/market-research.md` — prior findings,
   to append to rather than overwrite.
4. `brain/sindustries/initiatives/<slug>/campaign.md` — the campaign section
   the run may feed.
5. `docs/specs/signal-driven-prospect-finder-tech-design.md` — the approved
   design behind this skill.

## ONBOARDING

The caller supplies:

- `initiative` — slug matching `brain/sindustries/initiatives/<slug>/`. Required.
- `product_url` **or** `positioning_brief` — at least one is required.
- `market_research_question` — optional; the question the run answers.
- `customer_context` — optional; corrections to the inferred ICP, exclusions,
  geography, or constraints.
- `top_n` — optional; requested shortlist size. Default `10`, hard maximum
  `25`. A run never scrapes without a bound.
- `output_path` — required; the explicit workspace path for the dated
  artifact.

The skill returns the written artifact path and the validator's result. It
writes to the workspace; it never sends anything.

## IDENTITY

> Read the invoking agent's `AGENTS.md` for role, authority, and voice.
