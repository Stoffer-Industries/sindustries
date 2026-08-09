import { describe, expect, it } from 'vitest';
import { mapTask, mapTaskAttentionOwner } from '../src/routes/tasks/_mapper.ts';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

function attentionOwnerFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ao-1',
    taskId: TASK_ID,
    owner: 'Tom',
    addedBy: 'Quinn',
    note: 'Needs eyes on the spec revision',
    createdAt: new Date('2026-08-10T01:00:00.000Z'),
    ...overrides
  };
}

function baseTaskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Sample task',
    description: null,
    status: 'doing',
    statusChangedAt: new Date('2026-08-08T00:00:00.000Z'),
    priority: 'normal',
    assignee: 'Rowan',
    dueAt: null,
    completedAt: null,
    blocked: false,
    tags: [],
    comments: [],
    approvals: [],
    attentionOwners: [],
    dependencies: [],
    dependedOnBy: [],
    analyticsEvents: [],
    taskTags: [],
    blockedBy: [],
    dependedOnByIds: [],
    ...overrides
  };
}

describe('mapTaskAttentionOwner', () => {
  it('maps a TaskAttentionOwner row to the API response shape', () => {
    const row = attentionOwnerFixture();
    const result = mapTaskAttentionOwner(row);
    expect(result).toEqual({
      id: 'ao-1',
      owner: 'Tom',
      addedBy: 'Quinn',
      note: 'Needs eyes on the spec revision',
      createdAt: row.createdAt
    });
  });

  it('nulls addedBy and note when absent on the row', () => {
    const row = attentionOwnerFixture({ addedBy: null, note: null });
    const result = mapTaskAttentionOwner(row);
    expect(result.addedBy).toBeNull();
    expect(result.note).toBeNull();
  });
});

describe('mapTask — attention owners plane', () => {
  it('exposes attentionOwners and attentionOwnerDetails from a task with rows', () => {
    const task = baseTaskFixture({
      attentionOwners: [
        attentionOwnerFixture({ id: 'ao-1', owner: 'Tom' }),
        attentionOwnerFixture({ id: 'ao-2', owner: 'Quinn', note: null })
      ]
    });
    const result = mapTask(task);
    expect(result.attentionOwners).toEqual(['Tom', 'Quinn']);
    expect(result.attentionOwnerDetails).toHaveLength(2);
    expect(result.attentionOwnerDetails[0]).toMatchObject({ id: 'ao-1', owner: 'Tom' });
    expect(result.attentionOwnerDetails[1]).toMatchObject({ id: 'ao-2', owner: 'Quinn', note: null });
  });

  it('returns empty arrays for a task with no attention owners', () => {
    const task = baseTaskFixture({ attentionOwners: [] });
    const result = mapTask(task);
    expect(result.attentionOwners).toEqual([]);
    expect(result.attentionOwnerDetails).toEqual([]);
  });

  it('preserves task.blocked and dependencyBlocked when attention owners are present (AC7 backward compat)', () => {
    const task = baseTaskFixture({
      blocked: true,
      attentionOwners: [attentionOwnerFixture({ owner: 'Tom' })]
    });
    const result = mapTask(task);
    expect(result.blocked).toBe(true);
    expect(result.attentionOwners).toEqual(['Tom']);
  });

  it('preserves task.blocked = false when no attention owners exist', () => {
    const task = baseTaskFixture({ blocked: false, attentionOwners: [] });
    const result = mapTask(task);
    expect(result.blocked).toBe(false);
    expect(result.attentionOwners).toEqual([]);
  });

  it('does not expose the legacy blockedBy / hasBlockedBy / genericBlocked fields (renamed away)', () => {
    const task = baseTaskFixture({ attentionOwners: [attentionOwnerFixture()] });
    const result = mapTask(task) as Record<string, unknown>;
    expect(result).not.toHaveProperty('blockedBy');
    expect(result).not.toHaveProperty('blockedByIds');
    expect(result).not.toHaveProperty('hasBlockedBy');
    expect(result).not.toHaveProperty('genericBlocked');
  });

  it('keeps approvals independent of attentionOwners (AC4 distinct planes)', () => {
    const task = baseTaskFixture({
      approvals: [
        {
          id: 'approval-1',
          taskId: TASK_ID,
          type: 'tech_design',
          owner: 'Quinn',
          state: 'approved',
          approvedAt: new Date('2026-08-09T20:00:00.000Z'),
          revokedAt: null,
          note: null,
          createdAt: new Date('2026-08-08T00:00:00.000Z'),
          updatedAt: new Date('2026-08-09T20:00:00.000Z')
        }
      ],
      attentionOwners: [attentionOwnerFixture({ owner: 'Tom' })]
    });
    const result = mapTask(task);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ type: 'tech_design', owner: 'Quinn' });
    expect(result.attentionOwners).toEqual(['Tom']);
  });
});
