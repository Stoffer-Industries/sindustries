# Runbook — Production data migration, backup and restore

This runbook drives the production database cutover workflow
(`.github/workflows/cloud-production-db-cutover.yml`) and the on-host
scripts under `scripts/cloud/database/`. It is the operator companion
to the tech design `docs/specs/production-data-migration-restore-tech-design.md`
and the staging rehearsal runbook
`docs/runbooks/staging-database-migration-restore.md`.

The production cutover runs the **same** harness as the staging drill.
There is no second, "production-only" script set: one harness, two
environment profiles. The production profile is stricter, not looser —
see §2.

## 1. Scope

This runbook covers one production transfer run end to end:

1. inventory the source,
2. dump the source to a verified archive,
3. restore the archive into the destination,
4. apply Prisma migrations,
5. reconcile source against destination,
6. (optional) restore the migrated data again into a recovery database
   and reconcile again — this is the AC3 backup evidence,
7. seal the evidence into `manifest.json`.

It also covers the failure paths: what to do when a step fails, what is
safe to retry, and when to roll back.

**Not** in scope: choosing the maintenance window, approving the
transfer, Neon plan changes, or decommissioning the source. Those are
operator decisions recorded in the task, not steps in this document.

## 2. What makes a production run different from staging

| | staging | production |
|---|---|---|
| Environment label | `staging` | `production` |
| Endpoint identification | denied by production-marker substring in the DSN | **required** allowlist of `host[:port]` the run may touch (`--expected-host`) |
| Second key | not required | `CLOUD_DB_PRODUCTION_ACK=1` in the environment, set only by the typed confirmation |
| Database-name rule | must carry `sindustries_staging_` | must NOT carry the staging prefix |
| Artifact directory | `./artifacts/cloud-staging` | `./artifacts/cloud-production` |
| Envelope kind | `cloud-staging-*` | `cloud-production-*` |
| Schema ownership after the restore | one role owns both schemas | **per-schema confined service roles** — `sindustries_tasks_api` owns `tasks_api`, `sindustries_content_scheduler` owns `content_scheduler` (`databaseServiceRoles` in `infra/cloud/platform/platform-environments.mjs`, production profile only) |

The production Neon branch database is named `neondb` — **the same name
staging uses**. A database-name prefix therefore cannot identify a
production target, which is why the production profile identifies its
target by declared endpoint instead, and why that allowlist is
mandatory: a run that has not declared its endpoints refuses to run.

### Schema ownership after the restore (production only)

The harness restores the archive through ONE destination DSN, and
`restore.sh` runs `pg_restore --no-owner --no-acl`. Two consequences
follow, and only the production profile has the topology that makes
them bite:

- `--no-owner` makes the CONNECTING role the owner of every schema the
  archive creates. The archive's TOC carries both `tasks_api` and
  `content_scheduler` as SCHEMA entries, so the restore creates BOTH
  under the tasks destination DSN — `content_scheduler` ends up owned by
  `sindustries_tasks_api`.
- `--no-acl` drops the source's grants, and the grants that mattered
  lived on the live schema, which `cleanup_destination=true` dropped.
  Nothing re-applies them: there is no `GRANT ... ON SCHEMA` or
  `ALTER SCHEMA ... OWNER` anywhere in `infra/`, `services/` or
  `scripts/`.

Staging cannot show this. The staging profile restores with one role for
both schemas, so one DSN owning both is exactly right there — the
defect is invisible until the production profile's per-schema confined
service roles are in play.

**Verified, not inferred.** Reproducing the production topology in a
throwaway database — two per-schema confined roles, the real two-schema
archive dumped from the real source, then the harness sequence (drop both
schemas, restore through the tasks DSN with `--no-owner --no-acl`) —
produces:

```
owner of content_scheduler = <tasks role>      <- wrong
cs_role    USAGE  on content_scheduler = false
cs_role    CREATE on content_scheduler = false <- the service role cannot use its OWN schema
tasks_role USAGE  on content_scheduler = true  <- cross-schema access
```

The third line is the drift `neon.service-role-scope` exists to catch
(`infra/cloud/platform/production-operator-evidence.mjs`): each
production service role must write only inside its own schema and hold
no cross-schema access. The second line breaks `migrate.sh` step 4 and
`reconcile.mjs` step 5, which both use the content-scheduler DSN.

This was verified against the real source archive in a throwaway
database on the local prodlike container; the source was read-only and
production Neon was not reachable from the operator host, so the LIVE
production role names and grants still need a read-back against
production Neon (§3).

**Closing it — DONE (option 2, implemented).** Both options below are
harness changes. The drill runs the restore, the migrations and the
reconcile in ONE process and has no resume flag, so there is no
operator step that can run between the restore and the migrations:

1. **Re-apply ownership and grants at the end of the restore.** After
   `pg_restore`, run `ALTER SCHEMA tasks_api OWNER TO <tasks role>` and
   `ALTER SCHEMA content_scheduler OWNER TO <content-scheduler role>`,
   plus the matching `USAGE`/`CREATE` and table/sequence `GRANT`s. The
   `GRANT`s succeed when run as the tasks role — it owns the schema
   after the restore — but the `ALTER ... OWNER` does not: it fails with
   `must be able to SET ROLE "<content-scheduler role>"`. It needs a role
   that can SET ROLE both service roles (the Neon branch owner).
   **Do not** grant the tasks role membership of the content-scheduler
   role to get around this: it makes the `ALTER` work but leaves the
   tasks role holding cross-schema access on `content_scheduler`, which
   is exactly the drift `neon.service-role-scope` forbids.
2. **Restore per schema, with each schema pre-created by its real
   owner.** `pg_restore --schema=tasks_api` with the tasks DSN and
   `pg_restore --schema=content_scheduler` with the content-scheduler
   DSN. `pg_restore --schema=X` does NOT create the schema — it fails
   closed on its first statement with `schema "content_scheduler" does
   not exist` — so each schema must be pre-created first.

Option 2 is what ships. `restore.sh` now takes
`--destination-content-scheduler-dsn-file` and does the per-schema
restore. Each schema is created by `CREATE SCHEMA <name>;` run AS the
role that owns it — not `CREATE SCHEMA ... AUTHORIZATION`, so the role
needs no SET ROLE authority and no privileged operator role is
involved. The only privilege the service role needs is CREATE on the
destination database, which it must already hold to own the schema it
creates. `pg_restore --schema=<name>` then restores that role's own
objects through that role's own DSN.

Three things make this safe rather than merely different:

- **The end state is asserted, not assumed.** After the restore the
  script proves that each schema is owned by the role that restored it
  (`current_user` vs `pg_get_userbyid(nspowner)`), that each role can
  USE its own schema, and — when the two roles differ — that neither
  role holds USAGE on the other's schema. A wrong end state fails the
  restore loudly, at the one point that can see it, instead of
  surfacing one step later at `prisma migrate deploy` as
  `permission denied for schema content_scheduler`.
- **The same-role arrangement is refused in production.** Two
  destination DSNs that connect as the SAME role is the shape of the
  original defect, and it would pass every ownership assertion (the
  owner equals the connecting role either way). A production run
  refuses it outright; staging, which genuinely uses one role, records
  `singleRoleDestination: true` in the restore envelope.
- **The content-scheduler destination DSN is required.** There is no
  fallback to the old single-DSN path, so the defect cannot be
  reintroduced by omitting a flag.

Option 1, run with a role that can SET ROLE both service roles, was
verified to end with the correct owners, the content-scheduler role
holding USAGE and CREATE on its own schema, the tasks role holding no
cross-schema access, and every table restored. It is NOT what ships:
it needs a privileged role, and the membership workaround that makes
its `ALTER` work reintroduces the cross-schema drift.

### The three keys

A production run needs three independent keys, and no single one of them
can start a move:

1. **The `production` GitHub Environment.** Its reviewers are the
   approval gate. A dispatch that has not been approved never starts.
   This key is the only one the ENVIRONMENT enforces, so it is also the
   only one that can be silently inert — and it can be: an Environment
   with no protection rules has no reviewer, no approval, and a dispatch
   that starts unattended. The readiness check in §3 reads the
   Environment's protection rules and refuses to call the cutover ready
   while the gate is missing, empty, or admin-bypassable.
2. **The typed confirmation `MIGRATE PRODUCTION`.** This is what sets
   `CLOUD_DB_PRODUCTION_ACK=1`. The scripts require that variable; the
   workflow sets it only when the confirmation string matches exactly.
3. **The declared endpoints.** `source_host` and `destination_host` at
   dispatch time. The scripts refuse any endpoint outside that list, so
   a mistyped DSN in a secret cannot point the run at an undeclared
   database.

## 3. Prerequisites

All of the following must hold before the workflow is dispatched:

- task `fb1240c0` (provision the production environment) is `done` and
  its acceptance is recorded — including the Neon IP allowlist gate
  (AC2) and the Fly spend-bound ordering gate (AC5);
- the `production` GitHub Environment exists, has required reviewers
  configured, and carries the DSN secrets below;
- a maintenance window and a rollback decision point are agreed with
  Tom and recorded in the task;
- the source is quiesced — writes stopped or drained — for the
  duration of the run;
- **the schema-ownership gap in §2 is closed.** `restore.sh` restores per
  schema: each role creates its own schema and restores its own objects
  through its own DSN, and the resulting ownership and cross-schema
  isolation are asserted before the restore is allowed to succeed. See
  §2 "Closing it". This still needs a read-back of the LIVE production
  role names and grants against production Neon, because the
  verification in §2 was performed against a reproduction of the
  topology, not against production Neon itself;
- the operator has the runbook open next to the Actions tab.

### The readiness check (run it before dispatching)

Two of the prerequisites above are facts about the `production`
Environment that no operator can see from the Actions tab: whether its
**approval gate** is actually configured, and whether the six DSN
secrets are actually registered. The workflow fails closed on the
secrets (exit 11), but it fails at DISPATCH — on the operator's
machine, mid-procedure, naming no owner.

The readiness check moves both facts out of the dispatch moment:

```bash
# 1. capture the live production state (read-only; names, flags and
#    counts only — never a credential value)
node infra/cloud/scripts/capture-production-provisioning-state.mjs \
  --out /tmp/production-state.json

# 2. decide whether the cutover may be dispatched
node tests/cloud/scripts/check-production-cutover-readiness.mjs \
  /tmp/production-state.json
```

The checker exits 0 when the cutover may be dispatched and 1 when any
gate is unmet, naming the owner of each unmet gate. Its gates are:

| Gate | Met when |
|---|---|
| `github.production-environment-captured` | the `production` Environment could be read at all — an unreadable provider is an OPEN gate, not a pass |
| `github.cutover-dsn-secrets` | all six DSN secrets below are registered on the Environment |
| `github.production-approval-gate` | the Environment has at least one required reviewer and admins cannot bypass the gate |
| `neon.cutover-destination-database` | the production Neon environment serves at least one logical database, so the destination — the EXISTING production database that hosts the `tasks_api` and `content_scheduler` schemas — is real. The count is over DATABASES (a branch and a database name), not over endpoint hosts: a read replica is another address for the same database |

The last gate exists because a secret can be REGISTERED against a
database that does not exist. The workflow's secret check only asks
whether the secret is non-empty, so a DSN pointing at a database that was
never created passes that check and fails at the RESTORE — after the
dump, with the source already quiesced.

**The topology (Tom's execution decision, 2026-11-19).** The destination
is the EXISTING production Neon database — its `tasks_api` and
`content_scheduler` schemas — and no new permanent production database
is created for this cutover. The recovery target is a TEMPORARY,
isolated database used only to prove that a verified backup restores; it
is created for the run and dropped after it, and it is not counted by
the gate above. The obsolete "three distinct production databases"
requirement is gone: it asked the operator to create permanent
production databases the migration is explicitly forbidden from creating.

**The recovery target must be an EMPTY database, not a copy of
production.** `restore.sh` refuses any target that already holds objects
or that already holds either application schema, and it applies that
guard to the recovery target exactly as it does to the destination — the
recovery step runs the same script with the recovery DSNs as its
destination. A Neon branch *forked from the production branch* therefore
cannot be the recovery target: the fork carries the parent's rows AND
its schemas, so the recovery restore fails closed with "destination is
not empty" or "destination already contains schema(s)". "Isolated" means
a separate ENDPOINT, and it also means empty. Create the recovery target
as a NEW, EMPTY database and point `RECOVERY_*` at it; verify emptiness
before dispatch (see the check in §4).

**The destination is NOT empty, by design, and that is what
`cleanup_destination` is for.** The production destination is the live
production database that the production services already run against, so
it holds `tasks_api` and `content_scheduler` with their tables. The
restore's empty-target guard therefore refuses it unless the two
schemas are dropped first. `cleanup_destination=true` does exactly
that, and `pg_restore` recreates both schemas from the archive. This is
the normal path for a first production run — it is not a
"previous failed run" repair. See §4.

**The recovery target's isolation is enforced in code, not in prose.**
`drill.sh` reads the host out of each recovery DSN and refuses the run
when the recovery target shares a host with the source (which would
overwrite the rollback source) or with the destination (which would
reconcile the destination against itself). The workflow refuses a
`recovery_host` equal to the source or destination host, and requires it
to be declared: an undeclared recovery endpoint fails the run, so a
recovery target can never be an endpoint the operator did not name.

Two things about that gate decide how the operator closes it. The count
is over DATABASES, not over endpoint hosts: a Neon branch can carry a
read-write endpoint plus read-only replicas, and those replicas share
the branch's storage, so they are several addresses for ONE database.
Adding a read replica does not add a database to restore into. And the
destination and the recovery database must sit behind an endpoint OTHER
than the source's, because the dispatch refuses a destination behind the
source's host (exit 10) — so create a branch named `production-*` and
put the destination and recovery databases there.

Note that step 1 reads the Neon, Fly, GitHub and Cloudflare control
planes, so it needs those credentials in the operator's environment
(`NEON_API_KEY`, `FLY_API_TOKEN`, `GITHUB_TOKEN` or an authenticated
`gh`, `CLOUDFLARE_API_TOKEN`). A capture that cannot read a provider
records that provider as unreadable rather than skipping it, and the
checker turns the unreadable provider into an open gate — so a partial
capture can never read as "ready".

### Required secrets on the `production` GitHub Environment

| Secret | Purpose |
|---|---|
| `TASKS_API_SOURCE_DSN` | read-only DSN for source `tasks_api` |
| `CONTENT_SCHEDULER_API_SOURCE_DSN` | read-only DSN for source `content_scheduler` |
| `TASKS_API_DEST_DSN` | owner DSN for destination `tasks_api` |
| `CONTENT_SCHEDULER_API_DEST_DSN` | owner DSN for destination `content_scheduler` |
| `RECOVERY_TASKS_API_DSN` | owner DSN for the recovery target's `tasks_api` (only with `recovery=true`) |
| `RECOVERY_CONTENT_SCHEDULER_API_DSN` | owner DSN for the recovery target's `content_scheduler` (only with `recovery=true`) |

The two recovery secrets are separate owner DSNs and the drill consumes
them as two separate DSNs. `restore.sh` is given the recovery
`tasks_api` DSN as its destination and re-checks that endpoint's
emptiness; the recovery `content_scheduler` DSN is passed to
`migrate.sh` and `reconcile.mjs` with no emptiness guard applied by any
script. Check BOTH before dispatching — see the §4 pre-dispatch check.

The workflow writes each DSN to a mode-`0600` file in the runner's temp
directory before the scripts run. The scripts accept file paths only —
never positional DSNs — and never log a DSN, a partial URL, or a token
byte.

## 4. The cutover sequence (happy path)

1. Verify the prerequisites in §3 and record the agreed window in the
   task.
2. Quiesce the source. Take the final pre-cutover row-count snapshot
   if one has not already been captured.
3. Dispatch the workflow with:
   - `confirm_production` = `MIGRATE PRODUCTION`
   - `source_host` = the source endpoint's `host[:port]`, exactly as it
     appears in the source DSN
   - `destination_host` = the destination endpoint's `host[:port]`
   - `recovery` = `true` when AC3 backup evidence is being captured in
     the same window
   - `recovery_host` = the recovery target's `host[:port]`, required when
     `recovery` is `true`. It must differ from `source_host` and
     `destination_host` — the workflow and the drill both refuse a
     recovery target that shares a host with either
   - `interruption` = `none`
   - `cleanup_destination` = `true` for a production run whose
     destination is the existing production database. The destination is
     populated by the live production services, so the restore's
     empty-target guard refuses it unless the two schemas are dropped
     first; `cleanup_destination=true` drops them and `pg_restore`
     recreates them from the archive. Set it to `false` only when the
     destination is already empty of both schemas (a repeated run into a
     destination that a prior run cleaned and never repopulated).

   When `recovery` is `true`, verify the recovery target is EMPTY before
   dispatching. This is a read-only check; it prints counts and schema
   names, never a DSN.

   **Run it against BOTH recovery DSNs.** The two recovery secrets are
   separate owner DSNs (`RECOVERY_TASKS_API_DSN` and
   `RECOVERY_CONTENT_SCHEDULER_API_DSN`, §9), and the drill consumes
   them as two separate DSNs: `drill.sh` asserts the recovery isolation
   for the recovery tasks host and the recovery content-scheduler host
   independently, and nothing requires the two to be the same database
   (`cleanup-destination.sh` asserts source-vs-destination inequality
   for the destination pair, but no such assertion exists for the
   recovery pair).

   They are also not guarded equally:

   - `drill.sh` step 6 calls `restore.sh --destination-dsn-file
     "$RECOVERY_TASKS_FILE"`, so the restore's empty-target guard
     re-checks the **tasks** endpoint itself and fails closed there.
   - The **content-scheduler** recovery DSN is passed to `migrate.sh`
     and `reconcile.mjs`, and no script applies the empty-target guard
     to it. The check below is the only guard on that endpoint.

   ```bash
   # Set these from the §9 secrets. An unset value must abort the
   # check rather than fall through: `psql ""` connects to the local
   # default database and would print 0 and an empty schema list —
   # a false pass on a target nobody checked.
   : "${RECOVERY_TASKS_API_DSN:?RECOVERY_TASKS_API_DSN is not set}"
   : "${RECOVERY_CONTENT_SCHEDULER_API_DSN:?RECOVERY_CONTENT_SCHEDULER_API_DSN is not set}"

   # must print 0 and an empty schema list, for EACH recovery DSN

   # 1) tasks recovery endpoint — also re-checked by restore.sh at restore time
   psql "$RECOVERY_TASKS_API_DSN" --no-psqlrc --tuples-only --no-align \
     --command="SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('tasks_api','content_scheduler','public');"
   psql "$RECOVERY_TASKS_API_DSN" --no-psqlrc --tuples-only --no-align \
     --command="SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('tasks_api','content_scheduler');"

   # 2) content_scheduler recovery endpoint — no script guards this one
   psql "$RECOVERY_CONTENT_SCHEDULER_API_DSN" --no-psqlrc --tuples-only --no-align \
     --command="SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('tasks_api','content_scheduler','public');"
   psql "$RECOVERY_CONTENT_SCHEDULER_API_DSN" --no-psqlrc --tuples-only --no-align \
     --command="SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('tasks_api','content_scheduler');"
   ```

   A non-zero table count or a non-empty schema list on **either**
   endpoint means the recovery target is not a fresh database. On the
   tasks endpoint the recovery restore fails closed; on the
   content-scheduler endpoint nothing in the harness fails closed — the
   check above is the only thing that catches it, and only before the
   destination has already been migrated and reconciled. Fix the target,
   not the harness.

4. The workflow runs `drill.sh --environment production`, which executes
   in order:
   - `inventory.sh` — server version, schemas, extensions, relation
     counts, Prisma migration state, source activity;
   - `assert-source-schema-matches-model.sh` — read-only gate: the
     source schema's table inventory must match the Prisma model the
     repository declares for the service that owns it. It runs BEFORE
     the destination cleanup, so a source carrying unmodelled tables
     refuses while the live destination is still intact;
   - `dump.sh` — custom-format archive, verified with
     `pg_restore --list`, sha256, atomic rename;
   - `restore.sh` — restores into the destination, refuses a
     non-empty destination, verifies both schemas exist afterwards;
   - `migrate.sh` — `prisma migrate deploy` for `tasks-api` and
     `content-scheduler-api`, refusing to run over failed migrations;
   - `reconcile.mjs` — service-owned reconciliation manifests, count
     comparison, primary-key digest comparison, `verdict=PASS|FAIL`;
   - `manifest.sh` — the evidence manifest (step 8 in `drill.sh`).
5. Download the `cloud-production-db-cutover-<run-id>` artifact bundle
   and archive it per §7.
6. If the verdict is `PASS`, the run is complete; record the evidence
   in the task.

## 5. Failure, interruption and safe retry (AC4)

| Failure | What the scripts do | Operator action |
|---|---|---|
| `pg_dump` fails or the archive does not parse | the `.partial` is removed; the source is never written to | fix the cause, re-dispatch with a fresh run id |
| `pg_restore` fails mid-way | the destination is left partially restored; the source is untouched | re-dispatch with `cleanup_destination=true` so the two schemas are dropped and recreated by `pg_restore` itself |
| the source schema carries a table the repository does not model | the gate refuses before the destination cleanup, so the live destination is untouched; the refusal names each unmodelled table and its row count | decide what the stray table is (left-over from a rolled-back migration, or orphaned by the schema split). Clean it from the source, or model it deliberately. Do not re-dispatch until the source matches the model |
| `prisma migrate deploy` fails | the run stops before reconciliation; the failed migration stays recorded in `_prisma_migrations` | resolve the migration, then re-run from the dump step |
| reconciliation reports a mismatch | the drill exits non-zero before the run is declared `PASS` | **halt.** Compare the envelopes, decide whether to re-dump, then re-dispatch |
| the runner loses connectivity | the scripts fail closed; nothing is half-written | re-dispatch with a fresh run id; the destination is rebuilt from the archive |

**Safe retry rules.**

- Nothing in the harness ever writes to the source. The source is
  read-only for the whole run.
- The destination is rebuilt from the archive on every attempt. There is
  no incremental merge step, so a retry cannot double-write rows.
- A retry always uses a fresh run id. The run id is part of the
  artefact names and of the manifest, so two runs can never be confused
  for one.
- A failed attempt's artefacts stay in place for inspection until the
  operator has captured the evidence. `cleanup_destination` is the only
  destructive action, and it needs two keys of its own.

**Interruption drills.** `interruption=dump` or `interruption=restore`
exercises the bounded failure path on the real run. Both leave the
partial artefact in place for forensic inspection and exit non-zero.
They are AC4 evidence, not a way to attempt a real migration — do not
run them against a live destination outside a deliberate drill window.

## 6. Go / no-go criteria

| Phase | Go | No-go |
|---|---|---|
| Pre-flight | every prerequisite in §3 met; the readiness check in §3 exits 0; `production` Environment approved; confirmation string exact; source and destination hosts declared and different; PostgreSQL client major = 18 | any missing secret, a readiness gate unmet, wrong confirmation, undeclared endpoint, wrong client major |
| Inventory | source reachable, both schemas present, `_prisma_migrations` present | source unreachable, schema missing, no migration table |
| Dump | `pg_dump` exits 0, `pg_restore --list` parses the archive, sha256 computed | any of the three post-dump checks fails |
| Restore | destination was empty pre-restore (in production, that means `cleanup_destination=true` dropped both schemas first — the raw destination is NOT empty, because it is the live production database), both schemas present post-restore, `pg_restore --exit-on-error` exits 0 | destination non-empty pre-restore, missing schema post-restore, restore non-zero, **or `content_scheduler` is not owned by the content-scheduler service role after the restore** (§2 — the harness cannot produce a correct production end state without one of the two fixes listed there) |
| Migrations | `prisma migrate deploy` exits 0 for both services, no failed or pending rows | any failed row, any unexpected pending row |
| Reconcile | `verdict=PASS`, every check matches, every digest matches | any check mismatch, any digest mismatch |
| Manifest | `manifest.json` lists every artefact with its digest and the reconcile verdict | manifest missing an artefact, or a reconcile verdict that is not `PASS` |

## 7. Evidence

Every run produces, in the artifact directory:

- `inventory-<run-id>.json` — source state, no row contents;
- `<run-id>.dump` + `.sha256` — the archive and its digest;
- `dump-<run-id>.json` — the dump envelope;
- `restore-<run-id>.json` + `.log` — the restore envelope and the
  `pg_restore` log;
- `migrate-<run-id>.json` + per-service logs — the migration state
  before and after;
- `reconcile-<run-id>.json` — per-check source/destination counts,
  deltas, and the primary-key digest match flag;
- `drill-<run-id>.json` — the run envelope;
- `manifest-<run-id>.json` — the digest of every artefact above plus
  the rolled-up verdict.

The manifest is the single file to attach to the task. The archive
itself belongs in the encrypted object store, not in a GitHub artifact;
the manifest records its digest so the two can be tied together later.

## 8. Rollback

Rollback is a source-side decision, not a script:

1. The destination is **not** dropped automatically. It is preserved for
   forensics.
2. If the cutover has not yet repointed the applications, the correct
   rollback is to leave the applications on the source and re-run the
   transfer after fixing the cause.
3. If the applications have already been repointed to the destination,
   repoint them back to the source, restart, and re-run the smoke
   checks against the source before declaring the incident closed.

The harness never repoints an application. Application repointing is a
separate, operator-driven step recorded in the task.

## 9. Credential handling

- The DSN secrets on the `production` GitHub Environment are rotated by
  Quinn. A rotation invalidates any in-flight run; re-dispatch after
  the rotation.
- **The six DSN secrets must be raw libpq URLs with no `?schema=`
  parameter.** `psql`, `pg_dump` and `pg_restore` consume these DSNs
  directly and reject an unknown URI query parameter, and `migrate.sh`
  appends the Prisma `?schema=` parameter itself when it invokes each
  service's migration. A DSN that already carries `?schema=` therefore
  fails at the first `psql` call rather than at the migration step.
- **The recovery DSNs must point at a NEW EMPTY database** — see §3. The
  workflow only checks that the secret is non-empty, so a DSN pointing
  at a populated database passes the dispatch check and fails at the
  restore, after the destination has already been migrated.
- The DSN files written by the workflow live in the ephemeral runner
  temp directory and are destroyed with the runner.
- The scripts redact DSNs, `password=`, `DATABASE_URL=` and every
  `PRISMA_*` variable from every log line they write.
- No DSN, endpoint credential or token byte is ever written into an
  artefact envelope, the manifest, or the task comment.

## 10. Escalation

If a run fails in a way §5 and §6 do not cover, escalate via:

- the `cron-revert` Slack channel (Quinn's standard escalation lane);
- or, for security-sensitive findings, the `security` channel.

An escalation must include: the run id, the failing phase, the
artefact path, the manifest digest, and a link to the task. Never paste
a DSN into a channel — quote the artefact path instead.
