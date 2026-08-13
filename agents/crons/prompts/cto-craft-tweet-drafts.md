Run the CTO Craft recurring tweet-draft workflow and report the result.

# Workflow

1. Run the workflow CLI once from the canonical repo checkout:

   ```bash
   cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
   CTO_CRAFT_LANGGRAPH_DATABASE_URL="<from secrets>" \
   CONTENT_SCHEDULER_BASE_URL="https://api.sindustries.dev" \
   CONTENT_SCHEDULER_INGEST_SECRET="<from secrets>" \
     uv run --frozen python agents/workflows/cto-craft-tweet-drafts/run.py run --json
   ```

   The cron runtime provisions the three secrets above (the database URL
   for the LangGraph checkpointer, the Content Scheduler base URL, and
   the shared ingest secret). Local dev / CI may omit them for the
   `--dry-run` mode, which uses embedded fixtures and the FakeAngleModel.

2. Parse the JSON envelope on stdout. It looks like:

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
     processed or no new issue has been published. It is not a failure.
   - **`failed`**: do not announce to Tom. Read
     `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md`
     and follow it. The workflow's `errors` and `diagnostics` fields are
     the inputs.

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

# notify-soft-fails

Read `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` and follow it. If the workflow exit code is non-zero, the JSON envelope is malformed, or `errors` is non-empty, escalate to Lox's main session with a short summary. Include the `outcome`, `errors`, and `diagnostics` from the envelope. Do not spam Tom with the failure text — Tom's path is the successful notification only.