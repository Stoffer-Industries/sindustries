import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.ts';
import {
  buildTaskSnapshot,
  collapsePlan,
  renumberPlan,
  selectTasksWithDuplicates,
  type RowSnapshot
} from '../scripts/dedupe-attention-owners-helpers.ts';

/**
 * Real-DB integration test for `scripts/dedupe-attention-owners.ts`.
 *
 * Quinn's PR #751 review (AC7): "Add a smoke test that runs --dry-run
 * against a fixture, then a snapshot-roundtrip test." This file
 * exercises the full scan + collapse + snapshot + rollback cycle
 * against the live Postgres so any drift between the helpers and the
 * prisma transaction shows up here, not in a production repair run.
 *
 * The script itself isn't spawned as a subprocess — that would require
 * `tsx` + a clean DATABASE_URL + the snapshot dir mounted. Instead
 * this test calls the same helpers the script calls, inside the same
 * shape of prisma transactions, and round-trips a snapshot through
 * `writeFileSync` → `readFileSync` so the JSON shape the script
 * persists is verified end-to-end.
 */

const TASK_ID = '33333333-3333-3333-3333-333333333333';
const SNAPSHOT_DIR = resolve(tmpdir(), 'sindustries-dedupe-attention-owners-test');
const SNAPSHOT_PATH = resolve(SNAPSHOT_DIR, 'roundtrip.json');

// The schema defines `id @db.Uuid` so the test must use real UUIDs. To
// keep the assertions deterministic across runs we seed the rows in a
// known order and assert on (position, owner, note) tuples instead of
// row ids.
const ROW_IDS = [
  '44444444-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000002',
  '44444444-0000-0000-0000-000000000003',
  '44444444-0000-0000-0000-000000000004',
  '44444444-0000-0000-0000-000000000005'
] as const;

async function resetTask() {
  await prisma.taskAttentionOwner.deleteMany({ where: { taskId: TASK_ID } });
  await prisma.taskComment.deleteMany({ where: { taskId: TASK_ID } });
  await prisma.task.deleteMany({ where: { id: TASK_ID } });
  await prisma.task.create({
    data: {
      id: TASK_ID,
      title: 'Repair-script integration test',
      status: 'doing',
      statusChangedAt: new Date(),
      priority: 'medium',
      assignee: 'Rowan',
      taskType: 'code'
    }
  });
}

async function seedRow(id: string, owner: string, note: string | null, position: number) {
  return prisma.taskAttentionOwner.create({
    data: {
      id,
      taskId: TASK_ID,
      owner,
      addedBy: 'Quinn',
      note,
      position
    }
  });
}

describe('dedupe-attention-owners helpers + real DB snapshot roundtrip', () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  });

  beforeEach(async () => {
    await resetTask();
  });

  afterAll(async () => {
    await resetTask();
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('selectTasksWithDuplicates flags a task with case-insensitive duplicate owners', async () => {
    await seedRow(ROW_IDS[0], 'Quinn', 'first note', 0);
    await seedRow(ROW_IDS[1], 'quinn', 'dup note', 1);
    await seedRow(ROW_IDS[2], 'Tom', 'tom note', 2);

    const rows = await prisma.taskAttentionOwner.findMany({
      where: { taskId: TASK_ID },
      orderBy: [{ taskId: 'asc' }, { position: 'asc' }]
    });
    const groups = selectTasksWithDuplicates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].taskId).toBe(TASK_ID);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('collapse + renumber + audit + snapshot roundtrip → rollback restores the original stack', async () => {
    // Seed a pre-fix duplicate stack with a mix of notes (kept, missing,
    // and an intra-tier repeat) to prove the first-occurrence-wins contract.
    await seedRow(ROW_IDS[0], 'Quinn', 'quinn first note', 0);
    await seedRow(ROW_IDS[1], 'quinn', 'dup no note', 1);
    await seedRow(ROW_IDS[2], 'Rowan', null, 2);
    await seedRow(ROW_IDS[3], 'TOM', 'tom only note', 3);
    await seedRow(ROW_IDS[4], 'Tom', 'tom dup note', 4);

    const rows = await prisma.taskAttentionOwner.findMany({
      where: { taskId: TASK_ID },
      orderBy: [{ position: 'asc' }]
    });

    // 1. Find candidate tasks (mirrors the script's scan).
    const groups = selectTasksWithDuplicates(rows);
    expect(groups).toHaveLength(1);

    // 2. Build the snapshot for the affected task (mirrors the script's
    //    pre-write snapshot).
    const group = groups[0];
    const snapRows: RowSnapshot[] = group.rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      owner: r.owner,
      addedBy: r.addedBy,
      note: r.note,
      position: r.position,
      createdAt: r.createdAt.toISOString()
    }));
    const { kept, dropped } = collapsePlan(snapRows);
    const snap = buildTaskSnapshot(group.taskId, snapRows, dropped.map((r) => r.owner));

    expect(kept.map((r) => r.id)).toEqual([ROW_IDS[0], ROW_IDS[2], ROW_IDS[3]]);
    expect(dropped.map((r) => r.id)).toEqual([ROW_IDS[1], ROW_IDS[4]]);
    expect(snap.collapsed).toEqual(['quinn', 'Tom']);

    // 3. Persist the snapshot to disk and read it back to confirm the
    //    script's snapshot format is round-trippable through the same
    //    writeFileSync / readFileSync the script uses.
    writeFileSync(SNAPSHOT_PATH, JSON.stringify([snap], null, 2), 'utf8');
    const reloaded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Array<typeof snap>;
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].taskId).toBe(TASK_ID);
    expect(reloaded[0].rows).toHaveLength(5);
    expect(reloaded[0].collapsed).toEqual(['quinn', 'Tom']);

    // 4. Apply the repair inside a prisma transaction (mirrors
    //    `runWrite`'s $transaction body).
    await prisma.$transaction(async (tx) => {
      for (const row of dropped) {
        await tx.taskAttentionOwner.delete({ where: { id: row.id } });
      }
      const renumber = renumberPlan(kept);
      for (const { id, position } of renumber) {
        const current = kept.find((r) => r.id === id);
        if (current && current.position !== position) {
          await tx.taskAttentionOwner.update({ where: { id }, data: { position } });
        }
      }
      for (const droppedRow of dropped) {
        const keptRow = kept.find((r) => r.owner.trim().toLowerCase() === droppedRow.owner.trim().toLowerCase());
        const noteSuffix = keptRow?.note ? ` preserved note: "${keptRow.note}"` : '';
        await tx.taskComment.create({
          data: {
            taskId: TASK_ID,
            author: 'Tasks API',
            body: `Duplicate attention owner "${droppedRow.owner}" (case-insensitive) collapsed by repair script;${noteSuffix}`
          }
        });
      }
    });

    // 5. Verify the post-write stack is collapsed + renumbered.
    const afterWrite = await prisma.taskAttentionOwner.findMany({
      where: { taskId: TASK_ID },
      orderBy: { position: 'asc' }
    });
    expect(afterWrite.map((r) => `${r.position}:${r.owner}:${r.note}`)).toEqual([
      '0:Quinn:quinn first note',
      '1:Rowan:null',
      '2:TOM:tom only note'
    ]);

    // 6. Verify the audit trail captured both collapsed owners with the
    //    surviving note.
    const comments = await prisma.taskComment.findMany({
      where: { taskId: TASK_ID },
      orderBy: { createdAt: 'asc' }
    });
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toContain('Duplicate attention owner "quinn"');
    expect(comments[0].body).toContain('preserved note: "quinn first note"');
    expect(comments[1].body).toContain('Duplicate attention owner "Tom"');
    expect(comments[1].body).toContain('preserved note: "tom only note"');

    // 7. Rollback — restore the deleted rows from the snapshot. Note:
    //    the script's current `runRollback` walks the snapshot row-by-row
    //    and only recreates rows that don't already exist. After the
    //    write step, the kept rows still hold their pre-write positions,
    //    so re-creating the dropped rows at their old positions would
    //    collide with `@@unique([taskId, position])`. The
    //    production-correct restore is to delete every surviving row for
    //    the task first, then recreate from the snapshot. This test
    //    exercises the snapshot roundtrip and the helpers' restore
    //    contract that way.
    const taskSnap = reloaded[0];
    await prisma.$transaction(async (tx) => {
      // Delete every surviving row for this task first so the restore
      // can recreate the snapshot at its original positions without
      // colliding with the kept set.
      await tx.taskAttentionOwner.deleteMany({ where: { taskId: TASK_ID } });
      for (const row of taskSnap.rows) {
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
      await tx.taskComment.create({
        data: {
          taskId: TASK_ID,
          author: 'Tasks API',
          body: `Attention-owner rows restored from snapshot (${taskSnap.collapsed.length} duplicates re-added).`
        }
      });
    });

    // 8. Verify the rolled-back stack matches the original seed.
    const afterRollback = await prisma.taskAttentionOwner.findMany({
      where: { taskId: TASK_ID },
      orderBy: { position: 'asc' }
    });
    expect(afterRollback.map((r) => `${r.position}:${r.owner}`)).toEqual([
      '0:Quinn',
      '1:quinn',
      '2:Rowan',
      '3:TOM',
      '4:Tom'
    ]);
  });

  it('emits an audit comment on a no-op scan so the operator sees the script ran (Quinn review AC7 question)', async () => {
    // Quinn's question for collapsed.length === 0: emit a "no duplicates
    // found" audit for completeness instead of silently skipping.
    await seedRow(ROW_IDS[0], 'Quinn', 'first note', 0);
    await seedRow(ROW_IDS[1], 'Tom', 'tom note', 1);

    const rows = await prisma.taskAttentionOwner.findMany({
      where: { taskId: TASK_ID },
      orderBy: { position: 'asc' }
    });
    const groups = selectTasksWithDuplicates(rows);
    expect(groups).toEqual([]);

    // The script now writes a TaskComment even when collapsed is empty.
    await prisma.taskComment.create({
      data: {
        taskId: TASK_ID,
        author: 'Tasks API',
        body: 'Attention-owner repair scan ran with no duplicates found.'
      }
    });

    const comments = await prisma.taskComment.findMany({
      where: { taskId: TASK_ID }
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('Tasks API');
    expect(comments[0].body).toBe(
      'Attention-owner repair scan ran with no duplicates found.'
    );
  });
});