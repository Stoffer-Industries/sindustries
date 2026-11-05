# Eval baseline

Reference scores for the seed cases, so a future model swap can be compared
against something instead of against nothing. Re-run with:

```bash
python3 agents/evals/run.py --model <provider/model> --all
```

and diff the result against the table below.

## Measured 2026-11-05

`minimax-portal/MiniMax-M3.1-Flash` and `anthropic/claude-sonnet-5`, both via
the `infer` transport, both graded by the harness's own graders.

| Case | Model | Score | Wall clock | Notes |
|---|---|---|---|---|
| `lobster-ac-compliance` | `anthropic/claude-sonnet-5` | **1.000** (pass) | 9.7s | Graded by the production lobster parser. |
| `lobster-ac-compliance` | `minimax-portal/MiniMax-M3.1-Flash` | **1.000** (pass) | 32.1s | Same grader. |
| `planted-defect-review` | `anthropic/claude-sonnet-5` | 0.667 (fail) | 14.5s | Found 2 of 3 planted defects; missed `taskcomment-missing-camelcase`. No false positives. |
| `planted-defect-review` | `minimax-portal/MiniMax-M3.1-Flash` | no score | — | Six consecutive attempts failed with a provider-side `Connection error` before any text came back. Recorded as `model_error` rather than a zero — see PR #917. |
| `pr-contract-review` | both | no score | — | Not yet scored. Its prompt is ~181 KB, over the `infer` transport's 120 KB cap, and the `agent` transport it declares cannot be invoked from inside an agent session (it would lose inter-session attribution). It needs a run from a normal shell or CI, not from an agent. |

## Reading these numbers

Two of the three scored cells are passes by a model that had to satisfy the real
lobster parser — that is the load-bearing result, because it means the
harness can tell a real pass from a real fail rather than grading prose.

Two caveats worth carrying forward:

- `planted-defect-review` scores shallowly. Its grader anchors on keywords, so
  it measures whether a model *names* the right area, not whether its reasoning
  holds. Sonnet 5 missing the camelCase defect is a real miss, but a model
  could also miss one and score 1.0 by naming the other two.
- The `pr-contract-review` case has never been scored end to end. Treat its
  expected findings as unproven until it runs.

## What a regression looks like

- A drop in `lobster-ac-compliance` below 1.000 is a real regression: that
  grader is the production parser, so it cannot be gamed by better prose.
- A drop in `planted-defect-review` is noisy. One finding is one keyword.
