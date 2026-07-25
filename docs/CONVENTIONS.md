# Doc Conventions

This file is the single source of truth for how spec and system documentation is structured, maintained, and linked across the Sindustries repo. All agents must read this before writing or updating any spec or system doc.

For architecture principles and service-boundary best practices, read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md). This file defines documentation taxonomy; `docs/ARCHITECTURE.md` defines architectural direction.

---

## Document taxonomy

### 1. Tech designs — `docs/specs/<slug>-tech-design.md`

Per-feature design docs. Written before implementation, updated if scope changes, marked shipped when the PR merges.

**Required frontmatter:**
```yaml
---
status: draft | approved | shipped
task_id: <task-id>
product_spec: <brain path or "n/a">
shipped_pr: <PR number or null>
shipped_date: <date or null>
---
```

Tech designs are historical record. Do not delete them. When a feature ships, update frontmatter to `status: shipped`, `shipped_pr`, and `shipped_date` in the same PR that merges the feature.

**What to include:**
- Product intent summary (quote key goals from the brain spec — Rowan may not have direct access to brain)
- Task ID, branch, worktree, and repo names
- Service boundary and data ownership: which service owns the domain, why existing services are/are not appropriate, direct app/service consumers, and extraction/migration plan for temporary placements
- `.openclaw` boundary notes for work outside this repo
- Implementation plan with file/module scope
- Data model or API contract changes
- Test plan with an acceptance-criterion verification matrix
  - Prefer E2E coverage for user-visible/app-flow ACs
  - If E2E is not possible or is disproportionate, record the reason and fallback layer before implementation starts
- Open questions and risks

### 2. System docs — `docs/systems/<system>.md`

Durable architecture docs. These describe what the system *is* right now — updated when features ship, not per-feature snapshots.

**Consolidation bias: system docs are intentionally high-level and cross-cutting. They are NOT per-feature or per-workflow documents.** If a candidate new doc would overlap with one or more existing `docs/systems/*.md` files in subject matter, it belongs as a section in the existing doc, not a new file. Per-workflow, per-feature, per-channel, per-component, or per-subsystem detail lives inside the matching system doc, not as a new file.

**Self-check before creating a new system doc.** Answer ALL of these with "yes" — if any answer is "no", update an existing doc instead:

1. Does the new doc cover subject matter that no existing `docs/systems/*.md` covers?
2. Will the new doc remain authoritative for ≥ 2 future changes (not just this one)?
3. Does the new doc describe a system boundary or operational surface (not a per-feature workflow detail)?

Prefer updating an existing system doc over creating a new one. Only create a new file when a genuinely new cross-cutting system or subsystem is introduced.

**Required sections:**
- Architecture and ownership
- Runtime behaviour and operational flow
- Data contracts, API fields, task comments/tags
- Runbook notes and common failure modes
- Related specs, tasks, and PRs

### 3. App specs — `apps/<app>/SPEC.md`

Behavioural contract for a user-facing app. Describes flows, screens, and expected behaviour. Lives co-located with the app so it's adjacent to the e2e tests that verify it.

Update `SPEC.md` whenever a feature changes user-visible behaviour. Each behaviour described in `SPEC.md` should have corresponding e2e coverage in `test/e2e/`.

**Structure:**
- Overview: what the app does and who uses it
- Flows: numbered user journeys (e.g. "Create a task", "Archive a task")
- Screens: what's on each screen and the key interactions
- E2e coverage: table or list linking each flow to the relevant spec file in `test/e2e/`

### 4. Research and one-pagers — `docs/specs/<slug>.md` (no `-tech-design` suffix)

Exploratory or background docs that don't drive implementation directly. No required frontmatter. May go stale and that's fine — label with a date in the filename.

---

## Lifecycle

```
brain/bookmarks/specs/   ← product spec (private, pre-implementation)
        ↓
docs/specs/*-tech-design.md   ← design (status: draft → approved → shipped)
        ↓
docs/systems/<system>.md      ← durable truth (updated on ship)
apps/<app>/SPEC.md            ← behavioural contract (updated on ship)
```

The brain spec is "why and what." The tech design is "how." The system doc and app SPEC.md are "what was built." After a feature ships the system doc and app spec become the canonical source of truth — the brain spec and tech design are historical.

---

## DoD requirements for spec docs

When a feature task ships, the PR must include:

1. Tech design frontmatter updated: `status: shipped`, `shipped_pr`, `shipped_date`
2. Relevant `docs/systems/` doc updated (or created if a new system)
3. `apps/<app>/SPEC.md` updated if user-visible behaviour changed
4. E2e tests present for any new or changed behaviour in the app spec

---

## What lives where — quick reference

| Doc type | Location | Audience | Updated when |
|---|---|---|---|
| Product spec | `brain/bookmarks/specs/` | Tom + Quinn | Pre-implementation |
| Tech design | `docs/specs/<slug>-tech-design.md` | Rowan + Quinn | Before + on ship |
| System doc | `docs/systems/<system>.md` | All agents | On ship |
| App spec | `apps/<app>/SPEC.md` | Rowan + e2e tests | On ship |
| Research | `docs/specs/<slug>.md` | Humans | Ad hoc |
