---
name: pr-address-feedback
description: >
  Critically analyse PR feedback received on your own pull requests, determine validity,
  and fix code based on justified comments. Use when the user shares PR review comments,
  asks to evaluate reviewer feedback, wants to assess whether PR comments are valid,
  needs to address PR feedback, or asks "what do you think about these code comments".
  Triggers include "review comments", "PR feedback", "address feedback", "reviewer said",
  "code comments on my PR", "is this feedback valid", "fix based on review".
---

# PR Feedback Analysis & Resolution

Critically evaluate review feedback received on your own PRs. Not all feedback is correct — assess each comment on its technical merits before acting.

## Core principles

1. **Be sceptical, not defensive.** Evaluate on technical merits. Don't blindly accept or reject.
2. **Understand before acting.** Comprehend the concern and the surrounding code before deciding.
3. **Proportionality.** A valid concern with negligible real-world impact may not warrant a complex fix.
4. **Discuss before fixing when uncertain.** If validity is ambiguous, present your analysis first.

## Workflow

### 1. Gather the feedback

```bash
gh api repos/Stoffer-Industries/<repo>/pulls/<number>/comments \
  --jq '.[] | {id, path, line, body, user: .user.login}'
```

Separate inline comments from general PR-level comments.

### 2. Evaluate each comment

For each, ask:

- **Is the reviewer factually correct?** Examine the code in context. Trace call sites.
- **Is the concern theoretically valid but practically negligible?** Weigh fix cost vs severity.
- **Is this a style preference or a genuine improvement?** Style comments should generally be respected if they match codebase conventions.
- **Does the suggested fix introduce its own complexity?** Sometimes the reviewer identifies a real problem but suggests the wrong solution.

### 3. Classify and decide

- **Will fix** — the feedback is correct. Make the change.
- **Won't fix** — technically correct but impact is negligible or fix adds disproportionate complexity. Reply briefly explaining why.
- **Partially valid** — the concern has merit but the suggested approach is wrong or incomplete. Propose alternative, then fix.
- **Invalid** — based on a misunderstanding. Reply clearly and respectfully why.
- **Needs discussion** — ambiguous. Present trade-offs to the user before acting.

### 4. Implement fixes (for "will fix" items)

1. **Fix the actual issue**, not just what the reviewer literally suggested.
2. **Add or update tests** for any logic change.
3. **Keep changes minimal and focused.** Don't refactor unrelated code while addressing feedback.
4. **Verify the fix builds and tests pass** before committing.
5. Push to the same branch and reply to the comment: "Fixed in `<commit-sha>`."

### 5. Push and communicate via code, not comments

- **Fixed:** push to the branch and reply "Fixed in `<commit-sha>`."
- **Won't fix / Invalid:** reply once with a brief, respectful explanation. Do not argue.
- Do not resolve threads — the reviewer resolves on re-review.

### 6. Update the PR body

If the PR description no longer matches the current state of the branch, update it so the PR always describes what it *currently* does:

```bash
gh api repos/Stoffer-Industries/<repo>/pulls/<number> \
  -X PATCH --field body="<updated body>"
```

## Important

- NEVER blindly apply all feedback without critical evaluation.
- ALWAYS examine the surrounding codebase context, not just the diff.
- If you disagree with feedback, explain your reasoning clearly. The user decides.
- Continue calling functions until you have fully completed your analysis.
