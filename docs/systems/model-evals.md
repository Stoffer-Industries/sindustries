# Model Evals

Evals for the models that do the factory's work. Before this, we had none
anywhere: a blind model benchmark produced results with nowhere to put them,
and the answers it produced were graded by hand, which does not scale and
does not survive the next run.

The harness lives in `agents/evals/`. See `agents/evals/README.md` for how to
run it and how to add a case.

## What an eval is here

A **case** is one question a model must get right, with:

- a prompt, and the fixtures it needs
- a **grader** that turns the model's response into a score
- a **known-good** and a **known-bad** response, which the grader must
  separate

## The rule everything else serves

**A grader with no control is a liar.**

The harness runs both control fixtures through the grader before it scores
anything. The known-good one must pass; the known-bad one must fail. If the
grader cannot separate them, the case is reported `BROKEN` and no model is
scored against it.

This is not a nicety. A grader that passes everything reports every model as
excellent. A grader that fails everything reports every model as useless.
Both look exactly like a working eval suite from the outside, and both produce
a confident, wrong routing decision — which model does the factory's PR
review next month. The control is what makes the score mean something, and
the same argument is why the lobster case is graded by the production parser
rather than by a reimplementation of it.

## Grading with production code

When the thing under test is decided by real code, run that code.

The `lobster-ac-compliance` case asks whether a model can write a PR body's
Acceptance Criteria section the lobster accepts. That is decided by
`agents/workflows/feature-task/src/ac_parsing.rs`, so the grader runs it:
`feature-task ac-check` is a subcommand that applies the same two gates
`verify-delivery` applies — AC coverage/verbatim text/evidence, and the
structural evidence check — to a task description and a candidate PR body read
from disk.

A reimplementation of the parser would drift from the parser and then report
failures the real gate would not. That is how a grader starts lying about the
thing it grades, and it is the exact failure this repo already hit once: the
`pr-open` skill's evidence rules told agents to flatten test names into a form
the parser had stopped needing, because the rule predated the parser fix by
eight days and nothing checked the two against each other.

The other two cases use keyword anchoring — deterministic but shallow. They
measure whether a model *names* the right area, not whether its reasoning is
sound. Both trades are stated in the case files rather than hidden.

## The cases

| Case | Measures | Grader |
|---|---|---|
| `lobster-ac-compliance` | Can the model write a PR body's Acceptance Criteria section the lobster accepts? | The production parser (`feature-task ac-check`). |
| `planted-defect-review` | Can the model find three planted defects in a Rust file, and leave a clean construct alone? | Keyword-anchored findings, with a false-positive check. |
| `pr-contract-review` | Can the model find defects in the *contract* between code and the prose describing it? | Keyword-anchored findings, with a false-positive check on an already-fixed item. |

The third case's fixture is a frozen snapshot of a PR head taken at a
specific commit, so the case does not change as the live PR moves.

## Running

```bash
python3 agents/evals/run.py --list
python3 agents/evals/run.py --validate-only          # no model calls
python3 agents/evals/run.py --model <provider/model> --case <case-id>
python3 agents/evals/run.py --model <provider/model> --all
```

Results land in `agents/evals/results/<model>/<case>.json`. Every attempt is
persisted, not only attempts that scored, and each record carries a
`recordedAt` timestamp. The latest attempt for a model/case wins: if a
provider error or broken grader follows an earlier pass, the scorecard says
so instead of continuing to claim the stale pass.

The measured seed scores are recorded in
[`agents/evals/BASELINE.md`](../../agents/evals/BASELINE.md). They are the
comparison point for a later model swap; `elapsedSeconds` measures model
invocation only, not grader-control validation or prompt setup.

Each case declares its default transport. `--transport` overrides that
choice. The large `pr-contract-review` case uses the agent transport because
its frozen prompt exceeds Linux's single-argument limit for a raw infer
call; the agent transport passes the prompt by file instead.

## In CI

CI runs the model-free half: the harness self-tests, and a control validation
that checks every grader still discriminates. No model calls, so it cannot go
stale or bill anything. A grader that stops discriminating fails the build
instead of quietly reporting every model as excellent.

## Adding a case

See `agents/evals/README.md`. The short version: write the case, write the
two controls, anchor the expected findings on keywords any correct answer must
contain, and run `--validate-only` before believing anything the grader says.

If the thing under test is decided by code we own, add a subcommand to the
owning crate and grade with that. Do not reimplement the rule.
