# Control — FAIL
#
# A plausible-looking PR body that the lobster will reject. Every AC line has
# a plausible shape, but the label form, the text and the evidence are all
# wrong in ways a careful author actually gets wrong.
#
# The grader must reject it. A grader that accepted this would be reporting
# every model as excellent.

## Acceptance Criteria

- [x] **AC1:** Prospect list is ordered by fit score descending, and the top N can be selected without re-running the pipeline. (file: agents/skills/growth/prospect-finder/scoring.py)
- [ ] AC2: Each retained prospect cites the public source URL it was extracted from, and the shortlist names the signal that justified including it.
- [x] AC3: Each prospect carries a fit, a timing, and a reachability score, and each score has a one-line reason. (testID: prospect-finder > scores)
- [x] AC4: When public-signal coverage for a category is thin, the shortlist says so explicitly rather than presenting a confident-looking list. (🧪 testID: prospect-finder > thin coverage)
- [x] AC5: The durable shortlist artifact format is documented in `docs/systems/prospect-finder-artifact.md`. (not tested)
