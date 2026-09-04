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

It must not become the default backend for Mission Control or other apps. Product domains such as content scheduling/publishing, bookmarks, budget/finance, analytics, agent incidents, or website content operations need their own service boundary unless Tom explicitly approves an exception.

### Existing domain service examples

- `services/tasks-api` owns task/workflow state.
- `services/budget-api` owns budget/finance data and Akahu integration boundaries.

New work should extend the matching domain service when one exists, or create a new domain service when it does not. Do not route unrelated domains through `tasks-api` for convenience.

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

## Identity, product membership, and tenant isolation

Sindustries products should share one canonical identity plane rather than each product implementing its own user directory, password lifecycle, and social-login integration. Each product remains a separate OAuth client with its own redirect URLs, scopes, session policy, and revocation boundary.

This is an architectural direction for future work, not a description of a shipped identity system. Until a shared identity plane exists, tech designs must call out any temporary app-owned authentication and its migration path.

### Separate identity from access

Treat these as distinct concepts:

1. **Identity** — one human has one stable Sindustries identity, represented across services by an immutable issuer-and-subject pair. Email is an attribute and login identifier, not a durable cross-product key.
2. **Product membership** — the identity has joined a product such as GymTrack, Budget, or Roadmap and may have an app-specific profile or onboarding state.
3. **Organisation membership** — the identity belongs to a Roadmap or other enterprise tenant with an explicit role and permissions.

Signing up for a second product should create a product membership, not a duplicate identity. Product UX should say "Continue with your Sindustries account" and then "Set up <product>" or "Join <organisation>" rather than exposing an identity-provider error such as "user already exists."

Account linking must require proof of control. Do not silently merge identities using an unverified matching email address. Password, social-login, passkey, and enterprise-federation credentials may all resolve to the same identity only through a verified or explicitly authenticated linking flow.

### Shared identity, independent product data

A shared identity provider does not imply a shared application database:

- GymTrack may keep workout data in Supabase and use the canonical identity subject in its RLS policies.
- Budget may keep finance data in Neon and verify tokens from the same identity issuer in `budget-api`.
- Future products may use other stores while retaining the same identity contract.

Product databases should store the external identity as an immutable subject, ideally with its issuer when more than one trusted issuer is possible. Do not create cross-database foreign keys to another product's user table. A local product-user/profile row may be created on first authenticated use and keyed uniquely by the external subject.

Shared code should be limited to identity contracts, token verification, client configuration, and test helpers. Do not build a bespoke password or OAuth server inside a product service.

### Shared account is not automatically shared session

Using one identity provider gives users one account, but separate browser origins do not automatically share a login session. Deliver this incrementally:

1. **Shared identity:** every product accepts the same account, although a user may authenticate separately in each product.
2. **Cross-product SSO:** introduce a central first-party login domain or broker when seamless sessions across Sindustries products are justified.

Tech designs must state which level they implement and must not imply SSO merely because the issuer is shared.

### Marketing identity and consent

Marketing systems such as Klaviyo are consumers of identity and product events, not identity providers or application databases.

- Use the immutable Sindustries identity subject as the marketing profile's external identifier where supported.
- Keep marketing consent separate from account creation and product terms. Creating an account never implies marketing consent.
- Record channel, purpose, source, consent version, and timestamp; preserve enough first-party audit state to reconcile failed synchronisation and demonstrate how consent was obtained.
- Marketing unsubscribe or suppression must not disable authentication or required transactional messages such as verification, password reset, security, billing, or service notices.
- Product services should emit consent and lifecycle events through an owned integration boundary rather than embedding vendor-specific calls throughout app UI code.

### Enterprise tenant isolation

Enterprise products should model tenancy from their first multi-user schema even when all tenants initially share one database:

- Every tenant-owned aggregate must resolve unambiguously to an `organisation_id`.
- Access requires both an authenticated identity and an active organisation membership with the required role.
- Tenant context must come from verified membership, not an untrusted request field alone.
- PostgreSQL row-level security should enforce tenant isolation as defence in depth where practical; application query filters alone are insufficient for sensitive multi-tenant data.
- Automated tests must attempt cross-tenant reads and writes and prove that both fail.
- Caches, object storage paths, queues, logs, exports, search indexes, analytics, and background jobs must carry and enforce tenant context too; database RLS does not protect those surfaces.

Use a tenant directory or equivalent routing abstraction so storage placement is not hard-coded into product identity or URLs:

```text
organisation_123 -> shared cluster
organisation_456 -> dedicated database
organisation_789 -> dedicated regional deployment
```

The default may be a shared schema with `organisation_id` plus RLS. Larger, regulated, region-bound, or customer-hosted tenants may later move to dedicated databases or deployments without changing their Sindustries identity or organisation ID. If customers federate their own identity provider, map their OIDC/SAML subject to an internal immutable identity and organisation membership rather than using email as the join key.

### Converge through feature work

Treat this direction as an incremental design constraint, not a future migration project. Every relevant feature should leave its part of the product closer to the target model while delivering its immediate user value.

Prefer the smallest proportionate step that creates the intended seam now: use an immutable external identity subject instead of email, distinguish product membership from identity, add `organisation_id` when tenant-owned data is first introduced, centralise token verification behind a shared contract, or isolate a marketing integration behind an owned boundary. The feature does not need to build the whole identity platform, but it should avoid introducing app-specific assumptions that a later project must unwind.

Temporary compatibility work is acceptable when required for delivery, but its target contract and removal path must be explicit. Do not defer foundational identifiers, ownership boundaries, or tenant keys on the assumption that a separate migration will add them later; those migrations become riskier once real users and data exist.

### Required identity and tenancy questions

A tech design that adds signup, login, user records, marketing subscriptions, organisation membership, or tenant-owned data must answer:

1. What concrete, proportionate step can this feature take toward the target identity and tenancy model, and what future migration does that avoid?
2. Is this creating an identity, a product membership, or an organisation membership?
3. What immutable issuer/subject identifies the person, and how can credentials be linked safely?
4. Is the product a distinct OAuth client, and which redirects, scopes, and session boundaries does it own?
5. Where is app-specific user data stored, and how is it separated from identity-provider state?
6. Does account creation request marketing consent? If so, how are purpose, evidence, unsubscribe, and sync failure handled independently?
7. What supplies trusted tenant context, and which database and non-database surfaces enforce it?
8. Can the tenant later move from shared to dedicated or regional storage without changing identity or public contracts?
9. Is the implementation shared identity only, or does it genuinely provide cross-product SSO?

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

## Deployment platform fit

Choose the hosting platform from the workload outward, not from the
platform already used by a neighbouring service. Before selecting a
deployment target, classify the workload and record:

1. whether it is a static SPA, request-serving API, background worker, MCP
   server, or another long-running/container workload;
2. its runtime needs, private-network requirements, durable state, and
   operational dependencies;
3. which candidate platforms have native fit and what operational surface each
   adds;
4. why generic compute is justified if a more specialised platform fits;
5. how independent deploy and rollback boundaries are preserved; and
6. which alternatives were rejected, including the portability or exit path.

Shared product surfaces do not require a shared hosting platform. In
particular, independent frontends should remain independently deployable even
when one shell embeds another app.

### Current platform defaults

| Workload | Default platform | Rationale |
| --- | --- | --- |
| Static Vite SPA | Vercel | Native static builds, preview deployments, and simple per-project rollback without running a container. |
| Request-serving API | Fly.io | Container/process control, regional placement, health checks, and a portable Docker boundary. |
| Background worker | Fly.io | Long-running process supervision and explicit worker isolation. |
| MCP server or other long-running/container workload | Fly.io | Runtime and networking control are more important than static-hosting convenience. |

Mission Control and the Tasks app are separate Vite SPAs and should therefore
be separate Vercel projects, preserving their independent deploy and rollback
boundaries. Their APIs, workers, MCP servers, and other long-running
container workloads remain on Fly.io. This is a workload-fit decision, not a
requirement that all Sindustries surfaces share one provider. The existing
Fly-based staging deployment is a separate migration concern; changing the
recommendation here does not silently change live infrastructure.

When a workload is intentionally placed on a less-native platform, the tech
design or deployment record must explain the trade-off and retain a portable
boundary where practical (for example, a Dockerfile for a service that runs
on Fly.io).

## Work classification

Use the lightest workflow that preserves traceability and safety:

- Code garden: behavior-preserving cleanup only.
- Code tasks: fixes, hardening, migrations, refactors, and architecture corrections with no new product capability.
- Feature tasks: new user/product capability or product behavior requiring scope approval.
- Research tasks: investigation before an implementation path is known.

Repo audit findings that are important but not code-garden-safe should become tracked tasks rather than staying indefinitely skipped.

## Documentation expectations

- Architecture principles and best practices: `docs/ARCHITECTURE.md`.
- Durable shipped-system behavior: `docs/systems/<system>.md`.
- Proposed implementation decisions: `docs/specs/<slug>-tech-design.md`.
- User-facing app behavior: `apps/<app>/SPEC.md`.

When architecture principles change, update this file. When a system changes, update the relevant `docs/systems/` file. Agent-local workflow docs may reference these rules, but should not be the only source of truth.
