Run the CTO Craft recurring tweet-draft workflow and report the result.

# Workflow

1. Run the workflow CLI once from its own uv-managed workspace so
   that the workflow's `uv.lock` + `.venv` (which has
   `cto-craft-workflow` installed) is used:

   ```bash
   cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/cto-craft-tweet-drafts
   CTO_CRAFT_LANGGRAPH_DATABASE_URL="<from secrets>" \
   CONTENT_SCHEDULER_BASE_URL="<from secrets>" \
   CONTENT_SCHEDULER_INGEST_SECRET="<from secrets>" \
     uv run --frozen python run.py run --json
   ```

   The cron runtime provisions the three secrets above (the database URL
   for the LangGraph checkpointer, the Content Scheduler base URL, and
   the shared ingest secret). Local dev / CI may omit them for the
   `--dry-run` mode, which uses embedded fixtures and the FakeAngleModel.

   **Why the `cd` lands inside the workflow directory, not the repo
   root:** `cto-craft-workflow` is its own uv-managed workspace with a
   separate `pyproject.toml` + `uv.lock` + `.venv`. Running `uv run`
   from the parent repo root would resolve against the parent's
   `uv.lock`, which does not include `cto-craft-workflow`, and the
   `from cto_craft_workflow.cli import main` import in `run.py` would
   fail with `ModuleNotFoundError`. The diff is reproducible:
   `cd <workflow> && uv run --frozen python run.py --help` works,
   `cd .. && uv run --frozen python <workflow>/run.py --help` fails.

   The production run can take several minutes while it enriches links and
   scores articles. Give the command the full cron timeout. If `exec` returns
   a running process, poll it with `process` until it exits; do not treat an
   interim poll result as the workflow result and do not stop waiting after a
   short fixed interval.

2. Parse the JSON envelope on stdout only after the process has exited. It
   looks like:

   ```json
   {
     "ok": true,
     "outcome": "created" | "noop" | "failed",
     "issueUrl": "...",
     "eligibleLinks": 12,
     "candidates": 5,
     "selected": 4,
     "createdCount": 3,
     "skippedDuplicateCount": 1,
     "notification": "Created 3 new CTO Craft drafts. Review them in Mission Control → Content Scheduler.",
     "errors": [],
     "startedAt": "...",
     "durationsMs": {}
   }
   ```

3. Branch on `outcome`:

   - **`created`**: announce the `notification` field verbatim to Tom's
     Telegram direct chat. Do not edit, summarise, or append text.
   - **`noop`**: return `NO_REPLY`. A no-op is the expected outcome for
     runs where the latest Tech Manager Weekly issue has already been
     processed, no new issue has been published, or a transient source
     fetch failed before article processing could continue. It is not a
     failure. Diagnostics in `errors` or `diagnostics` do not change this:
     do not announce them, invoke `notify-soft-fail`, or escalate them to
     Lox when `outcome` is `noop`.
   - **`failed`**: do not announce to Tom. Read
     `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md`
     and follow it. The workflow's `errors` and `diagnostics` fields are
     the inputs.

   A non-zero exit, command timeout, killed process, missing stdout envelope,
   malformed JSON, or JSON without one of the documented `outcome` values is
   also a **failed** run. A valid `outcome="noop"` with `ok=false` is a
   terminal expected result, not a failed run and not a “still running” state;
   follow the `noop` branch above. For actual failed runs, read and follow
   `notify-soft-fail` and include the concrete failure class in the escalation.

# Behaviour

- **One notification per run.** A successful run produces exactly one
  `created` outcome and exactly one notification (or zero for `noop`).
  The workflow itself does not announce — that is this prompt's job.
- **Never summarise, paraphrase, or annotate the notification.** Tom
  expects the literal text. Embedding extra commentary makes the
  notification noise.
- **Do not retry on failure.** The Content Scheduler API is
  idempotent; retrying would only double-count the advisory lock and
  spend extra model budget. Surface to Lox via notify-soft-fail.
- **Do not edit the repo.** This cron is read-only against the
  implementation branch. Adding prompts, prompts edits, or graph
  changes is a separate task in the task queue.

The block below applies to hard `failed` outcomes and unacceptable errors that
are not already classified as an expected `noop`; never escalate a `noop` just
because its diagnostic fields are non-empty.

# notify-soft-fails

Read `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
