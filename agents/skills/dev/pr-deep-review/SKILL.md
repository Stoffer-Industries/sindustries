---
name: pr-deep-review
description: >
  Run a deep, thorough code review on a PR that touches concurrency, async paths,
  shared state, data, public APIs, or other high-risk surfaces. Use when a PR
  review reveals changes in any of those areas, or when the reviewer decides the
  standard pr-review checklist isn't enough. Triggered by pr-review when the PR
  meets the deep-review criteria; not run by default for routine reviews.
---

# PR Deep Review

Full code-review checklist for PRs that touch high-risk surfaces. Use this when `pr-review` flags the change as deserving a deeper look. Do not run it for routine doc updates, code-garden cleanup, or content tasks — those are covered by `pr-review` alone.

## When to run this

Run `pr-deep-review` (in addition to `pr-review`) when the PR touches any of:

- **Concurrency, async paths, locks, or shared mutable state** — anything with `async`/`await`, threading, queues, locks, or shared maps
- **Database, schema, or data migrations** — SQL changes, ORM model updates, data backfills
- **Authentication, authorization, secrets, tokens** — auth flows, token handling, credential storage
- **Public APIs or shared types/contracts** — exported types, REST/GraphQL signatures, serialisation formats
- **File system, network, or external service integration** — disk writes, HTTP clients, third-party SDKs
- **Error handling / retry / backoff / circuit breakers**
- **Anything touching `tasks-api`, `bookmark-*` workflows, `tilt`, `otel`, or infra runbooks**

If none of the above apply, `pr-review` is sufficient. Do not run the deep checklist for cosmetic, doc, or content changes.

## Workflow

### 1. Get the full context

```bash
GITHUB_TOKEN="***" gh pr view <number> --repo Stoffer-Industries/<repo> --json title,body,reviews,statusCheckRollup

GITHUB_TOKEN="***" gh pr diff <number> --repo Stoffer-Industries/<repo>
```

Read the diff, but also pull the full files for each modified path so you can read the surrounding code. Trace every changed function to all its callers and callees.

### 2. Run the checklist

For each modified file, walk through every applicable category below. Be specific — reference file:line. Provide fixes, not just complaints.

#### Correctness & Logic

- [ ] Does the logic correctly implement the stated intent?
- [ ] Are all code paths handled, including edge cases (empty input, max values, partial failure)?
- [ ] Are error conditions handled properly? Are they distinguished from happy-path returns?
- [ ] Are there off-by-one errors, inverted conditions, or missing negations?
- [ ] For conditional changes: are both the `if` and `else` branches correct?

#### Null Safety & Error Handling

- [ ] Could any value be null/undefined where it's not expected?
- [ ] Are exceptions/errors caught and handled appropriately? Are they logged with useful context?
- [ ] Are error messages clear enough to debug from a stack trace?
- [ ] Are resources (file handles, sockets, locks, transactions) properly closed/released on every path, including error paths?

#### Concurrency & Async

- [ ] Are shared mutable state accesses properly synchronised?
- [ ] Could race conditions occur (check-then-act, non-atomic reads+writes)?
- [ ] Are concurrent data structures used where needed, or could a plain map/list suffice?
- [ ] For async code: are all promises awaited? Are subscriptions cleaned up?
- [ ] Are timeouts set on external calls? What happens when they fire?

#### API & Contract Changes

- [ ] Do changes to public APIs maintain backward compatibility? (Old callers still work?)
- [ ] Are new parameters optional with sensible defaults, or required?
- [ ] Do return types and values match what callers expect?
- [ ] Are serialization/deserialization contracts maintained? (Field names, types, optional vs required)
- [ ] Is there a migration path for breaking changes?

#### Performance

Only flag in hot paths or where the change is plausibly worse:

- [ ] N+1 query patterns or unnecessary loops over large collections?
- [ ] Blocking calls inside async contexts?
- [ ] Large collections fully materialised when streaming would suffice?
- [ ] Unnecessary object allocations in hot paths?
- [ ] New external service calls in loops?

#### Security

- [ ] Is user input validated and sanitised at the trust boundary?
- [ ] Are there injection risks (SQL, XSS, command injection, path traversal)?
- [ ] Are sensitive data (tokens, passwords, PII) handled correctly? Never logged?
- [ ] Are authorisation checks in place for protected operations?
- [ ] Are secrets read from env or a secret store, never hard-coded?

#### Testing

- [ ] Are there tests covering the changed logic?
- [ ] Do tests cover happy paths AND error/edge cases?
- [ ] Are test assertions meaningful (not just "code runs without error")?
- [ ] For bug fixes: is there a regression test that would catch the original bug?
- [ ] Do mocks/stubs verify the right behaviour, not just framework mechanics?

#### Code Quality

- [ ] Any unused variables, imports, or dead code introduced?
- [ ] Duplicated code that could be extracted into a reusable function?
- [ ] Do new functions/methods follow naming conventions used elsewhere in the codebase?
- [ ] Are magic numbers/strings extracted into named constants?
- [ ] Is the code readable and self-documenting? Or does it need a comment to explain intent?

### 3. Compile findings

Use the structured output format — this is where it earns its weight over a casual review:

```
## Deep Review: <PR title>

### Critical (must fix before merge)
For each: file:line, what's wrong, what could go wrong, suggested fix.

### Important (should fix)
For each: file:line, what's wrong, suggested fix.

### Minor (consider)
For each: file:line, what's wrong, suggested fix.

### Questions
Things that aren't clearly wrong but warrant explanation.

### Positive observations
Call out things done well — good tests, clean abstractions, etc.
```

### 4. Submit verdict

Approve only when every Critical and Important is resolved. If you can't reach a verdict in one pass, request changes with the specific list.

```bash
GITHUB_TOKEN="***" gh pr review <number> --repo Stoffer-Industries/<repo> --approve --body "<summary>"

GITHUB_TOKEN="***" gh pr review <number> --repo Stoffer-Industries/<repo> --request-changes --body "<specific issues>"
```

Do not merge — the assignee merges.

## Important

- **Read the code in context**, not just the diff. A function that looks wrong in isolation may be correct given how it's called.
- **Trace callers and callees.** If a signature changed, every caller is affected. If a contract changed, every consumer is affected.
- **Verify tests prove the claim.** A test that just exercises the code without asserting correctness is not a real test.
- **Continue calling functions until the review is complete.** Do not stop early.
- **Distinguish "this is wrong" from "I would do this differently".** Only flag the former.
