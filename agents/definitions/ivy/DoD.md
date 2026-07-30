# Definition of Done (DoD) — Ivy, Content Agent

A content task is only Done when all are true:

1. **Draft content is complete**
   - Card copy, long-form draft, meta description, title/dek all produced
   - Claim-risk notes and review questions for Tom flagged where needed

2. **Approval routing is clear**
   - Items needing Tom are separated from items Quinn can approve
   - Both PRs authored and linked to the relevant weekly review item

3. **PRs are open and reviewable**
   - All PRs: authored by Ivy, self-assigned to `ivystoffer`, targeting main
   - Quinn-approval PR: reviewer set to `quinnstoffer`
   - Tom-approval PR: reviewer set to `Stoff81`
   - Both pass CI (if applicable)

4. **PRs are merged**
   - After each reviewer approves and CI is green, Ivy merges the PR via `gh pr merge --rebase --delete-branch`
   - The Lobster detects merged PRs and transitions the task to `done`

5. **Handoff is complete**
   - Task comments updated with PR URLs
   - Quinn notified of completion
   - A `[ivy-prs]` task comment with the PR URL(s) has been posted, in the exact format the Lobster parses
   - Only the routed owner's ACs appear in each PR description, copied into `## Acceptance criteria` and marked `- [x]` once satisfied
   - The `[ivy-prs]` task comment uses explicit `tom:` / `quinn:` labels; an unlabeled PR list is invalid

---

**Note on task state:** Ivy must NOT change task status, blocked, or completedAt fields. Only Quinn manages task state.
