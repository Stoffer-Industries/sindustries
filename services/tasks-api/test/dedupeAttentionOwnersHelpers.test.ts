import { describe, expect, it } from 'vitest';
import {
  buildTaskSnapshot,
  collapsePlan,
  duplicateAuditBody,
  renumberPlan,
  selectTasksWithDuplicates,
  type RowSnapshot
} from '../scripts/dedupe-attention-owners-helpers.ts';

/**
 * Unit tests for the pure helpers extracted from
 * `services/tasks-api/scripts/dedupe-attention-owners.ts`.
 *
 * Quinn's PR #751 review called out the absence of a test for the
 * repair script (AC7). The script is a tsx entry point that talks
 * directly to Postgres, so the test exercises the pure helpers that
 * build the collapse plan, the snapshot shape, and the renumbering
 * intent. The script wraps the same helpers inside a prisma
 * `$transaction`, so any divergence from this contract shows up here
 * before a `--write` run ships.
 *
 * The dedupe logic mirrors `normalizeAttentionOwners` (which IS
 * covered by `normalizeAttentionOwners.test.ts`). This file locks the
 * repair-path shape so the snapshot format the script persists stays
 * round-trippable through `--rollback`.
 */

function row(overrides: Partial<RowSnapshot>): RowSnapshot {
  return {
    id: 'ao-default',
    taskId: '11111111-1111-1111-1111-111111111111',
    owner: 'Quinn',
    addedBy: 'Quinn',
    note: 'kept note',
    position: 0,
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides
  };
}

describe('selectTasksWithDuplicates', () => {
  it('groups rows by taskId and reports only tasks with a case-insensitive duplicate', () => {
    const rows = [
      row({ id: 'a1', taskId: 'task-1', owner: 'Quinn', position: 0 }),
      row({ id: 'a2', taskId: 'task-1', owner: 'quinn', position: 1 }),
      row({ id: 'a3', taskId: 'task-1', owner: 'Tom', position: 2 }),
      row({ id: 'b1', taskId: 'task-2', owner: 'Rowan', position: 0 }),
      row({ id: 'b2', taskId: 'task-2', owner: 'Ash', position: 1 })
    ];
    const groups = selectTasksWithDuplicates(rows);
    const taskIds = groups.map((g) => g.taskId).sort();
    expect(taskIds).toEqual(['task-1']);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('returns no groups when every stack is duplicate-free', () => {
    const rows = [
      row({ id: 'a1', taskId: 'task-1', owner: 'Quinn', position: 0 }),
      row({ id: 'b1', taskId: 'task-2', owner: 'Tom', position: 0 })
    ];
    expect(selectTasksWithDuplicates(rows)).toEqual([]);
  });

  it('treats whitespace-only differences as case-insensitive duplicates', () => {
    const rows = [
      row({ id: 'a1', taskId: 'task-1', owner: 'Quinn', position: 0 }),
      row({ id: 'a2', taskId: 'task-1', owner: '  Quinn  ', position: 1 })
    ];
    const groups = selectTasksWithDuplicates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].taskId).toBe('task-1');
  });
});

describe('collapsePlan', () => {
  it('keeps the first occurrence and drops subsequent case-insensitive duplicates', () => {
    const rows = [
      row({ id: 'a1', owner: 'Quinn', note: 'first note', position: 0 }),
      row({ id: 'a2', owner: 'quinn', note: 'dup note', position: 1 }),
      row({ id: 'a3', owner: 'Tom', note: 'tom note', position: 2 })
    ];
    const { kept, dropped } = collapsePlan(rows);
    expect(kept.map((r) => r.id)).toEqual(['a1', 'a3']);
    expect(dropped.map((r) => r.id)).toEqual(['a2']);
    expect(kept[0].note).toBe('first note');
  });

  it('preserves the original ordering of kept rows so positions stay stable', () => {
    const rows = [
      row({ id: 'a1', owner: 'Quinn', position: 0 }),
      row({ id: 'a2', owner: 'Rowan', position: 1 }),
      row({ id: 'a3', owner: 'rowan', position: 2 }),
      row({ id: 'a4', owner: 'Tom', position: 3 }),
      row({ id: 'a5', owner: 'TOM', position: 4 })
    ];
    const { kept, dropped } = collapsePlan(rows);
    expect(kept.map((r) => r.id)).toEqual(['a1', 'a2', 'a4']);
    expect(dropped.map((r) => r.id)).toEqual(['a3', 'a5']);
  });

  it('returns all rows in kept when no duplicates exist', () => {
    const rows = [
      row({ id: 'a1', owner: 'Quinn' }),
      row({ id: 'a2', owner: 'Tom' })
    ];
    const { kept, dropped } = collapsePlan(rows);
    expect(kept.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(dropped).toEqual([]);
  });
});

describe('renumberPlan', () => {
  it('emits contiguous positions starting at 0 in kept order', () => {
    const kept = [
      row({ id: 'a1', position: 0 }),
      row({ id: 'a3', position: 2 }),
      row({ id: 'a4', position: 4 })
    ];
    expect(renumberPlan(kept)).toEqual([
      { id: 'a1', position: 0 },
      { id: 'a3', position: 1 },
      { id: 'a4', position: 2 }
    ]);
  });
});

describe('buildTaskSnapshot', () => {
  it('round-trips rows and the dropped-owner list through JSON.stringify/parse', () => {
    const rows: RowSnapshot[] = [
      row({ id: 'a1', owner: 'Quinn', position: 0, note: 'kept note' }),
      row({ id: 'a2', owner: 'quinn', position: 1, note: 'dup note' })
    ];
    const collapsed = ['quinn'];
    const snap = buildTaskSnapshot('task-1', rows, collapsed);
    const parsed = JSON.parse(JSON.stringify(snap));
    expect(parsed).toEqual(snap);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.collapsed).toEqual(['quinn']);
    expect(parsed.taskId).toBe('task-1');
  });

  it('serialises createdAt as an ISO string so it round-trips through writeFileSync', () => {
    const snap = buildTaskSnapshot('task-1', [
      row({ id: 'a1', createdAt: '2026-09-24T12:00:00.000Z' })
    ], []);
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.rows[0].createdAt).toBe('2026-09-24T12:00:00.000Z');
  });
});

describe('duplicateAuditBody', () => {
  it('mentions the dropped owner and the case-insensitive qualifier', () => {
    expect(duplicateAuditBody('Quinn', null)).toBe(
      'Duplicate attention owner "Quinn" (case-insensitive) collapsed by repair script;'
    );
  });

  it('includes the preserved note when one exists on the kept row', () => {
    expect(duplicateAuditBody('quinn', 'needs eyes on the spec')).toBe(
      'Duplicate attention owner "quinn" (case-insensitive) collapsed by repair script; preserved note: "needs eyes on the spec"'
    );
  });
});