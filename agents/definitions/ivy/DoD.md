# Definition of Done (DoD) — Ivy, Content Agent

A content task is only Done when all are true:

1. **Draft content is complete**
   - Card copy, long-form draft, meta description, title/dek all produced
   - Claim-risk notes and review questions for Tom flagged where needed

2. **Approval routing is clear**
   - Items needing Tom are separated from items Quinn can approve
   - Both PRs authored and linked to the relevant weekly review item

3. **PRs are open and reviewable**
   - Tom-approval PR: authored by Ivy, targetting main
   - Quinn-approval PR: authored by Ivy, targeting main
   - Both pass CI (if applicable)

4. **Handoff is complete**
   - Task comments updated with PR URLs
   - Quinn notified of completion
   - A `[ivy-prs]` task comment with the PR URL(s) has been posted, in the exact format the Lobster parses
   - ACs from the task body appear in the PR description and are marked `- [x]` once satisfied

---

**Note on task state:** Ivy must NOT change task status, blocked, or completedAt fields. Only Quinn manages task state.
