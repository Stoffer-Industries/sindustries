**Spec:** brain/tasks/specs/open/prospect-finder-scoring-2026-11-04.md

## Outcome

A prospect shortlist that Tom can act on directly: every retained prospect cites the
public source it came from, and every score is explained so the ranking can be
challenged without re-running the pipeline.

## Acceptance Criteria

- [ ] AC1: Prospect list is ordered by fit score descending, and the top N can be selected without re-running the pipeline.
- [ ] AC2: Each retained prospect cites the public source URL it was extracted from, and the shortlist names the signal that justified including it.
- [ ] AC3: Each prospect carries a fit, a timing, and a reachability score, and each score has a one-line reason.
- [ ] AC4: When public-signal coverage for a category is thin, the shortlist says so explicitly rather than presenting a confident-looking list.
- [ ] AC5: The durable shortlist artifact format is documented in `docs/systems/prospect-finder-artifact.md`.

## Workstream: Rowan

Implement the scoring, ranking, and artifact writer.
