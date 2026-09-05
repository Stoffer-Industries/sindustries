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
| `CTO_CRAFT_OPENCLAW_MODEL` | Optional; default `minimax-portal/MiniMax-M3` |
| `CTO_CRAFT_OPENCLAW_MAX_ATTEMPTS` | Optional; default 2, max 3 |

## Tests

```bash
uv run --frozen --extra dev pytest tests/
```

All tests are deterministic and offline. The fake model adapter and fake HTTP
server are used in place of any external model or network call. CI does not
need API keys. Durability coverage uses LangGraph's in-memory test
checkpointer in CI; the live Postgres checkpointer remains the runtime backend.

## Local Studio

LangGraph Studio lets an operator inspect the CTO Craft graph topology
and run a sample invocation interactively without ever reaching the
production cron, Content Scheduler, or checkpointer database. The
Studio entrypoint is `cto_craft_workflow.studio:build_studio_graph`,
wired through `langgraph.json` at the package root. The entrypoint
takes no required arguments and returns a fresh compiled graph on
every call; the wiring contract is exercised by the test
`tests/test_studio.py::test_langgraph_json_entrypoint_returns_compiled_graph`,
which fails if the wired entrypoint returns anything other than a
compiled graph (a closure, a builder, an uncompiled `StateGraph`).

### Prerequisites

The Studio CLI is bundled with the `studio` extra, kept separate from
the production runtime venv so cron / CI never installs it.

```bash
cd agents/workflows/cto-craft-tweet-drafts
uv sync --frozen --extra studio
```

### Start Studio

```bash
uv run --frozen --extra studio langgraph dev
```

Open `http://127.0.0.1:8123` (the default Studio port; `localhost` also
works when it resolves locally). Select the
`cto_craft` graph from the left pane. The topology visible in Studio is
the *real* production graph:

```
discover_latest_issue → extract_public_links → fanout_articles
  → fetch_and_score_article (×N via Send)
  → collect_candidates → select_distinct_angles
  → import_drafts → format_notification → END
                            ↓
                       complete_noop → END
```

### Run a safe sample invocation

Studio uses deterministic stub dependencies:

- **Fetcher** — `StubSafeFetcher` returns canned fixtures for the
  TMW archive URL and refuses any other URL with `STUDIO_NO_FIXTURE`
  before opening a socket.
- **Model** — `FakeAngleModel` keyed off the canned article URLs. URLs
  not in the canned set return `None`, exercising the no-op branch
  naturally.
- **Import** — `StudioImportFn` rejects the first call with
  `STUDIO_IMPORT_FORBIDDEN`. **No HTTP request ever reaches Content
  Scheduler.** The graph logs the refusal as a diagnostic and lands in
  the `failed` branch — that red node is the signal that Studio is
  read-only.
- **Checkpointer** — `MemorySaver` (in-memory). Studio never reads or
  writes the production Postgres checkpointer.

Because every side-effect boundary is replaced with a stub, Studio is
safe to run on a laptop with no secrets and no database. A passing
run shows the fan-out, the no-op branch, and the `import_drafts` failure
node — exactly the topology an operator needs to reason about before
touching production.

### Shut down

Studio runs until you stop the `langgraph dev` process (`Ctrl-C`).
Local Studio state under `.langgraph_api/` and `.studio_state/` is
gitignored; nothing local is committed.

### Troubleshooting

- **Port in use.** Pass the port to the CLI explicitly:
  `uv run --frozen --extra studio langgraph dev --port 8124`.
  `LANGGRAPH_DEV_PORT` is not read by the current LangGraph CLI.
- **Runtime compatibility crash on startup.** Keep the Studio-only
  `langgraph-cli[inmem]==0.3.6`, `langgraph-api==0.2.102`, and
  `langgraph-runtime-inmem==0.6.0` pins together. Newer in-memory runtime
  releases expect feature flags not present in the pinned API; upgrading
  only one package can make the server exit before binding port 8123.
- **Studio graph looks empty.** Confirm the Studio CLI is running
  from this package root (where `langgraph.json` lives); Studio only
  loads graphs declared in the local `langgraph.json`.

## Non-goals

- Automatic approval, scheduling, or publication.
- Authenticated, paywalled, member-only, or mailbox ingestion.
- Sources other than Tech Manager Weekly and the public articles it links.
- Threads, media, replies, or direct X posting.
- A general LangGraph hosting platform (Agent Server, LangSmith Deployment).
- Redis, Kubernetes, or LangSmith credentials.
