# Model Evals

Evals for the models that do the factory's work. There were none before this
directory; the three cases here are the ones that came out of a blind
MiniMax-vs-Sonnet benchmark, kept because each has a known right answer and
a grader that can tell a right answer from a wrong one.

## The rule everything else serves

**A grader with no control is a liar.**

Every case ships a known-good and a known-bad response. Before a model is
scored against a case, the grader has to separate those two: the good one
must pass and the bad one must fail. If it cannot, the case is reported
`BROKEN` and no model is scored against it — because a grader that passes
everything would report every model as excellent, and one that fails
everything would report every model as useless. Both look like a working
eval suite from the outside.

The known-good controls are achievable answers, not wishful ones: the
`lobster-ac-compliance` one is a real captured output from a model that
passed, and the other two are written against the same defects the graders
expect.

`python3 agents/evals/run.py --validate-only` runs that check for every case
and calls no model, so CI can enforce it.

## Running

```bash
# what the cases are
python3 agents/evals/run.py --list

# check every grader against its controls (no model calls — this is what CI runs)
python3 agents/evals/run.py --validate-only

# score one model against one case
python3 agents/evals/run.py --model anthropic/claude-sonnet-5 --case lobster-ac-compliance

# score one model against everything
python3 agents/evals/run.py --model minimax-portal/MiniMax-M3.1-Flash --all
```

Results land in `agents/evals/results/<model>/<case>.json`.

Two transports, deliberately separated:

- `infer` (default) — `openclaw infer model run`. A raw single-shot provider
  call: prompt in, text out, nothing else varies. This isolates the model's
  reasoning from agent-loop variance, which is what makes two models'
  scores comparable. Fixture contents are inlined into the prompt because
  this transport has no tools.
- `agent` — `openclaw agent --message-file`. A full agent turn with the
  agent's own `AGENTS.md` context and tools. Use it when the whole agent
  loop is what is under test.

## The cases

| Case | What it measures | Grader |
|---|---|---|
| `lobster-ac-compliance` | Can the model write a PR body's Acceptance Criteria section the lobster accepts? | **The production parser.** `feature-task ac-check` — the same code the acceptance gate runs. |
| `planted-defect-review` | Can the model find three planted defects in a Rust file, and not report a clean construct? | Keyword-anchored findings, with a false-positive check. |
| `pr-contract-review` | Can the model find defects in the *contract* between code and the prose describing it? | Keyword-anchored findings, with a false-positive check on an already-fixed item. |

`lobster-ac-compliance` is graded by running the real gate. That is the point:
a re-implementation of the parser drifts from the parser and then reports
failures the real gate would not, which is how a grader starts lying about
the thing it grades. The other two cases use keyword anchoring, which is
deterministic but shallow — it measures whether a model *names* the right
area, not whether its reasoning is sound. Both trades are stated in the case
files rather than hidden.

## Adding a case

1. Create `agents/evals/cases/<case-id>/case.json` and a `fixtures/` dir.
2. Write a **known-good** and a **known-bad** response. The good one names
   every defect the case expects; the bad one misses them, and where it
   matters also reports something that is not a defect. This is the part that
   takes the effort, and it is the part that makes the score mean something.
3. Anchor the expected findings on keywords that any correct answer must
   contain (`any_of`), and put the constructs that must *not* be reported in
   `must_not_mention`.
4. For anything the production code can decide, grade it with that code. Add
   a subcommand to the owning crate rather than reimplementing the rule.
5. Run `--validate-only`. It must pass before the case is worth anything.
6. Wire the case into CI if the check is model-free (it is, by design).

## Adding a grader

Graders live in `agents/evals/graders.py` and are keyed by the name in the
case's `grader` field. A grader takes `(response, case_dir, config)` and
returns a `GradeResult` with a score and a pass/fail.

Two rules:

- **Prefer the production grader.** If the thing under test is decided by
  real code, run that code.
- **Never let a grader crash look like a zero.** A raised `GraderError` is a
  broken harness, reported as such, not as a model that failed.
