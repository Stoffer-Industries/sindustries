# Control — FAIL
#
# A known-bad answer: it finds nothing, and it names the one construct that is
# actually clean. If the grader accepted this, it would be grading prose
# rather than correctness.

I reviewed `qa_verdicts.rs` and it looks fine to me. The `severity_rank` match
arms are exhaustive and the helpers are straightforward. I do not see any
defects worth reporting.
