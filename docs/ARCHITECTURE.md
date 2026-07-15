# Architecture Principles

This document is the repo-level home for Sindustries architecture principles and best practices. It applies to humans and agents. System docs in `docs/systems/` describe shipped systems; tech designs in `docs/specs/` describe proposed changes. When a tech design makes an architecture decision, check it against this file first.

## Service boundaries

Sindustries is a micro-service-oriented monorepo:

- `apps/` are clients and user-facing surfaces.
- `services/` own backend domains, APIs, workers, integrations, and persistence.
- `packages/` hold shared libraries, UI, types, config, and utilities.
- `infra/` wires runtime/deployment concerns.

A service owns a domain, not a frontend tab. Mission Control is a multi-service client: adding a Mission Control screen does not imply adding routes or tables to an existing service.

### Domain ownership rule

Before adding an API route, database model/table, migration, queue, cron, worker, or external integration, identify the owning domain and service.

Use an existing service only when the new state or behavior is part of that service's domain. Otherwise, create or extend the appropriate domain service.

### `tasks-api` boundary

`services/tasks-api` owns task/workflow state only:

- tasks
- task comments
- tags
- task dependencies
- task lifecycle metadata
- workflow metadata/comments consumed by agents and lobsters

It must not become the default backend for Mission Control or other apps. Product domains such as content scheduling/publishing, bookmarks, finance, analytics, agent incidents, or website content operations need their own service boundary unless Tom explicitly approves an exception.

### Required service-boundary questions

Every non-trivial tech design or PR that changes backend ownership must answer:

1. Which service owns this domain and why?
2. What data does the service own?
3. Which apps/services consume this API directly?
4. Why is this not being added to an existing service?
5. If the placement is temporary, what is the extraction/migration plan?
6. What runtime config, ports, credentials, or `.openclaw` changes are required?

## App-to-service communication

Apps may call multiple services directly when they render multiple domains. Prefer explicit app-to-domain-service clients over a catch-all app backend or accidental aggregation through `tasks-api`.

Add an aggregation/orchestration service only when the aggregation itself is a domain with durable behavior, not just because a frontend needs data from more than one place.

## Persistence and migrations

A service that owns a domain owns that domain's schema and migrations. Do not add tables to another service's Prisma schema for convenience.

If a service split or data move is needed:

- preserve existing data until the destination is verified;
- document the backfill/cutover/rollback path;
- verify row counts and representative records before removing old ownership;
- avoid coupling rollback to destructive drops.

## Technology choices

Default to the repo's existing stack unless there is a clear reason not to. New languages/runtimes add operational and review cost, so the tech design must justify them.

### TypeScript / JavaScript

Use TypeScript/JavaScript for:

- user-facing apps in `apps/`;
- backend product APIs in `services/` unless a different runtime is explicitly justified;
- shared packages, UI, domain types, and config in `packages/`;
- code that benefits from sharing types and validation with frontend clients.

This is the default product-surface choice because most of the repo, test tooling, and app/service conventions already live here.

### Python

Use Python for:

- agent workflow glue and operational automation;
- scripts that primarily orchestrate files, subprocesses, HTTP calls, or LLM/tooling workflows;
- quick data migration/backfill helpers where the logic is small, auditable, and one-shot;
- research/prototype code that is not on a product request path.

Do not let Python scripts become hidden product services. If Python starts owning durable APIs, long-running workers, or core domain state, promote the boundary into an explicit service design first.

### Rust

Use Rust for:

- durable workflow engines, validators, and state-machine-heavy automation where correctness and explicit types matter;
- CLIs or workers where a single static binary, predictable performance, or stronger compile-time guarantees are valuable;
- code that benefits from making invalid states hard to represent.

Do not choose Rust just because code is important. Prefer it when the problem is correctness-sensitive, concurrent, performance-sensitive, or a stable tool/engine that will be maintained for a while. Small glue scripts should usually stay Python; product APIs should usually stay TypeScript unless there is a documented reason.

### Language decision rule

A tech design that introduces a new runtime for a domain must state:

1. why the existing TypeScript/Python/Rust precedent is insufficient;
2. who will maintain and review it;
3. how it is built, tested, deployed, and observed;
4. what API/data boundary keeps it from leaking into unrelated domains.

## Documentation expectations

- Architecture principles and best practices: `docs/ARCHITECTURE.md`.
- Durable shipped-system behavior: `docs/systems/<system>.md`.
- Proposed implementation decisions: `docs/specs/<slug>-tech-design.md`.
- User-facing app behavior: `apps/<app>/SPEC.md`.

When architecture principles change, update this file. When a system changes, update the relevant `docs/systems/` file. Agent-local workflow docs may reference these rules, but should not be the only source of truth.
