Run the bookmark compounding-signal calculator once.

This is a **weekly, read-only** observability job. It must never invoke
any other bookmark pipeline stage (no ingestion, no lobster, no
approval handling, no task creation) and must never write to any
upstream pipeline data source. The only writes are the two derived
artifacts under `brain/state/`.

## Command

```sh
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/scripts/compute_compounding_signal.py \
  --workspace-root /Users/quinnstoffer/.openclaw/workspace
```

The script exits `0` on success (publish or dry-run) and non-zero on
any failure. Read the runbook before changing this command:

`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/runbooks/bookmark-compounding-signal.md`

## Mandatory blocks

After running the command, in this exact order:

1. Validate the script's exit code and stdout/stderr.
   - On non-zero exit, capture the JSON `{"error": "..."}` line on stderr
     and continue to step 2 (do not retry).
   - On success, capture `{"published": true, "runId": "...", ...}` from
     stdout and continue to step 2.
2. Sanity-check the published artifacts on disk:
   - `brain/state/compounding-signal.json` parses as JSON, has
     `schemaVersion: 1`, `headlinePercentage == trend[0].percentage`,
     `trend.length == 4`, and `decisionPolicy.lowPercentageBelow == 25.0`.
   - `brain/state/compounding-signal.md` exists and shares the same
     `runId`.
3. Run the mandatory soft-fail block:
   - Read `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` and follow it.
   - If the script or sanity-check failed, escalate to Lox's main session
     per that skill. **Do not retry the calculator in this turn.**
   - If the script succeeded and the sanity-check passed, reply exactly:
     `NO_REPLY`

## Hard constraints

- Do not call any other bookmark script. The signal is intentionally
  decoupled from `bookmarks.lobster.yaml` because cadence and failure
  isolation differ (weekly vs. heartbeat; soft-fail vs. approval pause).
- Do not edit `brain/state/compounding-signal.json` or `.md` by hand.
  The dashboard will mark the next published artifact stale relative to
  a hand-edited timestamp, and the calculator's schema validation will
  reject hand-edited shapes on the next publish attempt.
- Do not push to any git remote from this session. The signal artifacts
  are workspace runtime outputs, not repo contents.
- Do not change the cron schedule from this prompt. Schedule lives in
  OpenClaw cron metadata; if the cadence is wrong, file a follow-up
  task and let Quinn decide.

## Why a separate cron

The compounding signal has a different cadence (weekly vs. heartbeat),
different failure semantics (soft-fail with stale marker vs. approval
pause), and a different owner (engineering vs. Tom). Coupling it to
the existing lobster cron would make each of those worse. The signal
remains downstream of the pipeline by reading its successful artifacts,
not by sharing its runner.
