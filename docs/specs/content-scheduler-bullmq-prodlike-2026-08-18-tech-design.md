---
status: draft
task_id: 1945f8a2-2b61-4603-a548-8417c462bab5
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Content Scheduler — flip auto-post to durable BullMQ+Redis in prodlike — tech design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/1945f8a2-2b61-4603-a548-8417c462bab5`
- Incident: `agent_incidents.md` entry `content-scheduler-in-process-bullmq-unscheduled-2026-08-18` (the 4 dropped tweets that motivated this task)

## Task and repository

- Task ID: `1945f8a2-2b61-4603-a548-8417c462bab5`
- Task title: `💻 Fix content-scheduler auto-post: flip to durable BullMQ+Redis adapter in prodlike`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-1945f8a2-content-scheduler-bullmq-prodlike`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-1945f8a2-bullmq-prodlike`
- Owner: Rowan (implementation + ops bootstrap) · Tom (manual approve/publish verification)

## Product intent summary

The Content Scheduler auto-post path is currently running the `in-process` job adapter in prodlike because neither `CONTENT_SCHEDULER_JOB_ADAPTER` nor `CONTENT_SCHEDULER_REDIS_URL` is set. The in-process adapter holds scheduled jobs as `setTimeout` timers inside the tasks-api process, so any restart of that process drops all queued jobs with no reconciliation safety net (the reconciliation sweep only runs on boot of the **separate worker** process, which is not running in prodlike today). This silently dropped 4 approved/scheduled tweets between 2026-08-11 and 2026-08-14, discovered by Tom on 2026-08-18 when the Unscheduled overflow accumulated them. Tom approved this fix in Telegram on 2026-08-18.

The fix is to make auto-post durable across restarts by running the BullMQ queue adapter (with Redis as the durable backing store) in prodlike and keeping the dedicated worker process alive under a process manager. Once flipped, the existing reconciliation sweep on every worker boot will re-enqueue any approved item whose queue job is missing and publish any overdue approved item deterministically through the shared `publishContentSchedulerItem` service — so even a future Redis restart or worker crash leaves no approved items silently unscheduled.

## Service boundary and data ownership

- This task is **operational**, not a code change. The BullMQ adapter (`services/tasks-api/src/routes/contentSchedulerJobs.bullmq.ts`, 263 lines), the worker entrypoint (`services/tasks-api/src/autoPostWorkerMain.ts`, 156 lines), the reconciliation sweep (`services/tasks-api/src/routes/autoPostReconciliation.ts`, 341 lines), and the diagnostic health endpoint (`services/tasks-api/src/routes/contentSchedulerAutoPost.ts`, 195 lines) are already in `main` and were shipped by PR #245 / the auto-post tech design.
- `services/tasks-api` remains the owner of the queue adapter, the worker process, and the reconciliation sweep. A future service extraction (task `94d5e4fc`) will move the same files to `services/content-scheduler-api`; this design does not commit to either location — the env-var flip in `services/tasks-api/.env.prodlike` is the current binding.
- `services/tasks-api/.env.prodlike` is the source of truth for production-likeness env values in this repo. The `.env.prodlike.local` sibling file is gitignored and is where local-machine overrides (e.g. a different Redis port if the default collides) live. We update `.env.prodlike` for the 4 values that should be inherited by anyone running prodlike; operator-specific values go in `.env.prodlike.local`.
- The Redis server itself is a runtime dependency, not a code dependency. We will not add Redis to `infra/docker-compose.dev.yml` or any compose file — the prodlike Redis runs as a host-managed service (see implementation plan § 1).
- Domain ownership has not changed: the Content Scheduler service owns queue state, approval metadata, scheduled job identity, publish guards, X publish integration, and reconciliation. Nothing here violates that.

## `.openclaw` boundary notes

- **No `.openclaw` cron should be added for this task.** The implementation is event-driven through BullMQ + a repo-owned worker process, not a polling heartbeat or `.openclaw` cron. Re-confirming the auto-post tech design's boundary: the worker is a host-managed process, not a `.openclaw` scheduled cron.
- **No `.openclaw` file edits are required.** The secrets involved (`CONTENT_SCHEDULER_REDIS_URL`, the existing X OAuth credentials, the existing `CONTENT_SCHEDULER_INGEST_SECRET`) are env values, not file-system state. The host-local Redis URL used in prodlike is a host-managed secret, not an `.openclaw` file.
- **The tasks-api launchd unit is outside this repo.** The `infra/launchd/` directory does not exist in this checkout; the tasks-api and its worker are run via host-specific supervisor (currently the developer's interactive `npm run` invocations and a tmux/screen session for the worker). Restarting tasks-api after the env-var change is a host-level action, not a repo change. We will document the operator command in this design and the affected services' README, but not commit a plist or systemd unit.
- **The worker process manager is a host-level decision.** We will default to a host-resident `launchd` plist for the worker on macOS (matching the existing pattern for tasks-api), but the LaunchAgent `.plist` file lives outside this repo and is created on the host. If the agreed process manager is different (e.g. `pm2`, a systemd unit on Linux cloud), the launchd template in the design is illustrative, not authoritative.

## Implementation plan

### 1. Provision Redis in prodlike

- **Local macOS install** via Homebrew: `brew install redis && brew services start redis`. Validate with `redis-cli ping` → `PONG`. Default listens on `127.0.0.1:6379` with no auth and no password — acceptable for prodlike because it is single-user and loopback-only.
- **Why local install, not docker**: the prodlike stack already runs Postgres via `pg_ctl` on `localhost:7432` and the otel-collector on `localhost:4328` as host processes — adding Redis to the same model keeps the "prodlike = host-resident" contract and avoids the `infra/docker-compose.dev.yml` Redis service which would diverge from the actual production deployment (cloud-hosted Redis, not docker).
- **Do not** add Redis to `infra/docker-compose.dev.yml` or to any committed compose file. The dev stack is for dev; prodlike is for host-resembled prod. They are intentionally separate.
- **Configuration**: `bind 127.0.0.1 -::1`, `port 6379`, `protected-mode yes`, `save ""` (no RDB persistence — queued jobs are ephemeral and the DB is the source of truth), `appendonly no`. The default `redis.conf` plus `brew services start redis` is sufficient.
- **Smoke**: `redis-cli set _smoke ok EX 5 && redis-cli get _smoke` returns `ok`. `redis-cli ping` returns `PONG`. `redis-cli pubsub channels '*'` should be empty / show BullMQ channels only after the worker boots.

### 2. Update `services/tasks-api/.env.prodlike`

Add three lines to the existing `services/tasks-api/.env.prodlike` (which already has `PORT=4001`, `DATABASE_URL`, OTEL, and `CONTENT_SCHEDULER_INGEST_SECRET`):

```bash
# Flip auto-post to durable BullMQ+Redis adapter (task 1945f8a2; reinstated 2026-08-18)
CONTENT_SCHEDULER_JOB_ADAPTER=bullmq
CONTENT_SCHEDULER_REDIS_URL=redis://127.0.0.1:6379
# Pin the worker log to a stable file so the launchd LaunchAgent can tail it
CONTENT_SCHEDULER_WORKER_LOG_FILE=/Users/quinnstoffer/.local/share/sindustries/content-scheduler-worker.prodlike.log
```

The `env.ts` schema already validates this combination: `CONTENT_SCHEDULER_JOB_ADAPTER=bullmq` without `CONTENT_SCHEDULER_REDIS_URL` or `REDIS_URL` would fail at boot with `CONTENT_SCHEDULER_REDIS_URL or REDIS_URL is required when CONTENT_SCHEDULER_JOB_ADAPTER=bullmq` (see `services/tasks-api/src/config/env.ts:125-130`). Setting both resolves the validation.

We do not touch `services/tasks-api/.env.prodlike.local` (operator-specific overrides).

### 3. Restart the tasks-api process so env is re-read

- The tasks-api process must be restarted to pick up the new adapter selection. It is currently running as a host process (either an existing `launchd` LaunchAgent or a developer `npm run`). Restart by whatever the host's standard mechanism is — `launchctl kickstart -k gui/$(id -u)/<plist-label>` for launchd, or kill-and-rerun for ad-hoc processes.
- After restart, the API entries in `services/tasks-api/src/app.ts` install the BullMQ adapter at boot and the boot log should include `content-scheduler: job adapter installed kind=bullmq` (or similar log line — verify at restart).
- **Validation immediately after restart**: `curl -sS http://localhost:4001/api/v1/content-scheduler/auto-post/health | jq -r '.data.adapter, .data.redis.ok'` should report `bullmq` and `true`. If `adapter` is `in-process`, the env var did not propagate — investigate before continuing.

### 4. Run the worker under a process manager

- **Worker process**: `cd services/tasks-api && npm run content-scheduler:worker`. The script (`tsx --require @sindustries/otel-node/register src/autoPostWorkerMain.ts`) boots the worker, registers the BullMQ adapter, wires up a `Worker` on the `content-scheduler-auto-post` queue, and runs `reconcileAutoPostItems()` on startup.
- **Process manager**: create a host-resident `launchd` LaunchAgent that runs the worker, with `KeepAlive=true`, `RunAtLoad=true`, `StandardOutPath` / `StandardErrorPath` pointed at the log file declared in step 2. The plist lives outside the repo at `~/Library/LaunchAgents/com.stoffer-industries.content-scheduler-worker.plist`.
- **Why a LaunchAgent, not a tmux/screen session**: the previous set-up (dev console + tmux) is what allowed the worker to stop running in prodlike; the tmux/screen session is not resilient to host reboot or the developer's shell exiting. A LaunchAgent persists across reboots and is the same mechanism the tasks-api itself runs under.
- **Skill/process-manager-listing**: capture the LaunchAgent load command (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stoffer-industries.content-scheduler-worker.plist`) and the log-tailing command in the design's runbook section so the operator can verify or restart the worker without re-reading the file.
- **First-boot behavior**: the worker emits `[content-scheduler-worker] starting (adapter=bullmq)`, then `[content-scheduler-worker] reconciliation scanned=<N> reEnqueued=<N> overduePublished=<N> ...`, then `[content-scheduler-worker] ready`. The reconciliation report is the most important first-boot signal: it tells the operator how many approved items the database had to repair at flip time. We expect this to be `scanned=N overduePublished=4 overduePublishFailed=0` for the 4 known stuck items from the 2026-08-14 incident, and `scanned=N overduePublished=0` after the initial flip is healthy.
- **Earlier branch caution**: there is an existing remote branch `task-6492813a-content-scheduler-auto-post-durable` that was created for a previous attempt; that branch was never merged and is not the current branch. We do not interact with it in this design.

### 5. Verify all five ACs end-to-end

The verification matrix below names the exact commands. The key end-to-end check (AC5) is the manual approval + time-boxed auto-publish.

## Data model and API contract changes

**None.** No Prisma migration. No route changes. No new fields. The existing `ContentSchedulerItem` schema already carries `autoPostJobId`, `autoPostScheduleVersion`, `autoPostScheduledAt`, `autoPostLastEnqueuedAt`, and the existing endpoints (`/api/v1/content-scheduler/auto-post/health`, `/reconcile`, `/items`) already report the values the ACs need.

The `GET /content-scheduler/auto-post/health` response shape is locked to `{adapter, queue, overdue, redis, recommended, now}` — we will not change it. AC4 just checks that the existing fields report the right values.

## Workflow, cron, and skill changes

- **Cron**: none. Do not add a polling cron or heartbeat scanner for eligible items.
- **Worker**: the repo's `services/tasks-api` already includes the worker entrypoint script (`npm run content-scheduler:worker`) and the worker code (`src/autoPostWorkerMain.ts`). The host-level process manager changes are outside the repo.
- **Skills**: no skill changes required. The existing `tasks-api` skill and `tasks-api/scripts/agent_task_queue.py` are read-only and unaffected.
- **Telegraph / Mission Control**: no UI changes. The diagnostic endpoint exists; the diagnostic button in the tab (if any) remains the same. The auto-post panel surfaces `overdue.count` and `recommended` exactly as designed.
- **Host-level supervisor**: a new `~/Library/LaunchAgents/com.stoffer-industries.content-scheduler-worker.plist` is created on the prodlike host. This file is outside the repo and not under version control. The plist's `ProgramArguments` invokes the same `npm run content-scheduler:worker` script via `/bin/bash -c "cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/services/tasks-api && npm run content-scheduler:worker"`, with the env inherited from `launchd`.

## Test plan

### Automated tests

The behavior is already covered by the auto-post test suite in `main`:

- `services/tasks-api/src/routes/contentSchedulerAutoPost.test.ts` — adapter selection, BullMQ adapter shape, BullMQ adapter durable-mode tests (deterministic `jobId`, delay/attempts, cancel/hasJob/ping/queueStats/close)
- `services/tasks-api/src/routes/contentSchedulerAutoPostDurable.test.ts` — `reconcileAutoPostItems` (re-enqueue / scheduled-active / overdue / limit), `describeItemForReconcile`, `resolveRedisUrl` env precedence
- `services/tasks-api/src/routes/contentSchedulerAutoPost.test.ts` — end-to-end publish-via-auto-post with the in-process adapter
- `services/tasks-api/src/routes/contentScheduler.test.ts` — CRUD, approve/unapprove, publish guard outcomes, reorder

No new test files. The flip is verified by the operational AC checks; the prior test suite is the regression net.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Operational / network. `redis-cli -h 127.0.0.1 -p 6379 ping` returns `PONG` after `brew services start redis`. Confirm Redis listens on `127.0.0.1:6379` (loopback only) and `protected-mode yes`. | `redis-cli ping` output in PR description; `lsof -iTCP:6379 -sTCP:LISTEN` showing the redis-server bound to `127.0.0.1` only. |
| AC2 | Operational / config. `grep -E "CONTENT_SCHEDULER_JOB_ADAPTER\|CONTENT_SCHEDULER_REDIS_URL" services/tasks-api/.env.prodlike` returns both lines. After restarting tasks-api, `curl -sS http://localhost:4001/api/v1/content-scheduler/auto-post/health` returns `data.adapter == "bullmq"`. | Grep output + health endpoint JSON in PR description. |
| AC3 | Operational / process. `launchctl list | grep content-scheduler-worker` shows the LaunchAgent loaded with PID and last-exit-status 0. `tail -n 50 ~/.../content-scheduler-worker.prodlike.log` shows the worker started, ran reconciliation, and is ready. | `launchctl list` output + tail of log file in PR description. |
| AC4 | Operational / health. After the worker has been running for >30 seconds post-restart, `curl -sS http://localhost:4001/api/v1/content-scheduler/auto-post/health` reports `adapter: "bullmq"`, `redis.ok: true`, `overdue.count: 0`, and `recommended: null` (or `null` if no other action is needed). | Health endpoint JSON paste in PR description. |
| AC5 | Manual / end-to-end. In Mission Control Content tab: create a test item, set `scheduledFor` to `now + 2 minutes`, approve it. Within ~30 seconds of the scheduled time, the item should transition to `published` automatically with `publishedAt` and `publishedUrl` populated. The item's `publishError` must remain null. Verify by `GET /content-scheduler/items/<id>` via the API. The test body and `scheduledFor` must be cleared after the verification to avoid leaving a published test tweet on X. | Screenshot of the calendar showing the item published at the scheduled time + `GET /items/:id` JSON in PR description. Note: if X credentials are not configured in prodlike, this AC will fail with `missing_credentials` and the `publishError` will be populated with the same string — in that case, fall back to AC4 verification plus the reconciliation report showing `overduePublished>0` for a scheduled item that has just passed its `scheduledFor`. |

### Operational smoke (pre-commit)

The PR should not be opened until the operator can show the AC matrix is fully satisfied end-to-end. The PR description includes:

1. The diff that added 3 lines to `services/tasks-api/.env.prodlike`.
2. The `redis-cli ping` output.
3. The health endpoint JSON.
4. The launchd `plist` (created on host, but its `cat` output is included in the PR description so the operator-level change is visible).
5. The worker log tail showing reconciliation.
6. The AC5 end-to-end result (published screenshot or fallback reconciliation report).

## Open questions and risks

1. **Redis persistence.** This design uses `save ""` (no RDB) and `appendonly no` (no AOF). If the Redis process crashes, queued delayed jobs are lost — but the worker boot runs `reconcileAutoPostItems()` which re-enqueues any approved item whose queue job is missing and publishes any overdue approved item deterministically. Net effect: **no approved items are silently stuck across a Redis restart**, but there may be a small window where a job that was scheduled to fire *during* the Redis crash window is published a few seconds late. This is acceptable for prodlike and matches the existing safety net.
2. **Cloud-deployment readiness.** This design is prodlike-local only. The cloud-readiness work (task `206927ed` "Define and secure production runtime configuration" and `b2f62c36` "Establish cloud deployment foundation") will replace local Redis with a hosted Redis (e.g. Render Key-Value, Upstash, or AWS ElastiCache) and replace the LaunchAgent with a cloud-managed worker deployment. The bullmq adapter does not change; the env-var shape and the worker entrypoint do not change. This design is intentionally scoped to prodlike.
3. **Worker restart semantics.** `launchd` `KeepAlive=true` will reload the worker process after it exits. The current `graceful shutdown` handlers in `autoPostWorkerMain.ts` (`SIGINT`, `SIGTERM` → `adapter.close()` + `process.exit(0)`) take <500ms in practice, so the time-to-restart window is short. The reconciliation sweep on every boot is the durable safety net.
4. **Multiple worker replicas.** Not used in prodlike. BullMQ's deterministic `jobId` makes multiple workers safe (no duplicate publish), but we will run exactly one worker process in prodlike. The launchd plist does not declare `MultipleInstances`.
5. **X credentials in prodlike.** The four `X_API_*` env vars are not currently set in `services/tasks-api/.env.prodlike`. AC5's end-to-end verification will fail with `missing_credentials` if X is not configured. The fallback is the AC4 + reconciliation-report verification path. If Tom wants AC5 to be a true end-to-end (published tweet on X), Tom must add the X credentials to `services/tasks-api/.env.prodlike.local` (not committed) for the verification window. This is the same X-credential bootstrapping pattern the dev env uses.
6. **Existing 4 stuck items.** When the worker first boots, the reconciliation sweep finds 4 approved items with `scheduledFor` in the past (the 2026-08-14 incident). The sweep will try to publish them at boot. If X credentials are missing, all 4 will end up with `publishError: missing_credentials`. Tom must then either: (a) add X credentials and re-run `POST /content-scheduler/auto-post/reconcile`, or (b) manually publish the stranded items via the existing Publish button. This is a known consequence of the fix; it is not a regression.
7. **Earlier branch.** The remote branch `task-6492813a-content-scheduler-auto-post-durable` exists but is not merged. We do not cherry-pick from it; we start fresh from `origin/main` because the env-var shape and the worker entrypoint are already in main and the previous branch's work surfaced in `d52c3ca`. If the previous branch turns out to contain useful artifacts we did not see, the operator can `git log --all --grep` to surface them.
8. **Rollback.** If the flip fails, the rollback is a one-line revert of `services/tasks-api/.env.prodlike` (back to `CONTENT_SCHEDULER_JOB_ADAPTER=in-process` or unset) and a tasks-api restart. The BullMQ adapter leaves no state in the database that the in-process adapter cannot read — only durable Redis queue state is removed by the rollback. Approved items with `scheduledFor` in the future will need to be re-approved or re-PATCHed to re-enqueue under the in-process adapter; the reconciliation sweep will not run if the worker is not running.

## Runbook cheat sheet

```bash
# 1. Redis
brew services start redis
redis-cli ping

# 2. env
grep -E "CONTENT_SCHEDULER_JOB_ADAPTER|CONTENT_SCHEDULER_REDIS_URL" services/tasks-api/.env.prodlike

# 3. Restart tasks-api (via the host's launchd / supervisor)
launchctl kickstart -k "gui/$(id -u)/com.stoffer-industries.tasks-api"

# 4. (One-time) Author the worker LaunchAgent on the host and load it.
#    The plist is host-local, not in the repo. A minimal template:
#      <?xml version="1.0" encoding="UTF-8"?>
#      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#      <plist version="1.0"><dict>
#        <key>Label</key><string>com.stoffer-industries.content-scheduler-worker</string>
#        <key>ProgramArguments</key>
#        <array>
#          <string>/bin/bash</string>
#          <string>-lc</string>
#          <string>cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/services/tasks-api && npm run content-scheduler:worker</string>
#        </array>
#        <key>WorkingDirectory</key><string>/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/services/tasks-api</string>
#        <key>RunAtLoad</key><true/>
#        <key>KeepAlive</key><true/>
#        <key>StandardOutPath</key><string>/Users/quinnstoffer/.local/share/sindustries/content-scheduler-worker.prodlike.log</string>
#        <key>StandardErrorPath</key><string>/Users/quinnstoffer/.local/share/sindustries/content-scheduler-worker.prodlike.log</string>
#      </dict></plist>
#    Save the snippet above as ~/Library/LaunchAgents/com.stoffer-industries.content-scheduler-worker.plist
#    and load it:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stoffer-industries.content-scheduler-worker.plist
launchctl kickstart -k "gui/$(id -u)/com.stoffer-industries.content-scheduler-worker"

# 5. Verify
curl -sS http://localhost:4001/api/v1/content-scheduler/auto-post/health | jq
tail -n 50 /Users/quinnstoffer/.local/share/sindustries/content-scheduler-worker.prodlike.log
```
