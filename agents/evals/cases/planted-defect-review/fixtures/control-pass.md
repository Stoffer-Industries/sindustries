# Control — PASS
#
# A hand-written known-good answer. It names every planted defect in the
# fixture, so the grader has a positive control to prove it can tell a
# finding from a non-finding. A grader that cannot separate this from
# `control-fail.md` is not measuring the model; it is measuring nothing.

FINDING: `TaskComment` is missing `#[serde(rename_all = "camelCase")]`
LOC: qa_verdicts.rs:19-25
EXPLAIN: The Tasks API sends `createdAt`, but without the camelCase rename serde
looks for `created_at`, so the field is always `None` on a real payload. The
`Option` default swallows the mismatch, `verdict_is_stale` filters on
`created_at.clone().max()`, every comment is dropped, and the function
always returns `false`. A stale verdict is therefore never detected in
production. The unit test passes because it constructs the struct in Rust
instead of deserialising it.
FIX: Add `#[serde(rename_all = "camelCase")]` to `TaskComment`, and add a
test that deserialises a captured API payload rather than a literal.

FINDING: `qa_agent_deferred` misreads a clean verification as a deferral
LOC: qa_verdicts.rs:41-44
EXPLAIN: The guard checks `lowered.contains("deferred")` but then negates with
`!note.contains("no deferred")` against the *original-case* note, and only
for that one literal phrase. The standard clean-verification sentence is
"No blocked or deferred ACs.", which contains "deferred" but does not contain
the literal "no deferred" — so a clean pass is classified as a deferral. The
bundled test `clean_verification_is_not_a_deferral` therefore fails as
written.
FIX: Run the negation against the lowercased text and scope the negation to
the clause rather than matching one literal phrase.

FINDING: `parse_evidence` mis-parses nested parentheses in a test id
LOC: qa_verdicts.rs:27-35
EXPLAIN: The capture group `([^)]+)` stops at the first `)`, so an evidence
annotation whose test id contains a nested parenthetical is truncated at the
inner bracket. A real test id such as `real client header set (no Bearer, no
cookie)` comes back as `real client header set (no Bearer, no cookie` — the
detail is cut mid-value, and the trailing text after the inner bracket
survives outside the annotation, which also breaks the AC-text comparison.
FIX: Allow one level of nested parentheses in the capture group, and anchor
the annotation to the end of the line.
