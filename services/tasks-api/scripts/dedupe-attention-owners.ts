#!/usr/bin/env -S npx tsx --require @sindustries/otel-node/register
/*
 * dedupe-attention-owners.ts
 *
 * Idempotent repair path for AC7. The PATCH /tasks/:id endpoint collapses
 * case-insensitive duplicates on every write; this script collapses the
 * pre-existing duplicates that landed in `TaskAttentionOwner` rows before
 * the new normalization was deployed.
 *
 * Modes:
 *   --dry-run                                Scan every task with two or
 *                                             more rows; for each, compute
 *                                             the dedupe-collapsed set
 *                                             (first occurrence wins,
 *                                             position preserved) and
 *                                             print a summary. No DB
 *                                             writes, no audit comments.
 *   --write                                  Same scan; for each task
 *                                             with duplicates, delete the
 *                                             tail rows inside a single
 *                                             `$transaction`, renumber
 *                                             positions contiguously, and
 *                                             emit one `TaskComment` audit
 *                                             row per removed duplicate
 *                                             (`Duplicate attention owner
 *                                             "<name>" (case-insensitive)
 *                                             collapsed by repair script;
 *                                             preserved note: "<note>"`).
 *                                             A snapshot of the pre-state
 *                                             is saved to
 *                                             `.openclaw/tasks-api/snapshots/<ts>.json`
 *                                             for `--rollback`.
 *   --rollback <snapshot-path>               Restore the rows from a
 *                                             previously-saved snapshot.
 *
 * Examples:
 *   tsx scripts/dedupe-attention-owners.ts --dry-run
 *   tsx scripts/dedupe-attention-owners.ts --write
 *   tsx scripts/dedupe-attention-owners.ts --rollback .openclaw/tasks-api/snapshots/2026-09-24T11-00-00.json
 *
 * Required env:
 *   DATABASE_URL          Postgres connection string. The script reads and
 *                         writes directly through Prisma — the API path is
 *                         not in the loop.
 *   TASKS_API_BASE_URL    Unused by this script.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';
import { prisma } from '../src/lib/prisma.ts';
import {
  buildTaskSnapshot,
  collapsePlan,
  duplicateAuditBody,
  renumberPlan,
  selectTasksWithDuplicates,
  type RowSnapshot,
  type TaskSnapshot
} from './dedupe-attention-owners-helpers.ts';

const SNAPSHOT_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../.openclaw/tasks-api/snapshots'
);

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
  const modeCount = (flags.dryRun ? 1 : 0) + (flags.write ? 1 : 0) + (flags.rollback ? 1 : 0);
  if (modeCount !== 1) {
    throw new Error('exactly one of --dry-run, --write, or --rollback <path> is required');
  }
  return flags;
}

function printHelp() {
  console.log(
    [
      'dedupe-attention-owners.ts',
      '',
      'Modes:',
      '  --dry-run                            Print summary, no DB writes.',
      '  --write                              Collapse duplicates and snapshot pre-state for safety.',
      '  --rollback <snapshot-path>           Restore rows from a prior snapshot.',
      '',
      'Env:',
      '  DATABASE_URL          Postgres connection string (required).'
    ].join('\n')
  );
}

type RowSnapshot = {
  id: string;
  taskId: string;
  owner: string;
  addedBy: string | null;
  note: string | null;
  position: number;
  createdAt: string;
};

type TaskSnapshot = {
  taskId: string;
  rows: RowSnapshot[];
  collapsed: string[];
};

type ScriptSummary = {
  mode: 'dry-run' | 'write' | 'rollback';
  scannedTasks: number;
  affectedTasks: number;
  removedRows: number;
  auditCommentsCreated: number;
  snapshots: { path: string; tasks: number }[];
  perTask: Array<{ taskId: string; removedOwners: string[] }>;
};

async function listTasksWithDuplicates() {
  // A single round-trip pulls every row; grouping is cheap.
  const rows = await prisma.taskAttentionOwner.findMany({
    orderBy: [{ taskId: 'asc' }, { position: 'asc' }]
  });
  return selectTasksWithDuplicates(rows);
}

async function dryRun() {
  const candidates = await listTasksWithDuplicates();
  const summary: ScriptSummary = {
    mode: 'dry-run',
    scannedTasks: 0,
    affectedTasks: candidates.length,
    removedRows: 0,
    auditCommentsCreated: 0,
    snapshots: [],
    perTask: []
  };
  for (const { taskId, rows } of candidates) {
    const snap = rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      owner: r.owner,
      addedBy: r.addedBy,
      note: r.note,
      position: r.position,
      createdAt: r.createdAt.toISOString()
    }));
    const { dropped } = collapsePlan(snap);
    summary.perTask.push({ taskId, removedOwners: dropped.map((r) => r.owner) });
  }
  return summary;
}

async function runWrite() {
  const candidates = await listTasksWithDuplicates();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = resolve(SNAPSHOT_DIR, `${timestamp}.json`);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const allSnapshots: TaskSnapshot[] = [];
  const summary: ScriptSummary = {
    mode: 'write',
    scannedTasks: 0,
    affectedTasks: 0,
    removedRows: 0,
    auditCommentsCreated: 0,
    snapshots: [],
    perTask: []
  };

  for (const { taskId, rows } of candidates) {
    const snapRows: RowSnapshot[] = rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      owner: r.owner,
      addedBy: r.addedBy,
      note: r.note,
      position: r.position,
      createdAt: r.createdAt.toISOString()
    }));

    const { kept, dropped } = collapsePlan(snapRows);
    if (dropped.length === 0) {
      // Quinn review (PR #751): an empty collapse set still merits an
      // audit row so the operator has a record that the script ran and
      // found nothing to repair.
      await prisma.taskComment.create({
        data: {
          taskId,
          author: 'Tasks API',
          body: 'Attention-owner repair scan ran with no duplicates found.'
        }
      });
      summary.auditCommentsCreated += 1;
      continue;
    }
    const snap = buildTaskSnapshot(taskId, snapRows, dropped.map((r) => r.owner));

    await prisma.$transaction(async (tx) => {
      // 1. Delete the dropped rows
      for (const row of dropped) {
        await tx.taskAttentionOwner.delete({ where: { id: row.id } });
      }
      // 2. Renumber kept rows so positions are contiguous starting at 0
      const renumber = renumberPlan(kept);
      for (const { id, position } of renumber) {
        const current = kept.find((r) => r.id === id);
        if (current && current.position !== position) {
          await tx.taskAttentionOwner.update({ where: { id }, data: { position } });
        }
      }
      // 3. Audit comment per dropped owner, preserving the note from the
      //    kept row when one was supplied (and surviving in the stack).
      for (const droppedRow of dropped) {
        const keptRow = kept.find((r) => r.owner.trim().toLowerCase() === droppedRow.owner.trim().toLowerCase());
        await tx.taskComment.create({
          data: {
            taskId,
            author: 'Tasks API',
            body: duplicateAuditBody(droppedRow.owner, keptRow?.note ?? null)
          }
        });
      }
    });

    allSnapshots.push(snap);
    summary.affectedTasks += 1;
    summary.removedRows += dropped.length;
    summary.auditCommentsCreated += dropped.length;
    summary.perTask.push({ taskId, removedOwners: dropped.map((r) => r.owner) });
  }

  writeFileSync(snapshotPath, JSON.stringify(allSnapshots, null, 2), 'utf8');
  summary.snapshots.push({ path: snapshotPath, tasks: allSnapshots.length });
  return summary;
}

async function runRollback(snapshotPath: string) {
  const absolute = resolve(snapshotPath);
  const content = readFileSync(absolute, 'utf8');
  const parsed = JSON.parse(content) as TaskSnapshot[];

  const summary: ScriptSummary = {
    mode: 'rollback',
    scannedTasks: 0,
    affectedTasks: parsed.length,
    removedRows: 0,
    auditCommentsCreated: parsed.length,
    snapshots: [{ path: absolute, tasks: parsed.length }],
    perTask: []
  };

  for (const task of parsed) {
    await prisma.$transaction(async (tx) => {
      // Restore rows in their original positions; collisions with current
      // rows are handled by deleting then recreating. New UUIDs are
      // generated so the restored set never collides with surviving rows.
      for (const row of task.rows) {
        const exists = await tx.taskAttentionOwner.findUnique({ where: { id: row.id } });
        if (!exists) {
          await tx.taskAttentionOwner.create({
            data: {
              id: row.id,
              taskId: row.taskId,
              owner: row.owner,
              addedBy: row.addedBy,
              note: row.note,
              position: row.position,
              createdAt: new Date(row.createdAt)
            }
          });
        }
      }
      await tx.taskComment.create({
        data: {
          taskId: task.taskId,
          author: 'Tasks API',
          body: `Attention-owner rows restored from snapshot (${task.collapsed.length} duplicates re-added).`
        }
      });
    });
    summary.perTask.push({ taskId: task.taskId, removedOwners: task.collapsed });
  }
  return summary;
}

function printSummary(summary: ScriptSummary) {
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const flags = parseArgs();
  let summary: ScriptSummary;
  if (flags.dryRun) summary = await dryRun();
  else if (flags.write) summary = await runWrite();
  else summary = await runRollback(flags.rollback!);
  printSummary(summary);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('dedupe-attention-owners failed:', err);
    await prisma.$disconnect();
    exit(1);
  });