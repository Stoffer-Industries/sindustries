# CTO Craft Recurring Tweet-Draft Pipeline

A weekly LangGraph workflow that fetches the latest Tech Manager Weekly
issue, follows its public blog-post links, scores each article against Tom's
documented worldview, and emits 3–5 Content Scheduler drafts (`source:
cto_craft`, `status: draft`) per run. Runs with no new content produce no
output and no notification.

This is the Sindustries repo's first production-shaped LangGraph proof of
concept. It exists to evaluate LangGraph's graph control flow, parallel
fan-out, checkpoint persistence, retry behaviour, conditional no-op path,
and resumability against a real but low-risk content workflow before the
broader tooling decision.

## Source-of-truth documents

- **Product spec:** `brain/tasks/specs/in-progress/cto-craft-tweet-pipeline.md`
- **Tech design:** `docs/specs/cto-craft-tweet-pipeline-tech-design.md`
- **Task:** `9dfe56e4-13c4-4bb4-b53f-de7c77afd0d2`

## Ownership boundaries

| Concern | Owner |
|---|---|
| Draft content items + deduplication | Content Scheduler DB and API |
| Workflow execution checkpoints | LangGraph PostgreSQL checkpointer |
| Weekly schedule + Telegram delivery | OpenClaw cron/runtime |
| Tom's worldview profile | Versioned `prompts/tom-worldview.md` |
| Approval, scheduling, publishing | Existing Content Scheduler / Mission Control flow |

The Python client talks to Content Scheduler over its API only. It never
writes to the Content Scheduler database directly.

## Setup

The package is uv-managed. CI and runtime invoke it via `uv run --frozen`:

```bash
cd agents/workflows/cto-craft-tweet-drafts
uv sync --frozen --extra dev
```

## CLI

```bash
uv run --frozen python run.py validate
uv run --frozen python run.py run --json
uv run --frozen python run.py replay --thread-id cto-craft/2026-W33 --json
```

`run` and `replay` print a single JSON envelope on stdout. The cron prompt
announces the `notification` field verbatim only when non-null; otherwise it
returns `NO_REPLY`.

## Required environment

| Variable | Purpose |
|---|---|
| `CTO_CRAFT_LANGGRAPH_DATABASE_URL` | PostgreSQL checkpointer + advisory lock |
| `CONTENT_SCHEDULER_BASE_URL` | Content Scheduler API base |
| `CONTENT_SCHEDULER_INGEST_SECRET` | Auth header for the import endpoint |
| `CTO_CRAFT_TMW_ARCHIVE_URL` | Optional override; defaults to `https://www.techmanagerweekly.com/` |
| `CTO_CRAFT_FETCH_TIMEOUT_SECONDS` | Optional; default 15 |
| `CTO_CRAFT_MODEL_TIMEOUT_SECONDS` | Optional; default 30 |
| `CTO_CRAFT_MIN_RESONANCE_SCORE` | Optional; default 0.55 |

## Tests

```bash
uv run --frozen pytest tests/
```

All tests are deterministic and offline. The fake model adapter and fake HTTP
server are used in place of any external model or network call. CI does not
need API keys.

## Non-goals

- Automatic approval, scheduling, or publication.
- Authenticated, paywalled, member-only, or mailbox ingestion.
- Sources other than Tech Manager Weekly and the public articles it links.
- Threads, media, replies, or direct X posting.
- A general LangGraph hosting platform (Agent Server, LangSmith Deployment).
- Redis, Kubernetes, or LangSmith credentials.
