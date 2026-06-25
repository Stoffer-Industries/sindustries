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

Critically evaluate PR review feedback received on your own pull requests. Not all feedback is correct or worth acting on — your job is to think deeply, assess validity, and only make changes that are genuinely warranted.

## Core Principles

1. **Be sceptical, not defensive.** Evaluate each comment on its technical merits. Don't blindly accept or reject.
2. **Understand before acting.** Fully comprehend the reviewer's concern and the surrounding codebase context before deciding.
3. **Proportionality matters.** A valid concern about a negligible real-world impact may not warrant a complex fix.
4. **Discuss before fixing when uncertain.** If validity is ambiguous, present your analysis to the user first.

## Workflow

### Step 1: Gather the Feedback

Determine the source of the feedback. The user may:
- Paste review comments directly into the chat
- Provide a GitHub PR URL with comments to fetch
- Reference specific code comments or suggestions

If a PR URL is provided:
1. Use the GH CLI to fetch the PR diff and comments:
   ```bash
   GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
   gh api repos/Stoffer-Industries/sindustries/pulls/<number>/comments \
     --jq '.[] | {id, path, line, body, user: .user.login}'
   ```
2. Extract all review comments, noting which file and line they refer to
3. Separate inline comments from general PR-level comments

### Step 2: Critically Evaluate Each Comment

For **each** piece of feedback, perform this analysis:

#### 2a. Understand the Concern
- What exactly is the reviewer claiming? Restate it precisely.
- What category does it fall into? (bug, logic error, race condition, style, performance, naming, missing test, etc.)

#### 2b. Examine the Code in Context
- Open the relevant file(s) and expand the surrounding code — not just the changed lines, but enough context to understand the full picture.
- Trace call sites, check how the code is actually used at runtime.
- Look at existing patterns in the codebase for comparison.

#### 2c. Assess Validity
Ask these questions for each comment:
- **Is the reviewer factually correct?**
- **Is the concern theoretically valid but practically negligible?**
- **Does the suggested fix introduce its own complexity?** Weigh the cost of the fix vs the severity of the issue.
- **Is this a style preference or a genuine improvement?** Style comments should generally be respected if they align with codebase conventions.

#### 2d. Classify Each Comment

Assign each comment one of:
- **VALID - WILL FIX**: The feedback is correct and the fix is warranted. Proceed to fix.
- **VALID - WON'T FIX**: The feedback is technically correct but the impact is negligible or the fix adds disproportionate complexity. Explain why.
- **PARTIALLY VALID**: The core concern has merit but the suggested approach is wrong or incomplete. Propose an alternative.
- **INVALID**: The feedback is based on a misunderstanding. Explain clearly and respectfully why.
- **NEEDS DISCUSSION**: Ambiguous — present the trade-offs to the user for a decision.

### Step 3: Present Analysis

Before making any code changes, present your assessment:

```
## PR Feedback Analysis

### Comment 1: [Summary of comment]
**Reviewer's concern:** [Restate precisely]
**Verdict:** VALID - WILL FIX / VALID - WON'T FIX / PARTIALLY VALID / INVALID / NEEDS DISCUSSION
**Reasoning:** [Your analysis]
**Impact if unaddressed:** [What would actually happen]
**Proposed action:** [What you'll do, or why you won't]

### Comment 2: ...
```

### Step 4: Implement Fixes (for VALID - WILL FIX items)

When implementing fixes:
1. **Fix the actual issue**, not just what the reviewer literally suggested — sometimes the reviewer identifies a real problem but suggests the wrong solution.
2. **Add or update tests** for any logic changes.
3. **Keep changes minimal and focused.** Don't refactor unrelated code while addressing feedback.
4. **Verify the fix compiles and tests pass** before committing.
5. Push to the same branch and reply to the comment: "Fixed in `<commit-sha>`."

### Step 5: Update the PR Description

Before pushing, review the PR body and update it to reflect the current state of the branch:

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh api repos/Stoffer-Industries/sindustries/pulls/<number> \
  -X PATCH --field body="<updated body>"
```

Update the summary bullets to reflect what was added or changed in response to feedback. If the test plan has changed, update that too. The PR description should always describe what the PR *currently* does, not what it originally did.

### Step 6: Push and Communicate via Code, Not Comments

**Do NOT reply to PR comments with lengthy explanations.** Let the code speak for itself:
- For fixes: push to the branch and reply to the comment "Fixed in `<commit-sha>`."
- For won't-fix / invalid: reply once with a brief, respectful explanation. Do not argue.
- Do not resolve threads — the reviewer resolves on re-review.

## Things to Watch For

- **Concurrency feedback**: Always check: (a) can it actually happen given the execution model? (b) what's the real-world impact? (c) does the fix add complexity that outweighs the risk?
- **"You should add a test for X"**: Valid if the changed logic isn't covered. But don't add tests that just test framework/mock behaviour with no real value.
- **Style/naming suggestions**: Check codebase conventions. Maintain consistency over the reviewer's personal preference.
- **"This could be simplified"**: Evaluate whether the simplification loses clarity or handles edge cases the reviewer didn't consider.
- **Performance concerns**: Ask for evidence or benchmarks. Micro-optimisations in non-hot paths are usually not worth the readability cost.

## Important

- NEVER blindly apply all feedback without critical evaluation.
- ALWAYS examine the surrounding codebase context, not just the diff.
- If you disagree with feedback, explain your reasoning clearly. The user can then decide.
- Continue calling functions until you have fully completed your analysis.
