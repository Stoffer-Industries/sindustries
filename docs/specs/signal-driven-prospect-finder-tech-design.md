---
status: draft
task_id: a384d6ac-43f2-4317-b6d5-5f57ba997965
product_spec: brain/tasks/specs/in-progress/signal-driven-prospect-finder-for-indie-product-launches-d8311c3e5fc50b94.md
shipped_pr: null
shipped_date: null
---

# Signal-Driven Prospect Finder — Tech Design

## Product intent

Given a product URL or short positioning brief, the growth workflow should produce a durable, evidence-backed prospecting artifact: an inferred ideal-customer profile, a shortlist of public-signal prospects, fit/timing/reachability scores with reasons, and a personalised outreach opener for each prospect. The artifact is an input to market research and downstream campaign/outreach planning. It must never send, schedule, or publish outreach automatically.

Source product spec: `brain/tasks/specs/in-progress/signal-driven-prospect-finder-for-indie-product-launches-d8311c3e5fc50b94.md`

## Task and delivery context

- **Task:** `a384d6ac-43f2-4317-b6d5-5f57ba997965` — Signal-Driven Prospect Finder for Indie Product Launches
- **Implementation branch:** `task-a384d6ac-signal-driven-prospect-finder`
- **Implementation worktree:** `/Users/quinnstoffer/workspaces/rowan/sindustries-task-a384d6ac-signal-driven-prospect-finder`
- **Repository:** `Stoffer-Industries/sindustries`
- **Primary consumer:** Ivy, Chief Growth Officer
- **Orchestration:** Quinn; Tom remains approval authority for external outreach and strategic claims

## Scope and ownership

This is a reusable growth skill and artifact format, not a standalone prospect database or autonomous sales agent.

- The skill owns the repeatable research procedure: input validation, ICP framing, public-signal discovery, qualification, scoring, opener drafting, confidence notes, and artifact validation.
- The initiative's market-research document owns the research question and the interpretation of findings.
- A dated prospect shortlist under the relevant initiative owns the run output. It is durable enough for campaign planning and manual review, but it is not a CRM.
- `campaign.md` may consume the shortlist as an input; it owns campaign goals, execution planning, and success scoring.
- Tom owns the final decision to contact a prospect. Sending, scheduling, publishing, CRM mutation, or external commitments remain out of scope.

The skill should be reusable across Money-or-Users initiatives, so it must not hardcode GymTrack, Sindustries Drop, or a single customer segment.

## Runtime and boundary

The skill is implemented as a markdown procedure under `agents/skills/growth/` and is invoked by Ivy during a market-research pass. It uses the agent runtime's web research tools (`web_search` and `web_fetch`) rather than installing or executing the bookmarked Codex package.

The runtime writes output to the workspace brain, which is outside this repository and may be an iCloud-backed symlink. Rowan must not add or modify `brain/` from this worktree. The skill should accept an explicit initiative slug and output path, and Ivy/Quinn owns the workspace-side write. No API keys, login credentials, private contact data, or private-channel access are required.

The source bookmark's `npx` installer is inspiration only. Do not copy it into the runtime or require Codex CLI.

## Input contract

A run accepts:

- `initiative`: slug matching `brain/initiatives/<slug>/`
- `product_url` or `positioning_brief`: at least one is required
- optional `market_research_question`: the question the run is intended to answer
- optional `customer_context`: corrections to inferred ICP, segment exclusions, geography, or known constraints
- optional `top_n`: requested shortlist size, with a sensible default and a hard upper bound to prevent unfocused scraping
- `output_path`: explicit workspace path for the dated shortlist artifact

If the product URL and positioning brief disagree, preserve the disagreement as an open question and request Tom/Quinn clarification rather than silently choosing one.

## Output contract

The skill writes one dated, human-readable Markdown artifact per run at the initiative's `prospects/` location. The artifact contains:

1. **Run metadata** — date, initiative, input, question, search scope, and sources/venues checked.
2. **ICP hypothesis** — buyer, problem/context, trigger, exclusions, and confidence. This is a hypothesis to validate, not a fact inferred from one URL.
3. **Coverage note** — venues searched, what was inaccessible, and whether the category is likely to expose buying signals publicly.
4. **Prospect shortlist** — one section or table row per candidate with:
   - name/handle and public profile or source context;
   - originating public source URL;
   - signal excerpt or concise paraphrase;
   - fit score and reason;
   - timing score and reason;
   - reachability score and reason;
   - total/ordering rationale;
   - personalised opener referencing the observed signal;
   - confidence and disqualifying caveats.
5. **Review queue** — `proposed`, `keep`, `drop`, or `needs-more-evidence` is a human review state; default is `proposed`.
6. **Market-research handoff** — the question answered, key implications, and links to the relevant `market-research.md` entry and/or `campaign.md` section.
7. **Approval boundary** — an explicit statement that no outreach was sent or scheduled.

Every prospect must retain its originating public source link. If the link cannot be verified, the candidate is excluded or marked `unverified` and cannot be presented as a high-confidence result.

## Procedure

1. Read the initiative `index.md`, existing `market-research.md`, and any relevant `campaign.md` section.
2. Establish or refine the ICP hypothesis from the product URL/brief. Separate inferred facts from assumptions.
3. Select public venues where the buyer plausibly discusses the problem. Record the search scope before searching.
4. Search and fetch public sources. Preserve URLs and enough source context for a human to verify the signal.
5. Deduplicate candidates and reject generic mentions, unverifiable claims, or candidates with no identifiable problem signal.
6. Score fit, timing, and reachability using a documented small ordinal scale. Each score needs a one-line reason; scores are decision aids, not claims of predictive precision.
7. Draft an opener that responds to the signal rather than pitching generically. Do not imply a relationship or knowledge that the source does not support.
8. Write the dated shortlist artifact and append a concise handoff to `market-research.md`: what question it answered, what changed, and what output it feeds.
9. If the run reveals a campaign opportunity, add a proposal to `campaign.md` with a measurable target and success-score baseline. Do not create an outbound task until Tom approves the external action.

## Market-research and campaign integration

The prospect finder is one possible output of market research, alongside:

- positioning or ICP changes;
- competitor and substitute analysis;
- pricing or packaging hypotheses;
- product-feature opportunities;
- campaign proposals;
- channel/distribution experiments;
- partnership or BD target hypotheses;
- customer interview questions;
- kill/continue recommendations.

A market-research pass should link the output it creates. It must not force every finding into a campaign. A campaign may consume a shortlist, but it must state its success target and current score in `campaign.md` so later research can evaluate whether the hypothesis is working.

## Data and API contracts

No new database table, service endpoint, or external CRM integration is required for the first cut.

The durable contracts are:

- skill input contract above;
- Markdown shortlist artifact shape above;
- `market-research.md` handoff containing question, finding, implication, and feeds-into link;
- `campaign.md` link plus target/current success score when a campaign is proposed;
- no outbound side effect contract: the skill may draft, never send.

If a later need for cross-run querying appears, treat that as a separate design for a prospect index/CRM boundary. Do not introduce a database now.

## Implementation plan

1. Add a reusable `agents/skills/growth/prospect-finder/SKILL.md` with:
   - when to invoke and required inputs;
   - source and evidence rules;
   - research procedure;
   - scoring rubric;
   - Markdown output template;
   - market-research/campaign handoff rules;
   - approval and no-send guardrails;
   - failure/partial-coverage behaviour.
2. Add a checked-in example/template under the skill directory if it materially improves repeatability; keep it generic and free of real prospect data.
3. Add focused validation tests for the deterministic parts of the artifact contract if the repository has an appropriate test home. At minimum, validate required headings/fields and reject a prospect entry without a source URL or score reason.
4. Update relevant agent/skill documentation only where the new skill needs discoverability. Do not grant Ivy new runtime tools in this implementation; tool access is an OpenClaw configuration decision outside the repository.
5. Do not modify `brain/` from this branch. Ivy/Quinn will exercise the skill against initiative workspace artifacts after merge.

## Acceptance-criterion verification matrix

| AC | Verification plan | Evidence expected |
|---|---|---|
| AC1 | Run the skill with a product URL and inspect the output ICP section; repeat with a positioning brief if practical. | Durable artifact names buyer, buying context, likely public venues, and confidence/assumptions. |
| AC2 | Inspect every retained prospect in a fixture/example run. | Every candidate includes a verifiable originating public source URL. |
| AC3 | Validate the shortlist entries against the scoring rubric and ordering rule. | Each entry has fit, timing, reachability scores plus one-line reasons; output ordering is explainable. |
| AC4 | Human-review generated openers in the fixture/example run. | Each opener references the candidate's source signal and contains no unsupported relationship claim. |
| AC5 | Run with an initiative slug and explicit output path. | One dated Markdown artifact is written under the initiative's `prospects/` output and linked from the market-research handoff. |
| AC6 | Run against a deliberately thin/inaccessible search scope or a category with sparse public signals. | Artifact contains an explicit coverage/confidence warning and does not inflate the shortlist with unsupported candidates. |
| AC7 | Inspect the skill procedure and run output; search implementation for outbound mutation calls. | No send/schedule/publish step exists; output states manual Tom review is required. |

## Open questions and risks

- **Tool availability:** Ivy needs `web_search` and `web_fetch` available in her runtime. Granting or changing those tools is separate from this repository PR and should be reviewed before rollout.
- **Search quality:** public-signal coverage varies sharply by category. The coverage note and confidence warning are mandatory to prevent false certainty.
- **Privacy and targeting:** use only publicly available, relevant professional context; do not infer sensitive attributes or collect private contact data.
- **Scoring calibration:** fit/timing/reachability are initially heuristic. Record reasons and revisit the rubric after real runs rather than presenting the numbers as validated conversion probabilities.
- **Artifact lifecycle:** dated artifacts may accumulate. Retention/archival can be decided after the first few runs; do not build a cleanup system in this cut.
- **Campaign success scoring:** this design links prospect outputs to campaign targets, but campaign measurement/analytics integrations are not part of this feature.
