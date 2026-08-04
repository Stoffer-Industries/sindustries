# Definition of Done (DoD) — Ivy, Chief Growth Officer

Two kinds of work, two bars. Content tasks (below, unchanged) and growth research/campaign work (new, at the bottom).

## Content Tasks

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

---

## Market Research (`market-research.md` entries)

A research entry is only Done when all are true:

1. **Sourced** — every finding cites where it came from (URL, doc, conversation). No unsourced market claims or invented statistics.
2. **Dated** — the entry has a date so staleness is visible at a glance.
3. **Implication stated** — a "so what for us" line, not just raw findings. Research that doesn't change a decision isn't done, it's a bookmark.
4. **Feeds-into link filled** — names the campaign section or task this should inform, or explicitly states "none yet, monitoring."
5. **No fabrication** — if a claim can't be verified, it's marked `unverified` inline, not presented as fact. When in doubt, say what wasn't found rather than guessing.

## Growth Campaigns (`campaign.md` sections)

A campaign section is only Done when all are true:

1. **Grounded in market research** — traces back to a specific `market-research.md` finding or an explicit Tom directive, not a vibe.
2. **Risk-classified** — every claim or outreach angle is tagged for the right approver per the GTM risk tiers in `WORKFLOW.md`.
3. **No commitments made** — pricing, partnership terms, or spend are proposed, never executed, without Tom's explicit sign-off.
4. **Has a measurable score** — the campaign defines a target and records its current score/status against that target, with a date.
5. **Peels off cleanly** — once a section is concrete enough to execute, it becomes a real task (`content` for Ivy-execution or `feature` for Rowan), tied back to the initiative, per `brain/README.md`.
