---
status: shipped
task_id: 2e724316-e81a-4c28-9be9-a59a9a566136
product_spec: n/a
shipped_pr: 1009
shipped_date: 2026-11-17
---

# cto-craft: split filter and writer models (MiniMax filters, GPT Luna writes)

## Provenance

This document is the **retrospective tech-design record** for task
`2e724316-e81a-4c28-9be9-a59a9a566136`. The implementation shipped first
(PR #1009, merged 2026-11-17, Quinn approved the implementation PR and Tom
approved the structured `tech_design` gate on 2026-11-18). The design
artefact was written afterwards so the task's code-task tech-design gate
carries a durable link instead of a bare approval row.

It is reconstructed from Tom's directive (2026-11-16/17), Quinn's PR #1009
description, and the merged implementation — not from a pre-implementation
draft. Sections below therefore read as the design the implementation
followed, and the verification matrix records what actually ran.

## Product intent

Tom's feedback on the cto-craft weekly tweet batch: tweets were hard to
follow and never included a source URL. The root cause was a bare stateless
MiniMax JSON-schema completion call that did **both** relevance filtering and
tweet copywriting in one shot, then auto-imported straight into the Content
Scheduler.

Tom's decision (2026-11-16/17) was to split the two jobs into two raw model
calls — no agent, no Tasks API handoff ("reading an article and writing a
tweet is a simple job, doesn't need a content task"):

- **Filter** — `minimax-portal/MiniMax-M3` (unchanged default) scores
  relevance / worldview / evidence and classifies a `suggested_tweet_type`.
  It never writes copy.
- **Writer** — `openai/gpt-5.6-luna` ("GPT Luna") by default, env-configurable,
  falling back to the filter model on exhaustion. It loads the raw `SKILL.md`
  text for the matching tweet-type skill and passes it **verbatim** into its
  own raw model call as the prompt ("I will pass the skill in to the raw model
  call just as text").

URL inclusion is deliberately **not** enforced by the pipeline. Each skill
judges per article whether the link earns its place ("the skill itself can be
the judge").

## Task facts

- Task: `2e724316-e81a-4c28-9be9-a59a9a566136` — cto-craft: MiniMax filters
  relevance only, GPT Luna writes tweet copy via per-type skill text
- Task type: `code` (code-task workflow)
- Repository: `Stoffer-Industries/sindustries`
- Implementation branch: `cto-craft-writer-split` (PR #1009, merged)
- This record's branch: `task-2e724316-cto-craft-writer-split`
- Worktree: `/Volumes/WD1/worktrees/rowan/cto-craft-writer-split-design`
- Workflow package: `agents/workflows/cto-craft-tweet-drafts/`
- Depends on PR #1007 (tweet-type skills), merged 2026-11-16

## Service boundary and data ownership

The natural source of truth for this change is the **workflow boundary** —
the cto-craft LangGraph pipeline — not the model layer, not the Content
Scheduler API, and not an app UI.

- **Owner:** the cto-craft workflow package owns candidate selection and
  tweet generation. It owns the filter/writer split, the writer model
  configuration, and the skill-text hand-off.
- **Content Scheduler** remains the destination of finished drafts only. It
  is not involved in scoring or copywriting, and the pipeline adds no new
  task type and no Tasks API handoff.
- **Skills** (`agents/skills/content/tweet-*-*/SKILL.md`) own tweet style and
  per-article link judgement. The workflow consumes their raw text; it does
  not duplicate or re-implement their rules.
- **No new service, queue, table, or external integration.** The split is two
  model calls inside one existing pipeline, so no extraction or migration plan
  is required and no temporary placement is introduced.

### `.openclaw` boundary

None. The writer model is invoked through the existing
`openclaw infer model run` path already used by the filter step, with no
changes to `~/.openclaw/` configuration, gateway settings, or credentials.

## Implementation plan (file/module scope)

- `src/cto_craft_workflow/angle_model.py`
  - `AngleOutput` drops `tweet_body` and adds `suggested_tweet_type`.
  - New `TweetWriterOutput`, `WriterPrompt`, `load_skill_text(tweet_type)`,
    `OpenClawTweetWriter` / `OpenClawWriterConfig`, and a `TweetWriter`
    protocol with a `FakeTweetWriter` double.
  - `_SKILL_DIR_BY_TWEET_TYPE` maps `short_tip` / `personal_philosophy` /
    `personality_post` to their skill directories; the raw `SKILL.md` text is
    passed verbatim into the writer prompt.
- `prompts/angle-evaluator.md` — the filter prompt now states that its job is
  classification only; link policy and disagreement-copy sections move out to
  the skills.
- `src/cto_craft_workflow/graph.py` — new `write_tweet_copy` node between
  `select_distinct_angles` and `import_drafts`, with routing
  `_route_after_write`.
- `src/cto_craft_workflow/settings.py` — `CTO_CRAFT_WRITER_MODEL`
  (default `openai/gpt-5.6-luna`), `CTO_CRAFT_WRITER_FALLBACK_MODEL`
  (default: the filter model), `CTO_CRAFT_WRITER_THINKING_LEVEL`,
  `CTO_CRAFT_WRITER_MAX_ATTEMPTS`.
- `src/cto_craft_workflow/state.py` — `is_valid_candidate_shape` checks
  `suggested_tweet_type` instead of `tweet_body`, because pre-write candidates
  no longer carry final copy.
- `src/cto_craft_workflow/cli.py`, `studio.py` — writer settings plumbed
  through the CLI and the LangGraph studio entry point.
- `README.md` — documents the two-model split.
- Tests — `tests/test_angle_model.py` (writer skill-text loading, verbatim
  pass-through, model+fallback retry, over-length rejection), plus updates to
  graph, durability, dedup, postgres_saver and studio tests.

## Data model and API contract changes

- `AngleOutput` (Pydantic): `tweet_body` removed, `suggested_tweet_type`
  added (`min_length=1`). This is the only contract change and it is internal
  to the workflow package.
- `PipelineState` candidate shape: pre-write candidates carry
  `suggested_tweet_type` instead of final copy; the durable checkpoint shape
  changes accordingly.
- No HTTP API, no database schema, no queue payload change, and no change to
  the Content Scheduler request contract.

## Workflow, cron, and skill changes

- The LangGraph workflow gains one node (`write_tweet_copy`); the edge order
  becomes `select_distinct_angles → write_tweet_copy → import_drafts`.
- **No cron change.** The workflow keeps its existing schedule and entry
  points.
- **No skill change.** The three tweet-type skills are consumed as raw text;
  PR #1007 (merged) is the only skill-side change and it is a dependency, not
  part of this task's delivery.

## Test plan and AC verification matrix

The pipeline is a scheduled backend job with no user-facing UI, so E2E
browser coverage is not applicable. The fallback layer is the workflow's own
pytest suite, run in CI by the `cto-craft-tweet-drafts tests` job (pytest
against a real PostgreSQL service for the saver tests).

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 | `test_angle_model.py` schema/prompt assertions + `test_graph.py` candidate-shape assertions — `cto-craft-tweet-drafts tests` CI job | unit + integration |
| AC2 | `test_load_skill_text_reads_real_skill_files`, `test_writer_passes_skill_text_verbatim_into_prompt`, `test_writer_rejects_tweet_over_280_chars` — `cto-craft-tweet-drafts tests` CI job | unit |
| AC3 | `test_writer_falls_back_to_second_model_on_exhaustion`, `test_writer_returns_none_when_both_models_exhausted` — `cto-craft-tweet-drafts tests` CI job | unit |
| AC4 | `test_happy_path_creates_three_drafts` + `test_import_drafts_truncates_url_bearing_tweet_and_preserves_link` — `cto-craft-tweet-drafts tests` CI job | integration |
| AC5 | full suite of the `cto-craft-tweet-drafts tests` CI job — 72 passed, 0 failed | unit + integration |
| AC6 | README two-model-split section, reviewed as part of PR #1009 | doc review |

Manual verification (not part of CI): a live weekly batch run with the writer
model enabled, to confirm the written copy reads as one of the three tweet
types and that the Content Scheduler import is unchanged.

## Open questions and risks

- **Writer-model availability.** `openai/gpt-5.6-luna` was picked from a live
  probe of the allow-list; Anthropic models were blocked by expired
  auth/billing credits and several OpenAI models were rate-limited at probe
  time. The writer model is env-configurable precisely because gateway model
  availability fluctuates. Risk: a gateway outage on the writer model
  degrades the batch to the filter-model fallback.
- **Dashboard/metric naming.** Not applicable to this split, but noted from
  the adjacent OTel work: scrape-shaped metric names do not survive an OTLP
  push translation. Out of scope here.
- **Skill-text drift.** The writer receives the skill's raw text at run time,
  so a skill edit changes writer behaviour without a pipeline code change. This
  is intentional (Tom's instruction) but means skill edits are effectively
  behaviour changes to the tweet output.
- **No URL policy in the pipeline.** By design. If the link-judgement rules in
  the skills prove inconsistent in practice, the policy belongs in the skills,
  not the workflow — but that is a future decision, not a defect in this split.
