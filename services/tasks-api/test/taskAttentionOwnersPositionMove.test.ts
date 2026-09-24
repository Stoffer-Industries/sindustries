import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Real-DB integration test for the attention-owner PATCH position move
 * (task 91864257, Quinn review PR #751 — critical).
 *
 * The vitest mocks in `taskAttentionOwnersRoute.test.ts` let the
 * constraint-violation path slip through because `prismaMock.taskAttentionOwner.update`
 * is a stub that returns the requested value without enforcing the
 * `@@unique([taskId, position])` constraint. This test exercises the
 * route through the live Postgres so the constraint is real.
 *
 * Repro at the time of Quinn's review: rows A(0), B(1), C(2), D(3), E(4);
 * move D from position 3 to position 1. The pre-fix loop first wrote
 * `B: 1 → 2` while C still held position 2, hitting the unique
 * constraint mid-transaction. The fix moves D to a temp position
 * (`max + 1`) first, shifts the siblings, then places D at the
 * requested slot — three ordered writes inside one `prisma.$transaction`.
 */

process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  {
    token: 'integration-test-token-long-enough',
    actor: 'IntegrationTest',
    approvalTypes: []
  },
  {
    token: 'quinn-test-token-long-enough',
    actor: 'Quinn',
    approvalTypes: ['tech_design']
  },
  {
    token: 'tom-test-token-long-enough',
    actor: 'Tom',
    approvalTypes: ['spec', 'accepted']
  }
]);

// Static `import { prisma }` and `import { createApp }` statements get
// hoisted above the env-var assignment above, so we dynamic-import them
// AFTER the override takes effect. This matches the pattern in
// taskAttentionOwnersRoute.test.ts where the test file overrides the
// service-credential env before any route/auth module loads.
const { prisma } = await import('../src/lib/prisma.ts');
const { createApp } = await import('../src/app.ts');

const TASK_ID = '22222222-2222-2222-2222-222222222222';

const QUINN_TOKEN = 'quinn-test-token-long-enough';
const TOM_TOKEN = 'tom-test-token-long-enough';

async function resetTaskAttentionOwners() {
  await prisma.taskAttentionOwner.deleteMany({ where: { taskId: TASK_ID } });
  await prisma.taskComment.deleteMany({ where: { taskId: TASK_ID } });
  await prisma.task.deleteMany({ where: { id: TASK_ID } });
  await prisma.task.create({
    data: {
      id: TASK_ID,
      title: 'Position move integration test',
      status: 'doing',
      statusChangedAt: new Date(),
      priority: 'medium',
      assignee: 'Rowan',
      taskType: 'code'
    }
  });
}

async function seedRow(owner: string, note: string, position: number) {
  return prisma.taskAttentionOwner.create({
    data: {
      taskId: TASK_ID,
      owner,
      addedBy: 'Quinn',
      note,
      position
    }
  });
}

async function readPositions(): Promise<Array<{ id: string; owner: string; position: number; note: string }>> {
  return prisma.taskAttentionOwner.findMany({
    where: { taskId: TASK_ID },
    orderBy: { position: 'asc' },
    select: { id: true, owner: true, position: true, note: true }
  });
}

describe('PATCH /tasks/:id/attention-owners/:rowId — real DB position move', () => {
  beforeAll(async () => {
    // Sanity probe — fail loudly if the integration DB is not reachable so
    // CI surfaces this as a setup error, not a flaky constraint miss.
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    await resetTaskAttentionOwners();
  });

  afterAll(async () => {
    await prisma.taskAttentionOwner.deleteMany({ where: { taskId: TASK_ID } });
    await prisma.taskComment.deleteMany({ where: { taskId: TASK_ID } });
    await prisma.task.deleteMany({ where: { id: TASK_ID } });
    await prisma.$disconnect();
  });

  it('moves D from position 3 to position 1 across a 5-row stack (Quinn review repro)', async () => {
    // The exact scenario from Quinn's repro block: A(0), B(1), C(2), D(3), E(4).
    const a = await seedRow('A', 'reason A', 0);
    const b = await seedRow('B', 'reason B', 1);
    const c = await seedRow('C', 'reason C', 2);
    const d = await seedRow('D', 'reason D', 3);
    const e = await seedRow('E', 'reason E', 4);

    // Quinn is the seeded actor for the position-0 attention owner. The
    // route's per-row auth check allows the move because Quinn owns the
    // top slot. Tom can also move it (override path) — Tom is used here
    // so the test exercises the override branch, which is the only path
    // we can take without making the top-of-stack match.
    const app = createApp();
    const response = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/${d.id}`)
      .set('Authorization', `Bearer ${TOM_TOKEN}`)
      .send({ position: 1 });

    expect(response.status).toBe(200);
    expect(response.body?.row?.position).toBe(1);

    // Verify final ordering: D at 1, B and C bumped up by 1.
    const positions = await readPositions();
    expect(positions).toEqual([
      { id: a.id, owner: 'A', position: 0, note: 'reason A' },
      { id: d.id, owner: 'D', position: 1, note: 'reason D' },
      { id: b.id, owner: 'B', position: 2, note: 'reason B' },
      { id: c.id, owner: 'C', position: 3, note: 'reason C' },
      { id: e.id, owner: 'E', position: 4, note: 'reason E' }
    ]);

    // Verify the unique constraint is intact end-to-end.
    const uniqueViolations = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT "taskId", "position"
        FROM tasks_api."TaskAttentionOwner"
        WHERE "taskId" = ${TASK_ID}::uuid
        GROUP BY "taskId", "position"
        HAVING COUNT(*) > 1
      ) AS duplicates
    `;
    expect(Number(uniqueViolations[0]?.count ?? 0n)).toBe(0);
  });

  it('moves a row up from position 2 to position 3 across a 4-row stack', async () => {
    const a = await seedRow('A', 'reason A', 0);
    const b = await seedRow('B', 'reason B', 1);
    const c = await seedRow('C', 'reason C', 2);
    const d = await seedRow('D', 'reason D', 3);

    const app = createApp();
    const response = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/${c.id}`)
      .set('Authorization', `Bearer ${TOM_TOKEN}`)
      .send({ position: 3 });

    expect(response.status).toBe(200);

    const positions = await readPositions();
    expect(positions).toEqual([
      { id: a.id, owner: 'A', position: 0, note: 'reason A' },
      { id: b.id, owner: 'B', position: 1, note: 'reason B' },
      { id: d.id, owner: 'D', position: 2, note: 'reason D' },
      { id: c.id, owner: 'C', position: 3, note: 'reason C' }
    ]);
  });

  it('moves a row down from position 0 to position 3 across a 5-row stack (Quinn review repro, move-down)', async () => {
    // Mirror of the 5-row move-down case: A(0), B(1), C(2), D(3), E(4);
    // move A from position 0 to position 3. Verifies the move-down branch
    // (targetIndex > currentIndex) shifts siblings DOWN by one in
    // ascending order so each bump lands on a slot the prior bump cleared.
    const a = await seedRow('A', 'reason A', 0);
    const b = await seedRow('B', 'reason B', 1);
    const c = await seedRow('C', 'reason C', 2);
    const d = await seedRow('D', 'reason D', 3);
    const e = await seedRow('E', 'reason E', 4);

    const app = createApp();
    const response = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/${a.id}`)
      .set('Authorization', `Bearer ${TOM_TOKEN}`)
      .send({ position: 3 });

    expect(response.status).toBe(200);

    const positions = await readPositions();
    expect(positions).toEqual([
      { id: b.id, owner: 'B', position: 0, note: 'reason B' },
      { id: c.id, owner: 'C', position: 1, note: 'reason C' },
      { id: d.id, owner: 'D', position: 2, note: 'reason D' },
      { id: a.id, owner: 'A', position: 3, note: 'reason A' },
      { id: e.id, owner: 'E', position: 4, note: 'reason E' }
    ]);
  });

  it('leaves the stack untouched when position is unchanged', async () => {
    const a = await seedRow('A', 'reason A', 0);
    const b = await seedRow('B', 'reason B', 1);
    const c = await seedRow('C', 'reason C', 2);

    const app = createApp();
    const response = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/${b.id}`)
      .set('Authorization', `Bearer ${TOM_TOKEN}`)
      .send({ note: 'updated reason', position: 1 });

    expect(response.status).toBe(200);

    const positions = await readPositions();
    expect(positions).toEqual([
      { id: a.id, owner: 'A', position: 0, note: 'reason A' },
      { id: b.id, owner: 'B', position: 1, note: 'updated reason' },
      { id: c.id, owner: 'C', position: 2, note: 'reason C' }
    ]);
  });

  it('records an audit comment after the move', async () => {
    const a = await seedRow('A', 'reason A', 0);
    const b = await seedRow('B', 'reason B', 1);
    const c = await seedRow('C', 'reason C', 2);
    const d = await seedRow('D', 'reason D', 3);

    const app = createApp();
    await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/${a.id}`)
      .set('Authorization', `Bearer ${TOM_TOKEN}`)
      .send({ position: 2 });

    const comments = await prisma.taskComment.findMany({
      where: { taskId: TASK_ID },
      orderBy: { createdAt: 'asc' }
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('Tom');
    expect(comments[0].body).toContain('position 0 -> 2');
    // Ensure the positions table actually moved — guards against a silent
    // rollback that would leave the audit comment without the matching
    // row update.
    const positions = await readPositions();
    expect(positions.map((row) => row.owner)).toEqual(['B', 'C', 'A', 'D']);
  });
});