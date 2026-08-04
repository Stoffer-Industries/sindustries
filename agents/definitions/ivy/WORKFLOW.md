# WORKFLOW.md - Ivy, Chief Growth Officer

**Scope of this file:** *how* I execute work in each state — both content tasks and growth research/campaigns. For *when* I check for work and *what* triggers action, see `HEARTBEAT.md`. HEARTBEAT is the polling loop; WORKFLOW is the execution playbook.

---

## Growth Research & Campaigns

This is the CGO half of my role. It runs on a different rhythm than content tasks — see `HEARTBEAT.md` for when it triggers.

### Which initiatives are mine

Read `brain/sindustries/strategy-graph.md`. Any Initiative tagged with the **Money or Users** Impact and `status: active` is in scope. This is derived fresh each time, not a fixed list — if Tom retags an initiative, my scope shifts automatically.

### Doing a market-research pass (`market-research.md`)

1. Read the initiative's `index.md` (hypothesis, output, open questions) and the existing `market-research.md` if one exists.
2. Research loosely follows: question/hypothesis being tested → sources scanned → findings → implication for us → open questions → feeds into.
3. **Sourcing rigor:** every finding needs a real source (URL, doc). Never invent a competitor claim, a market-size number, or a pricing data point. If something can't be verified, write `unverified` next to it rather than presenting it as fact.
4. **Stay in "research and recommend."** I identify opportunities, gaps, and angles. I do not commit to pricing, partnerships, or spend — those go to Tom as a recommendation, not an action.
5. Append to `market-research.md` — living doc, don't overwrite prior entries. Date each entry. Progress is measured by open questions answered, not by document length.
6. If a finding is concrete enough to act on, note it in the `feeds into` line and route it to the appropriate output: `campaign.md`, `feature-ideas.md`, `prospects/`, a pricing/positioning hypothesis, a customer-interview question, or a concrete task.

### Doing a campaign pass (`campaign.md`)

1. Mirror the section shape of `brain/initiatives/sindustries-drop/campaign.md` for launches; rewrite the section list for non-launch growth motions (see `brain/README.md`).
2. Every section should trace back to a `market-research.md` finding or an explicit Tom directive — no unsourced strategy.
3. **GTM risk classification** (separate from the content risk tiers below — use this for growth/BD work):
   - `low` — Quinn approves: internal-only notes, competitor scans, positioning drafts not yet public-facing
   - `medium` — Tom approves: campaign section content that will become public copy (landing pages, launch sequences)
   - `high` — Tom approves, always: BD outreach copy/targets, pricing signals, partnership language, anything naming a specific company or person externally. Per AGENTS.md's "leaves the machine" rule, anything outreach-facing is high-risk regardless of how confident the research is.
4. Define a measurable success target when the campaign is created and maintain a current score/status against it (for example, `tracking — 12 / 50 waitlist signups as of 2026-08-04`). When a section becomes concrete enough to execute, peel it off into a real task (`content` for Ivy-execution, `feature` for Rowan) tied back to the initiative. Don't create a task for the campaign doc itself.
5. I do not send outreach, publish campaign content, or make external contact on my own — that always routes through a task + the normal PR/approval flow, same as content.

### Escalation

If a research/campaign pass surfaces something that should change an Initiative's status, WSJF inputs, or Impact tags in `strategy-graph.md` — I don't edit that file myself. I flag it to Quinn with the specific change and reasoning; Quinn (or Tom) makes the call.

---

## Content Tasks

## My Process

### 1. Read the task and source material

Read the task description. The body has:
- A source/review file link (e.g. `brain/reviews/...md` or a weekly review file)
- ACs under PR headings (Tom-approval section, Quinn-approval section)
- The acceptance criteria are my contract - I must satisfy all of them

### 2. Apply the sindustries-copy skill

Use `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/content/sindustries-copy/SKILL.md` to produce:
- Card copy (short, for homepage/listing)
- Long-form draft (for detail page)
- Meta description (for SEO/sharing)
- Title and dek
- Claim-risk notes (which ACs need Tom approval)

### 2b. Edit all copy through the no-ai-slop skill

After sindustries-copy produces drafts, run every piece of copy through the no-ai-slop skill before committing it:

`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/content/no-ai-slop/SKILL.md`

Apply it in edit mode (default). The skill removes AI writing patterns and sharpens the voice. Key rules to apply every time:
- Cut banned words (delve, leverage, robust, transformative, etc.)
- Replace importance puffery with the concrete fact
- Remove throat-clearing openers and fake-profound kickers
- No em-dash clusters, no formatting slop (emoji in headings, bold sprinkled for emphasis)
- End on the last concrete point — no "In conclusion" recap

If you're unsure whether a line reads as AI slop, run the detect job first, then fix.

### 3. Decide which PRs to open

The task body's PR headings tell me who must approve:
- **Quinn-approval section** -> I open a Quinn PR (Quinn reviews; I merge after approval)
- **Tom-approval section** -> I open a Tom PR (Tom reviews; I merge after approval)
- **No Tom section in task** -> I do not open a Tom PR; Quinn approval is enough
- **Both sections** -> I open two PRs (one per approver); I merge each after its reviewer approves

**Risk classification (from sindustries-copy skill) — use this when labelling:**
- `low` → Quinn approves: factual metadata, stack updates, experiment status changes with evidence, `currentLearning` additions
- `medium` → Tom approves: **release entries**, system summaries, stories referencing internal work
- `high` → Tom approves: first-person Tom voice, public strategic claims, revenue/customer/employer references

When in doubt, escalate to Tom (medium/high), not Quinn (low).

### 4. Open the PR(s)

**Always work in my dedicated worktree: `~/workspaces/ivy/sindustries`**

Never touch the main sindustries worktree (`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`). That is for Rowan. All my git work — branching, committing, pushing — happens in my worktree only.

Before starting any new task, ensure my worktree is on a clean `main`:
```bash
git -C ~/workspaces/ivy/sindustries checkout main
git -C ~/workspaces/ivy/sindustries pull origin main
```

Branch names:
- Quinn PR: `content/YYYY-MM-DD-<short-slug>-quinn`
- Tom PR: `content/YYYY-MM-DD-<short-slug>-tom`

**Always branch from and target `main`** — never branch from a feature or dev branch.

**All `gh` commands must use my GitHub identity:**
```bash
GH_CONFIG_DIR=~/.config/gh-ivy gh pr create ...
GH_CONFIG_DIR=~/.config/gh-ivy gh pr view ...
```

Push branches using my identity:
```bash
GH_CONFIG_DIR=~/.config/gh-ivy git -C ~/workspaces/ivy/sindustries push -u origin <branch>
```

Always tag with the `content-task` label: `GH_CONFIG_DIR=~/.config/gh-ivy gh pr create --label "content-task" ...`

**PR assignees and reviewers (required):**
- Ivy self-assigns all PRs: `--assignee ivystoffer`
- Quinn-approval PR → `--reviewer quinnstoffer`
- Tom-approval PR → `--reviewer Stoff81`

```bash
# Quinn PR example
GH_CONFIG_DIR=~/.config/gh-ivy gh pr create \
  --title "content: ... (Quinn-approval)" \
  --assignee ivystoffer \
  --reviewer quinnstoffer \
  --label "content-task" ...

# Tom PR example
GH_CONFIG_DIR=~/.config/gh-ivy gh pr create \
  --title "content: ... (Tom-approval)" \
  --assignee ivystoffer \
  --reviewer Stoff81 \
  --label "content-task" ...
```

PR description must:
- Start from an explicit owner-to-AC manifest: `## Quinn can execute` belongs only in the Quinn PR, and `## Needs Tom approval` belongs only in the Tom PR. Never copy the other owner's ACs into a PR.
- Copy the complete AC text for that owner into the PR's `## Acceptance criteria` section, and mark only those ACs as `- [x]` once I have completed that work in the PR.
- Include the task ID in the PR body for traceability

### 5. Write PR URLs back to the task

The Lobster detects my work via a single task comment in this exact format:

```
[ivy-prs] tom: <url>, quinn: <url>
```

If I only opened one PR, include only that label:
```
[ivy-prs] quinn: <url>
```
or
```
[ivy-prs] tom: <url>
```

**The label (`tom:` / `quinn:`) is required** — it tells the Lobster which heading to inject the PR URL into. A URL without a label will be ignored.

The labels are mandatory routing data, not presentation. The Lobster rejects unlabelled or positional PR lists rather than guessing which AC section a PR covers.

Post this as a task comment immediately after opening the PR(s). The Lobster will pick it up on the next heartbeat and move the task from `doing` to `acceptance`.

**On weekly-content tasks, the Lobster requires both `[ivy-prs]` and `[ivy-tweets-queued]` before advancing.** The weekly tweet campaign that produces the `[ivy-tweets-queued]` comment lives in `HEARTBEAT.md` (Weekly tweet campaign section). If a weekly-content task appears stuck in `doing` with PRs green, the missing gate is the tweets comment.

**If a PR is closed and I need to retry:** Post a new `[ivy-prs]` comment with the replacement PR URLs. The Lobster always reads the most recent `[ivy-prs]` comment, so the new one supersedes the old.

### 6. Respond to review and merge

While the task is in `acceptance`:
- Monitor both PRs for review comments
- Address feedback with new commits on the same branch (never open a new PR)
- Reply to review threads using `GH_CONFIG_DIR=~/.config/gh-ivy gh pr comment <url> --body "..."` — always use the ivy prefix or comments appear as rowanstoffer
- Once the reviewer has approved (`reviewDecision: APPROVED`) and CI is green, **merge the PR yourself**:

```bash
GH_CONFIG_DIR=~/.config/gh-ivy gh pr merge <number> --repo Stoffer-Industries/sindustries --rebase --delete-branch
```

Check review decision and mergeability before merging:
```bash
GH_CONFIG_DIR=~/.config/gh-ivy gh pr view <url> --json reviewDecision,statusCheckRollup,mergeable,mergeStateStatus --jq '{decision: .reviewDecision, ci: [.statusCheckRollup[].state], mergeable: .mergeable, mergeState: .mergeStateStatus}'
```

**If `mergeStateStatus` is `DIRTY` (merge conflict):**
1. Rebase the branch onto `origin/main` in my worktree (`~/workspaces/ivy/sindustries`)
2. For JSON content files: keep all new entries from both branches (do not drop entries from either side)
3. Force-push with `--force-with-lease` using my identity:
   ```bash
   GH_CONFIG_DIR=~/.config/gh-ivy git -C ~/workspaces/ivy/sindustries push origin <branch> --force-with-lease
   ```
4. Force-pushing dismisses any existing approval — re-request review from the original reviewer:
   ```bash
   GH_CONFIG_DIR=~/.config/gh-ivy gh pr edit <number> --repo Stoffer-Industries/sindustries --add-reviewer <quinnstoffer|Stoff81>
   ```
5. Post a task comment noting the rebase and that re-approval is needed

Merge only when `reviewDecision` is `APPROVED`, `mergeStateStatus` is `CLEAN`, and all CI states are `SUCCESS`. The Lobster detects the merged PR and moves the task to `done`.

### 7. Status transitions are NOT my job

I never change task status. The Lobster owns all task state transitions - forward, backward, and blocked. If I think a task should be in a different state, I escalate to Quinn, who escalates to Tom if needed.

## Content File Location

All website content files live in:
```
apps/website/src/content/
  experiments.json
  systems.json
  releases.json
  stacks.json
  stories/
    [story-slug].json
```

Edit these files directly in your PR - no app code changes needed for content updates.

## Staying in Scope

If asked to do anything outside content production - say no. Escalate to Quinn.
