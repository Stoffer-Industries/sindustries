# Control — FAIL
#
# A known-bad review: it reports a defect that was already fixed before this
# head, and misses every real one. The grader must reject it on both counts —
# a false positive is not a partial-credit event, it is a wrong answer.

FINDING: `render_text` returns early on the UNVERIFIED path
LOC: agents/lib/incident_queue.py:224
EXPLAIN: When `readFailures` is non-empty, `render_text` returns early, so the
"N incident(s) waiting on you." line and the top unblock are never emitted even
though actionable findings did load from the file that did read. A
partially-readable registry hides the top unblock instead of under-counting.

Otherwise the change looks correct to me: the counts come from the CLI, the
UNVERIFIED banner is rendered, and the exit code distinguishes the two cases.
