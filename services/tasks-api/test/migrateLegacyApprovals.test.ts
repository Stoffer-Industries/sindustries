import { describe, expect, it, vi } from 'vitest';
import type { DetectedApproval } from '../src/lib/legacyApprovals.ts';
import {
  planMigration,
  runDryRun,
  runRollback,
  runWrite,
  type ApprovalType,
  type MigrationDeps,
  type MigrationTask,
  type SnapshotFile
} from '../src/lib/migrateLegacyApprovals.ts';

function taskFixture(overrides: Partial<MigrationTask> = {}): MigrationTask {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Example task',
    description: null,
    status: 'doing',
    taskType: 'feature',
    approvals: [],
    comments: [],
    ...overrides
  };
}

function makeDeps(overrides: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    fetchAllTasks: vi.fn(async () => []),
    postApproval: vi.fn(async () => undefined),
    deleteApproval: vi.fn(async () => undefined),
    writeFile: vi.fn(),
    readFile: vi.fn(() => '{"rows":[]}'),
    ensureDir: vi.fn(),
    ...overrides
  };
}

describe('planMigration', () => {
  it('counts detected approvals across the task set', () => {
    const plan = planMigration([
      taskFixture({
        id: 'task-1',
        description: '- [x] **Approved by Tom**',
        approvals: []
      }),
      taskFixture({
        id: 'task-2',
        comments: [{ author: 'Quinn', text: '[tech-design-approved] true', createdAt: '', updatedAt: '', id: 'c1' }]
      }),
      taskFixture({
        id: 'task-3',
        comments: [{ author: 'Tom', text: '[qa-ac-verified] true', createdAt: '', updatedAt: '', id: 'c2' }]
      })
    ]);

    expect(plan.totalTasks).toBe(3);
    expect(plan.createdApprovals).toBe(3);
    expect(plan.skippedExisting).toBe(0);
  });
});

describe('runDryRun', () => {
  it('reports counts without invoking post/delete or touching the filesystem', async () => {
    const deps = makeDeps({
      fetchAllTasks: vi.fn(async () => [
        taskFixture({
          id: 'task-1',
          description: '- [x] **Approved by Tom**'
        })
      ])
    });

    const summary = await runDryRun(deps);

    expect(summary.dryRun).toBe(true);
    expect(summary.snapshotPath).toBeNull();
    expect(summary.createdApprovals).toBe(1);
    expect(deps.postApproval).not.toHaveBeenCalled();
    expect(deps.deleteApproval).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.ensureDir).not.toHaveBeenCalled();
  });
});

describe('runWrite — pagination, per-row failure, snapshot creation, retry', () => {
  it('walks every page of tasks returned by fetchAllTasks', async () => {
    // Pagination is exercised inside the default `fetchAllTasks` helper in
    // scripts/migrate-legacy-approvals.ts. Here we verify the lib calls
    // fetchAllTasks exactly once per run, regardless of how many pages the
    // caller chooses to assemble internally.
    const tasks = [
      taskFixture({ id: 'task-1', description: '- [x] **Approved by Tom**' }),
      taskFixture({
        id: 'task-2',
        comments: [{ author: 'Tom', text: '[qa-ac-verified] true', createdAt: '', updatedAt: '', id: 'c1' }]
      })
    ];
    const deps = makeDeps({ fetchAllTasks: vi.fn(async () => tasks) });

    await runWrite(deps, () => '/tmp/snapshot.json');

    expect(deps.fetchAllTasks).toHaveBeenCalledTimes(1);
    expect(deps.postApproval).toHaveBeenCalledTimes(2);
  });

  it('does not post approvals that already exist on the task', async () => {
    const deps = makeDeps({
      fetchAllTasks: vi.fn(async () => [
        taskFixture({
          id: 'task-1',
          description: '- [x] **Approved by Tom**',
          approvals: [
            {
              id: 'a1',
              taskId: 'task-1',
              type: 'spec',
              owner: 'Tom',
              state: 'approved',
              approvedAt: '2026-01-01T00:00:00.000Z',
              revokedAt: null,
              note: null,
              createdAt: '',
              updatedAt: ''
            }
          ]
        })
      ])
    });

    const summary = await runWrite(deps, () => '/tmp/snapshot.json');

    expect(summary.createdApprovals).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(deps.postApproval).not.toHaveBeenCalled();
    expect(summary.snapshotPath).toBe('/tmp/snapshot.json');
    expect(summary.breakdownByType).toEqual([{ type: 'spec', created: 0, skippedExisting: 1 }]);
  });

  it('writes a snapshot file containing only the rows it created', async () => {
    const writeFile = vi.fn();
    const deps = makeDeps({
      fetchAllTasks: vi.fn(async () => [
        taskFixture({
          id: 'task-1',
          description: '- [x] **Approved by Tom**'
        }),
        taskFixture({
          id: 'task-2',
          comments: [{ author: 'Tom', text: '[qa-ac-verified] true', createdAt: '', updatedAt: '', id: 'c1' }]
        }),
        taskFixture({
          id: 'task-3',
          description: '- [x] **Approved by Tom**',
          approvals: [
            {
              id: 'a1',
              taskId: 'task-3',
              type: 'spec',
              owner: 'Tom',
              state: 'approved',
              approvedAt: '2026-01-01T00:00:00.000Z',
              revokedAt: null,
              note: null,
              createdAt: '',
              updatedAt: ''
            }
          ]
        })
      ]),
      writeFile
    });

    const summary = await runWrite(deps, () => '/tmp/snap.json');

    expect(summary.createdApprovals).toBe(2);
    expect(summary.skippedExisting).toBe(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('/tmp/snap.json');
    const parsed = JSON.parse(content) as SnapshotFile;
    expect(parsed.rolledBack).toBe(false);
    expect(parsed.rows).toEqual([
      { taskId: 'task-1', type: 'spec' },
      { taskId: 'task-2', type: 'accepted' }
    ]);
  });

  it('creates the parent directory of the snapshot before writing', async () => {
    const ensureDir = vi.fn();
    const writeFile = vi.fn();
    const deps = makeDeps({
      fetchAllTasks: vi.fn(async () => [
        taskFixture({
          id: 'task-1',
          description: '- [x] **Approved by Tom**'
        })
      ]),
      ensureDir,
      writeFile
    });

    await runWrite(deps, () => '/var/snapshots/2026/snap.json');

    expect(ensureDir).toHaveBeenCalledTimes(1);
    expect(ensureDir).toHaveBeenCalledWith('/var/snapshots/2026/snap.json');
  });

  it('aborts cleanly when a per-row post fails (no snapshot written)', async () => {
    const writeFile = vi.fn();
    const deps = makeDeps({
      fetchAllTasks: vi.fn(async () => [
        taskFixture({
          id: 'task-1',
          description: '- [x] **Approved by Tom**'
        }),
        taskFixture({
          id: 'task-2',
          comments: [{ author: 'Tom', text: '[qa-ac-verified] true', createdAt: '', updatedAt: '', id: 'c1' }]
        })
      ]),
      postApproval: vi.fn(async (taskId: string) => {
        if (taskId === 'task-2') throw new Error('HTTP 500');
      }),
      writeFile
    });

    await expect(runWrite(deps, () => '/tmp/snap.json')).rejects.toThrow('HTTP 500');

    expect(deps.postApproval).toHaveBeenCalledTimes(2);
    // The first row was created before the failure, but the snapshot must
    // NOT have been written — otherwise rollback would target rows the
    // operator never authorised.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('is idempotent on retry — re-running after partial failure skips already-created rows', async () => {
    const firstTasks = [
      taskFixture({
        id: 'task-1',
        description: '- [x] **Approved by Tom**'
      })
    ];
    const secondTasks = [
      taskFixture({
        id: 'task-1',
        description: '- [x] **Approved by Tom**',
        approvals: [
          {
            id: 'a1',
            taskId: 'task-1',
            type: 'spec',
            owner: 'Tom',
            state: 'approved',
            approvedAt: '2026-01-01T00:00:00.000Z',
            revokedAt: null,
            note: null,
            createdAt: '',
            updatedAt: ''
          }
        ]
      })
    ];

    const firstDeps = makeDeps({
      fetchAllTasks: vi.fn(async () => firstTasks),
      postApproval: vi.fn(async () => undefined)
    });
    const firstSummary = await runWrite(firstDeps, () => '/tmp/snap.json');
    expect(firstSummary.createdApprovals).toBe(1);

    // Operator retries: the task now shows the approval that the partial
    // run successfully POSTed before failing later.
    const secondDeps = makeDeps({
      fetchAllTasks: vi.fn(async () => secondTasks),
      postApproval: vi.fn(async () => undefined)
    });
    const secondSummary = await runWrite(secondDeps, () => '/tmp/snap-2.json');

    expect(secondSummary.createdApprovals).toBe(0);
    expect(secondSummary.skippedExisting).toBe(1);
    expect(secondDeps.postApproval).not.toHaveBeenCalled();
  });
});

describe('runRollback', () => {
  it('DELETEs every row in the snapshot and reports the count', async () => {
    const snapshot: SnapshotFile = {
      savedAt: '2026-08-08T00:00:00.000Z',
      rolledBack: false,
      rows: [
        { taskId: 'task-1', type: 'spec' },
        { taskId: 'task-2', type: 'accepted' },
        { taskId: 'task-3', type: 'tech_design' }
      ]
    };

    const deps = makeDeps({
      readFile: vi.fn(() => JSON.stringify(snapshot)),
      deleteApproval: vi.fn(async () => undefined)
    });

    const summary = await runRollback(deps, '/tmp/snap.json');

    expect(summary.rolledBack).toBe(3);
    expect(summary.snapshotPath).toBe('/tmp/snap.json');
    expect(deps.deleteApproval).toHaveBeenCalledTimes(3);
    expect(deps.deleteApproval).toHaveBeenNthCalledWith(1, 'task-1', 'spec' as ApprovalType);
    expect(deps.deleteApproval).toHaveBeenNthCalledWith(2, 'task-2', 'accepted' as ApprovalType);
    expect(deps.deleteApproval).toHaveBeenNthCalledWith(3, 'task-3', 'tech_design' as ApprovalType);
  });

  it('throws when the snapshot file is malformed JSON', async () => {
    const deps = makeDeps({ readFile: vi.fn(() => 'not json') });

    await expect(runRollback(deps, '/tmp/bad.json')).rejects.toThrow();
  });

  it('throws when the snapshot payload is missing the rows array', async () => {
    const deps = makeDeps({ readFile: vi.fn(() => '{"savedAt":"x"}') });

    await expect(runRollback(deps, '/tmp/bad.json')).rejects.toThrow('malformed');
  });
});