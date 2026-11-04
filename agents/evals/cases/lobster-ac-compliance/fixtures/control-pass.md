## Acceptance Criteria

- [x] AC1: Prospect list is ordered by fit score descending, and the top N can be selected without re-running the pipeline. (🧪 testID: test_validate_prospect_artifact - ordering)
- [x] AC2: Each retained prospect cites the public source URL it was extracted from, and the shortlist names the signal that justified including it. (🧪 testID: test_validate_prospect_artifact - source citation)
- [x] AC3: Each prospect carries a fit, a timing, and a reachability score, and each score has a one-line reason. (🧪 testID: test_validate_prospect_artifact - score reasons)
- [x] AC4: When public-signal coverage for a category is thin, the shortlist says so explicitly rather than presenting a confident-looking list. (🧪 testID: test_validate_prospect_artifact - coverage warning)
- [x] AC5: The durable shortlist artifact format is documented in `docs/systems/prospect-finder-artifact.md`. (📄 not code: documented in docs/systems/prospect-finder-artifact.md)
