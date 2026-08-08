#!/usr/bin/env -S npx tsx --require @sindustries/otel-node/register
/*
 * migrate-legacy-approvals.ts
 *
 * One-shot migration script that reads the legacy approval state that lives
 * in task descriptions and comment bodies, and writes equivalent TaskApproval
 * rows through the canonical POST /tasks/:id/approvals endpoint.
 *
 * Sources of legacy approval state:
 *   - `**Approved by Tom**` (checked) in description    -> spec, owner=Tom
 *   - `[tech-design-approved] true` in a comment          -> tech_design, owner=comment.author
 *   - `[qa-ac-verified] true` in a comment                -> qa, owner=comment.author
 *   - `- [ ] **Approved by Tom**` (unchecked) in desc    -> no spec row (correctly absent)
 *
 * The script is idempotent on (taskId, type): if a row already exists, the
 * existing row is left untouched and counted under `skippedExisting`.
 *
 * Modes:
 *   --dry-run                                Algorithm runs, summary printed, no DB writes.
 *   --write                                  Algorithm runs, summary printed, writes go through POST /tasks/:id/approvals.
 *                                            A snapshot of the row set is saved to .openclaw/tasks-api/snapshots/<timestamp>.json
 *                                            so a future --rollback can restore.
 *   --rollback <snapshot-path>               Drops every TaskApproval row whose (taskId, type) appears in the snapshot.
 *                                            Use only after a migration that needs to be reversed.
 *
 * Examples:
 *   tsx scripts/migrate-legacy-approvals.ts --dry-run
 *   tsx scripts/migrate-legacy-approvals.ts --write
 *   tsx scripts/migrate-legacy-approvals.ts --rollback .openclaw/tasks-api/snapshots/2026-08-08T05-00-00.json
 *
 * Required env:
 *   TASKS_API_BASE_URL   default http://localhost:4001
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, exit } from 'node:process';
import type { DetectedApproval } from '../src/lib/legacyApprovals.ts';
import {
  runDryRun,
  runRollback,
  runWrite,
  type ApprovalType,
  type MigrationDeps,
  type MigrationTask
} from '../src/lib/migrateLegacyApprovals.ts';

const BASE_URL = (env.TASKS_API_BASE_URL ?? 'http://localhost:4001').replace(/\/$/, '');

function parseArgs() {
  const args = argv.slice(2);
  const flags = {
    dryRun: false,
    write: false,
    rollback: null as string | null
  };

  for (const arg of args) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--write') flags.write = true;
    else if (arg.startsWith('--rollback=')) flags.rollback = arg.slice('--rollback='.length);
    else if (arg === '--rollback') {
      const next = args[args.indexOf(arg) + 1];
      if (!next) throw new Error('--rollback requires a snapshot path argument');
      flags.rollback = next;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!flags.dryRun && !flags.write && !flags.rollback) {
    throw new Error('one of --dry-run, --write, or --rollback <path> is required');
  }
  if ((flags.dryRun ? 1 : 0) + (flags.write ? 1 : 0) + (flags.rollback ? 1 : 0) > 1) {
    throw new Error('only one of --dry-run, --write, or --rollback may be passed');
  }
  return flags;
}

function printHelp() {
  console.log(
    [
      'migrate-legacy-approvals.ts',
      '',
      'Modes:',
      '  --dry-run                            Print summary, no DB writes.',
      '  --write                              Write via POST /tasks/:id/approvals; save a snapshot.',
      '  --rollback <snapshot-path>           Drop rows from a prior snapshot.',
      '',
      'Env:',
      '  TASKS_API_BASE_URL   default http://localhost:4001'
    ].join('\n')
  );
}

export async function fetchTaskListIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const url = new URL(`${BASE_URL}/api/v1/tasks`);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`GET /tasks ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    };
    ids.push(...body.data.map((task) => task.id));
    if (!body.page.nextCursor) break;
    cursor = body.page.nextCursor;
  }

  return ids;
}

export async function fetchTaskById(id: string): Promise<MigrationTask> {
  const response = await fetch(`${BASE_URL}/api/v1/tasks/${id}`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`GET /tasks/${id} ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { data: MigrationTask };
  return body.data;
}

// GET /api/v1/tasks (list) never populates `comments` on each row — only
// GET /api/v1/tasks/:id returns the full task including comments. The
// migration script's legacy-detection logic reads `task.comments` to find
// `[tech-design-approved] true` / `[qa-ac-verified] true`, so a naive list
// fetch silently misses every legacy tech_design/qa approval (spec
// approvals still get detected because `description` IS present on the
// list response). Fetch the id list first, then hydrate each task
// individually so detection sees real comment bodies.
//
// See docs/systems/... list-endpoint comment gap, also hit previously in
// the tech-design-approval heartbeat check (sindustries PR #295).
export async function fetchAllTasks(): Promise<MigrationTask[]> {
  const ids = await fetchTaskListIds();
  const tasks: MigrationTask[] = [];
  for (const id of ids) {
    tasks.push(await fetchTaskById(id));
  }
  return tasks;
}

async function postApproval(taskId: string, approval: DetectedApproval): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(approval)
  });
  if (!response.ok) {
    throw new Error(`POST /tasks/${taskId}/approvals ${response.status}: ${await response.text()}`);
  }
}

async function deleteApproval(taskId: string, type: ApprovalType): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/approvals/${type}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`DELETE /tasks/${taskId}/approvals/${type} ${response.status}: ${await response.text()}`);
  }
}

function snapshotPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(env.HOME ?? '/tmp', '.openclaw/tasks-api/snapshots');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${ts}.json`);
}

function ensureSnapshotDir(path: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
}

const defaultDeps: MigrationDeps = {
  fetchAllTasks,
  postApproval,
  deleteApproval,
  writeFile: (path, content) => writeFileSync(path, content),
  readFile: (path) => readFileSync(path, 'utf8'),
  ensureDir: ensureSnapshotDir
};

async function main() {
  const flags = parseArgs();
  let summary;

  if (flags.rollback) {
    summary = await runRollback(defaultDeps, flags.rollback);
  } else if (flags.dryRun) {
    summary = await runDryRun(defaultDeps);
  } else {
    summary = await runWrite(defaultDeps, snapshotPath);
  }

  console.log(JSON.stringify(summary, null, 2));
}

// Only auto-run when executed directly (`tsx scripts/migrate-legacy-approvals.ts ...`),
// not when imported as a module (e.g. from tests importing `fetchAllTasks` /
// `fetchTaskListIds` / `fetchTaskById` directly). Without this guard, importing
// the module runs `main()` with the importer's argv, hits the "one of --dry-run,
// --write, or --rollback is required" error, and calls `exit(1)`, killing the
// process that imported it (e.g. a test worker).
const isMain = argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[migrate-legacy-approvals] failed:', err);
    exit(1);
  });
}