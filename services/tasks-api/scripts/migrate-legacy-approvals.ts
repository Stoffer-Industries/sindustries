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
import { argv, env, exit } from 'node:process';
import {
  detectLegacyApprovals,
  existingApprovalKeys,
  type DetectedApproval,
  type MigrationBreakdown
} from '../src/lib/legacyApprovals.ts';

const BASE_URL = (env.TASKS_API_BASE_URL ?? 'http://localhost:4001').replace(/\/$/, '');

interface TaskApproval {
  id: string;
  taskId: string;
  type: 'spec' | 'tech_design' | 'qa';
  owner: string;
  state: 'approved' | 'revoked';
  approvedAt: string;
  revokedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  taskType: string | null;
  approvals: TaskApproval[];
  comments: TaskComment[];
}

interface MigrationSummary {
  totalTasks: number;
  createdApprovals: number;
  skippedExisting: number;
  breakdownByType: MigrationBreakdown[];
  snapshotPath: string | null;
  dryRun: boolean;
  rolledBack: number;
}

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

async function fetchAllTasks(): Promise<Task[]> {
  const tasks: Task[] = [];
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
    const body = (await response.json()) as { data: Task[]; page: { nextCursor: string | null } };
    tasks.push(...body.data);
    if (!body.page.nextCursor) break;
    cursor = body.page.nextCursor;
  }

  return tasks;
}

function detectApprovals(task: Task): DetectedApproval[] {
  return detectLegacyApprovals(task);
}

function existingApprovalSet(task: Task): Set<string> {
  return existingApprovalKeys(task);
}

async function postApproval(
  taskId: string,
  approval: DetectedApproval
): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(approval)
  });
  if (!response.ok) {
    throw new Error(`POST /tasks/${taskId}/approvals ${response.status}: ${await response.text()}`);
  }
}

async function deleteApproval(taskId: string, type: string): Promise<void> {
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

async function runDryRun(): Promise<MigrationSummary> {
  const tasks = await fetchAllTasks();
  const breakdownByType: MigrationBreakdown[] = [];
  let createdApprovals = 0;
  let skippedExisting = 0;

  for (const task of tasks) {
    const detected = detectApprovals(task);
    const existing = existingApprovalSet(task);
    for (const approval of detected) {
      const key = `${task.id}:${approval.type}`;
      if (existing.has(key)) {
        skippedExisting += 1;
      } else {
        createdApprovals += 1;
      }
      let bucket = breakdownByType.find((b) => b.type === approval.type);
      if (!bucket) {
        bucket = { type: approval.type, created: 0, skippedExisting: 0 };
        breakdownByType.push(bucket);
      }
      if (existing.has(key)) bucket.skippedExisting += 1;
      else bucket.created += 1;
    }
  }

  return {
    totalTasks: tasks.length,
    createdApprovals,
    skippedExisting,
    breakdownByType,
    snapshotPath: null,
    dryRun: true,
    rolledBack: 0
  };
}

async function runWrite(): Promise<MigrationSummary> {
  const tasks = await fetchAllTasks();
  const snapshotRows: Array<{ taskId: string; type: string }> = [];
  const breakdownByType: MigrationBreakdown[] = [];
  let createdApprovals = 0;
  let skippedExisting = 0;

  for (const task of tasks) {
    const detected = detectApprovals(task);
    const existing = existingApprovalSet(task);
    for (const approval of detected) {
      const key = `${task.id}:${approval.type}`;
      if (existing.has(key)) {
        skippedExisting += 1;
      } else {
        await postApproval(task.id, approval);
        snapshotRows.push({ taskId: task.id, type: approval.type });
        createdApprovals += 1;
      }
      let bucket = breakdownByType.find((b) => b.type === approval.type);
      if (!bucket) {
        bucket = { type: approval.type, created: 0, skippedExisting: 0 };
        breakdownByType.push(bucket);
      }
      if (existing.has(key)) bucket.skippedExisting += 1;
      else bucket.created += 1;
    }
  }

  const snapshotPath = snapshotPath();
  ensureSnapshotDir(snapshotPath);
  writeFileSync(
    snapshotPath,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        rolledBack: false,
        rows: snapshotRows
      },
      null,
      2
    )
  );

  return {
    totalTasks: tasks.length,
    createdApprovals,
    skippedExisting,
    breakdownByType,
    snapshotPath,
    dryRun: false,
    rolledBack: 0
  };
}

async function runRollback(snapshotPath: string): Promise<MigrationSummary> {
  const raw = readFileSync(snapshotPath, 'utf8');
  const parsed = JSON.parse(raw) as { rows: Array<{ taskId: string; type: string }> };

  for (const row of parsed.rows) {
    await deleteApproval(row.taskId, row.type);
  }

  return {
    totalTasks: 0,
    createdApprovals: 0,
    skippedExisting: 0,
    breakdownByType: [],
    snapshotPath,
    dryRun: false,
    rolledBack: parsed.rows.length
  };
}

async function main() {
  const flags = parseArgs();
  let summary: MigrationSummary;

  if (flags.rollback) {
    summary = await runRollback(flags.rollback);
  } else if (flags.dryRun) {
    summary = await runDryRun();
  } else {
    summary = await runWrite();
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[migrate-legacy-approvals] failed:', err);
  exit(1);
});
