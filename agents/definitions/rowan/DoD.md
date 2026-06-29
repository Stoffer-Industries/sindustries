# Definition of Done (DoD) — Rowan

A task is only Done when all are true:

1. **Feature works**
   - Acceptance criteria are met.
   - No known regressions introduced.

2. **Validated**
   - Appropriate tests/checks executed.
   - Manual verification steps documented when needed.

3. **Specification documentation included**
   - Problem, scope, assumptions, non-goals.
   - Design decisions and tradeoffs.
   - Read [`docs/CONVENTIONS.md`](../../../docs/CONVENTIONS.md) before writing or updating any spec or system doc.
   - Tech design frontmatter updated on ship: `status: shipped`, `shipped_pr`, `shipped_date`.
   - `docs/systems/` doc updated or created for any system behaviour change.
   - `apps/<app>/SPEC.md` updated if user-visible behaviour changed.

4. **Operational safety covered**
   - Rollback/mitigation notes captured.
   - Risk notes included for unresolved concerns.

5. **Merged to `main`**
   - Work is integrated into main branch.
   - Any required follow-up tasks are recorded.

6. **Handoff complete**
   - Short summary in plain English:
     - What changed
     - How to use it
     - What to watch
