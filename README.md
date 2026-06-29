# sindustries monorepo

Sindustries is organized as a monorepo with explicit boundaries between product surfaces, backend execution, shared code, and operations.

## Monorepo layout

- `apps/` — user-facing runnable applications (primarily front-end surfaces)
  - `apps/tasks/` — first product surface (initial focused app)
  - `apps/website/` — public-facing company website v1
  - `apps/mission-control/` — future aggregate shell/orchestrator UI
- `services/` — backend APIs, workers, and long-running service processes
- `packages/` — shared libraries, types, utilities, and cross-cutting configs
- `infra/` — infrastructure, environments, and deployment/runtime definitions
- `docs/` — current system references, build specs, design notes, and repo audits
  - `docs/systems/` — current system and workflow references
  - `docs/specs/` — build-against specs and older planning artifacts

## Direction

Current repo state is **early implementation**: documentation plus Milestone 1 backend foundation in `services/tasks-api`.

Planned product evolution:
1. Build and prove the focused `tasks` surface.
2. Evolve `mission-control` into the aggregate shell that hosts cross-app workflows (including `tasks`, collaboration, and future surfaces).
3. Keep domain boundaries strict so apps can ship independently while sharing stable packages/services.

## System references

- `docs/systems/agent-orchestration.md` — high-level map of agent workflows, heartbeat, content, tasks, and incident handling.
- `docs/systems/bookmark-workflow.md` — detailed bookmark pipeline state machine, scripts, curation, approval, and task creation.

## Local setup (dev + prodlike)

### Prerequisites
- macOS with Homebrew
- Node.js 22+

### One-time bootstrap
From repo root:

```bash
make bootstrap
```

This installs local tooling (`colima`, `docker` CLI, `tilt`, `node` if missing) and npm deps for current app/service packages.

### Local runtime modes

`make up`, `make down`, and `make reset-db` are mode-aware via `MODE=<dev|prodlike>`.

| | dev | prodlike |
| --- | --- | --- |
| Compose project | `sindustries-dev` | `sindustries-prodlike` |
| Postgres | `localhost:6432` | `localhost:7432` |
| API | `localhost:4000` | `localhost:4001` |
| App | `localhost:5173` | `localhost:5174` |
| Tilt port | `10350` | `10351` |
| Grafana | `localhost:3000` | `localhost:3001` |
| Prometheus | `localhost:9090` | `localhost:9091` |
| Tempo | `localhost:3200` | `localhost:3201` |
| OTLP (HTTP/gRPC) | `localhost:4318` / `4317` | `localhost:4328` / `4327` |

### `make up` parameters

| Parameter | Values | Default | Description |
| --- | --- | --- | --- |
| `MODE` | `dev`, `prodlike` | `dev` | Which stack to start (separate ports, DB, Compose project) |
| `OBSERVABILITY` | `0`, `1` | `1` | Enable the per-mode Grafana/Tempo/Prometheus/OTel Collector stack |

Examples:

```bash
make up                              # dev + observability
make up MODE=prodlike                # prodlike + observability
make up OBSERVABILITY=0              # dev, no observability containers
make up MODE=prodlike OBSERVABILITY=0
```

### Observability

Each mode gets its own isolated observability stack (`sindustries-dev-o11y`, `sindustries-prodlike-o11y`) with separate host ports so both can run simultaneously. See the port table above.

When observability is off (`OBSERVABILITY=0`), `up.sh` sets `OTEL_SDK_DISABLED=1` so the API doesn't spam export errors.

**Follow-ups:** Loki/Promtail for logs, `trace_id` in structured logs, `traceparent` from the tasks app for browser-linked traces.

### Start stacks

```bash
make up                    # dev
make up MODE=prodlike      # prodlike
```

Run both simultaneously from two terminals.

### Stop stacks

```bash
make down                  # dev
make down MODE=prodlike    # prodlike
```

### Reset DB (mode-aware)

Dev reset (includes seed by default):

```bash
make reset-db MODE=dev
```

Prod-like reset (no seed by default):

```bash
make reset-db MODE=prodlike
```

Optional overrides:

```bash
# Force seed prodlike once
SEED_DB=true make reset-db MODE=prodlike

# Skip seed in dev once
SEED_DB=false make reset-db MODE=dev
```

### Migrate only (with backup)

Apply checked-in Prisma migrations without resetting schemas:

```bash
make migrate-db MODE=dev
make migrate-db MODE=prodlike
```

This first creates a timestamped backup of the target database under `.db-backups/<mode>/` when the database already exists, then runs `prisma migrate deploy`.

For the known local drift case where the `blocked` / `ready` columns already exist but Prisma still has `20260308000000_add_blocked_ready_columns` marked unfinished, `make migrate-db` will auto-recover and continue.

Optional override:

```bash
BACKUP_ROOT=/path/to/backups make migrate-db MODE=prodlike
```

### Cron/automation targeting

Use explicit API base URLs:

- Dev: `http://localhost:4000/api/v1`
- Prod-like: `http://localhost:4001/api/v1`

### Runtime and data ownership guardrails

- Mode config source of truth: `scripts/dev/mode-env.sh`.
- Each mode uses an isolated Postgres database: `sindustries_dev` or `sindustries_prodlike`.
- Each service owns its schema and migrations. Current API ownership schema: `tasks_api`; reserved app-side schema boundary: `tasks_app`.
- Cross-service reads and writes must go through service APIs/contracts, not direct table access.
- `scripts/dev/*` are the operational source of truth; wrappers such as Make targets should call scripts rather than duplicate runtime logic.

### Run tests

```bash
make test
```

Or run individually:

```bash
make test-api
make test-app
make test-e2e
```

## Working method

For non-trivial work, use spec-first delivery:
- write/update a spec in `docs/specs/`, or a current system reference in `docs/systems/` when documenting live workflow behavior
- implement in small mergeable slices
- validate before merge
- document risks and mitigations

See `CONTRIBUTING.md` for the full Definition of Done. Have fun!
