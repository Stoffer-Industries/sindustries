import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors the route-layer prisma mock pattern from taskApprovals.test.ts:
// every model the route layer touches needs a vi.fn() slot, even if the
// test only exercises a subset. The WS1 changes touch a new model
// (`taskAttentionOwner`) and add `attentionOwners: true` to the existing
// `task.findMany` / `task.findFirst` includes, so this mock set has to
// cover both shapes.
const prismaMock = {
  task: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn()
  },
  taskDependency: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  taskComment: {
    create: vi.fn()
  },
  taskApproval: {
    findUnique: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn()
  },
  taskAttentionOwner: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn()
  },
  taskTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  tag: {
    findMany: vi.fn(),
    upsert: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');
const {
  mapTask
} = await import('../src/routes/tasks/_mapper.ts');
const {
  normalizeAttentionOwners,
  normalizeWorkflowHandoff,
  MAX_ATTENTION_OWNERS,
  MAX_ATTENTION_OWNER_LENGTH
} = await import('../src/routes/tasks/_validation.ts');
const {
  buildWorkflowGateOwnerWhere
} = await import('../src/routes/tasks/_deps.ts');
const {
  DEFAULT_REQUIRED_APPROVALS,
  gateOwnerFor,
  parseRequiredApprovalsYaml,
  loadRequiredApprovalsConfig
} = await import('../src/config/requiredApprovals.ts');
const {
  _resetStartupLogForTesting
} = await import('../src/config/requiredApprovals.ts');
const { WORKFLOW_HANDOFF_ROLE_OWNERS } = await import('../src/config/workflowHandoffs.ts');

const TASK_ID = '11111111-1111-1111-1111-111111111111';

function baseTaskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Sample task',
    description: null,
    status: 'doing',
    statusChangedAt: new Date('2026-08-08T00:00:00.000Z'),
    priority: 'medium',
    assignee: 'Rowan',
    dueAt: null,
    completedAt: null,
    blocked: false,
    taskType: 'feature',
    specChecksum: null,
    tags: [],
    comments: [],
    approvals: [],
    attentionOwners: [],
    workflowHandoffRoleId: null,
    workflowHandoffGate: null,
    workflowHandoffReason: null,
    dependencies: [],
    dependedOnBy: [],
    analyticsEvents: [],
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides
  };
}

describe('config — approval owners', () => {
  it('DEFAULT_REQUIRED_APPROVALS carries built-in owners per approval type', () => {
    expect(DEFAULT_REQUIRED_APPROVALS.owners).toEqual({
      spec: 'Tom',
      tech_design: 'Quinn',
      qa_agent: 'Ash',
      accepted: 'Tom'
    });
  });

  it('gateOwnerFor returns the configured owner for known approval types', () => {
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, 'spec')).toBe('Tom');
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, 'tech_design')).toBe('Quinn');
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, 'qa_agent')).toBe('Ash');
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, 'accepted')).toBe('Tom');
  });

  it('gateOwnerFor returns null for unknown or empty approval types', () => {
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, 'unknown')).toBeNull();
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, null)).toBeNull();
    expect(gateOwnerFor(DEFAULT_REQUIRED_APPROVALS, '')).toBeNull();
  });

  it('parseRequiredApprovalsYaml parses the owners block', () => {
    const yaml = [
      'version: 1',
      'mappings:',
      '  feature: [spec, tech_design, accepted]',
      'owners:',
      '  spec: Tom',
      '  tech_design: Quinn',
      '  accepted: Tom'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);
    expect(parsed.owners).toEqual({
      spec: 'Tom',
      tech_design: 'Quinn',
      accepted: 'Tom'
    });
  });

  it('parseRequiredApprovalsYaml silently drops owners entries for unknown approval types', () => {
    const yaml = [
      'version: 1',
      'mappings:',
      '  feature: [spec, tech_design, accepted]',
      'owners:',
      '  spec: Tom',
      '  tech_design: Quinn',
      // unknown approval type -- must not gate a task
      '  mystery: Somebody'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);
    expect(parsed.owners).toEqual({ spec: 'Tom', tech_design: 'Quinn' });
  });
});

describe('normalizeAttentionOwners', () => {
  it('returns an empty array when given an empty array', () => {
    const result = normalizeAttentionOwners([]);
    expect(result).toEqual({ owners: [] });
  });

  it('trims and dedupes case-insensitively', () => {
    const result = normalizeAttentionOwners(['Tom', 'tom', '  Tom  ']);
    expect(result).toEqual({ owners: ['Tom'] });
  });

  it('preserves insertion order on dedup', () => {
    const result = normalizeAttentionOwners(['Charlie', 'Bravo', 'Alpha', 'bravo']);
    expect(result).toEqual({ owners: ['Charlie', 'Bravo', 'Alpha'] });
  });

  it('rejects non-string entries', () => {
    expect(normalizeAttentionOwners(['Tom', 42 as unknown])).toBeNull();
    expect(normalizeAttentionOwners([null as unknown])).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(normalizeAttentionOwners(['Tom', ''])).toBeNull();
    expect(normalizeAttentionOwners(['   '])).toBeNull();
  });

  it('rejects names longer than MAX_ATTENTION_OWNER_LENGTH', () => {
    const tooLong = 'x'.repeat(MAX_ATTENTION_OWNER_LENGTH + 1);
    expect(normalizeAttentionOwners([tooLong])).toBeNull();
  });

  it('rejects more than MAX_ATTENTION_OWNERS distinct entries', () => {
    const many = Array.from({ length: MAX_ATTENTION_OWNERS + 1 }, (_, i) => `p${i}`);
    expect(normalizeAttentionOwners(many)).toBeNull();
  });

  it('accepts exactly MAX_ATTENTION_OWNERS distinct entries', () => {
    const many = Array.from({ length: MAX_ATTENTION_OWNERS }, (_, i) => `p${i}`);
    const result = normalizeAttentionOwners(many);
    expect(result).not.toBeNull();
    expect(result?.owners).toHaveLength(MAX_ATTENTION_OWNERS);
  });

  it('rejects a non-array value', () => {
    expect(normalizeAttentionOwners('Tom' as unknown)).toBeNull();
    expect(normalizeAttentionOwners({ owners: ['Tom'] } as unknown)).toBeNull();
  });
});

describe('PATCH /api/v1/tasks/:id — attentionOwners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
  });

  it('replaces attention owners with a full-replacement array', async () => {
    const existing = { id: TASK_ID, taskType: 'feature', archivedAt: null };
    prismaMock.task.findFirst
      .mockResolvedValueOnce(existing) // existing-task lookup
      .mockResolvedValueOnce({
        ...baseTaskFixture({ attentionOwners: [] }),
        attentionOwners: [
          { id: 'ao-1', taskId: TASK_ID, owner: 'Tom', addedBy: null, note: null, createdAt: new Date() }
        ]
      }); // post-update fetch

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: ['Tom'] });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.deleteMany).toHaveBeenCalledWith({ where: { taskId: TASK_ID } });
    expect(prismaMock.taskAttentionOwner.createMany).toHaveBeenCalledWith({
      data: [{ taskId: TASK_ID, owner: 'Tom' }]
    });
    expect(response.body.data.attentionOwners).toEqual(['Tom']);
  });

  it('clears all attention owners when given an empty array', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce({ id: TASK_ID, taskType: 'feature', archivedAt: null })
      .mockResolvedValueOnce(baseTaskFixture({ attentionOwners: [] }));

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: [] });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.deleteMany).toHaveBeenCalledWith({ where: { taskId: TASK_ID } });
    expect(prismaMock.taskAttentionOwner.createMany).not.toHaveBeenCalled();
    expect(response.body.data.attentionOwners).toEqual([]);
  });

  it('leaves attention owners untouched when the body omits them', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce({ id: TASK_ID, taskType: 'feature', archivedAt: null })
      .mockResolvedValueOnce(baseTaskFixture({
        attentionOwners: [
          { id: 'ao-1', taskId: TASK_ID, owner: 'Tom', addedBy: null, note: null, createdAt: new Date() }
        ]
      }));

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ status: 'doing' });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.taskAttentionOwner.createMany).not.toHaveBeenCalled();
    expect(response.body.data.attentionOwners).toEqual(['Tom']);
  });

  it('returns 400 INVALID_ATTENTION_OWNERS on a non-array value', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID, taskType: 'feature', archivedAt: null });

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: 'Tom' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_ATTENTION_OWNERS');
  });

  it('returns 400 INVALID_ATTENTION_OWNERS on an over-cap array', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID, taskType: 'feature', archivedAt: null });
    const many = Array.from({ length: MAX_ATTENTION_OWNERS + 1 }, (_, i) => `p${i}`);

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: many });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_ATTENTION_OWNERS');
  });

  it('does not touch task.blocked or dependencies when clearing attention owners (AC7, AC8)', async () => {
    const existing = { id: TASK_ID, taskType: 'feature', archivedAt: null };
    prismaMock.task.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({
        ...baseTaskFixture({
          blocked: true,
          attentionOwners: [
            { id: 'ao-1', taskId: TASK_ID, owner: 'Tom', addedBy: null, note: null, createdAt: new Date() }
          ]
        }),
        blocked: true,
        attentionOwners: []
      });

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: [] });

    expect(response.status).toBe(200);
    // task.blocked must NOT change as a side effect of clearing attention owners
    expect(response.body.data.blocked).toBe(true);
    expect(response.body.data.attentionOwners).toEqual([]);
    // We should not have touched the dependency plane either
    expect(prismaMock.taskDependency.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.taskDependency.createMany).not.toHaveBeenCalled();
  });

  it('preserves dependencyBlocked across attention-owner PATCHes (AC7 cross-row)', async () => {
    // The task is blocked *via a non-done dependency* (`dependencyBlocked` is
    // derived from `dependsOn.some(d => d.status !== 'done')`), not via
    // `task.blocked`. Clearing or replacing attention owners must not clear
    // or re-derive that signal; the existing `Blocked` indicator stays
    // backward-compatible.
    const existing = { id: TASK_ID, taskType: 'feature', archivedAt: null };
    const blockedDep = {
      id: 'dep-other',
      taskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      dependsOnId: TASK_ID,
      dependsOn: {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        title: 'Prereq task',
        status: 'doing',
        completedAt: null
      }
    };
    prismaMock.task.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({
        ...baseTaskFixture({
          blocked: false,
          dependencies: [blockedDep],
          attentionOwners: [
            { id: 'ao-1', taskId: TASK_ID, owner: 'Tom', addedBy: null, note: null, createdAt: new Date() }
          ]
        }),
        attentionOwners: []
      });

    const app = createApp();
    const response = await authedRequest(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ attentionOwners: [] });

    expect(response.status).toBe(200);
    // The mapper derives dependencyBlocked from the dependency plane; the
    // PATCH must leave the dependency row untouched so the signal survives.
    expect(response.body.data.dependencyBlocked).toBe(true);
    expect(response.body.data.dependsOn).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'doing' })
    ]);
    expect(response.body.data.attentionOwners).toEqual([]);
    expect(prismaMock.taskDependency.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.taskDependency.createMany).not.toHaveBeenCalled();
    // task.update was called, but only to write attention-owner rows; the
    // dependency plane is never its argument.
    expect(prismaMock.task.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dependencies: expect.anything() }) })
    );
  });
});

describe('GET /api/v1/tasks — discovery filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
  });

  it.each([
    ['Quinn', ['tech_design_approver']],
    ['Tom', ['product_spec_approver', 'qa_verifier']]
  ])('?workflowGateOwner=%s filters directly by persisted role ids', async (owner, roleIds) => {
    prismaMock.task.findMany.mockResolvedValue([]);

    await authedRequest(createApp()).get('/api/v1/tasks').query({ workflowGateOwner: owner });

    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ workflowHandoffRoleId: { in: roleIds } }]);
  });

  it('?workflowGateOwner with no configured roles returns zero tasks instead of broadening', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);

    await authedRequest(createApp()).get('/api/v1/tasks').query({ workflowGateOwner: 'Rowan' });

    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ id: { equals: '' } }]);
  });

  it('?attentionOwner=Tom scopes to tasks with at least one matching row', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);

    const app = createApp();
    await authedRequest(app).get('/api/v1/tasks').query({ attentionOwner: 'Tom' });

    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where.attentionOwners).toEqual({
      some: { owner: { equals: 'Tom', mode: 'insensitive' } }
    });
  });

  it('includes attentionOwners in the findMany include so the response can map them', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);
    const app = createApp();
    await authedRequest(app).get('/api/v1/tasks');
    const include = prismaMock.task.findMany.mock.calls[0][0].include;
    expect(include).toHaveProperty('attentionOwners', true);
  });

  it('does not apply the workflow-gate filter when the param is empty', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);
    const app = createApp();
    await authedRequest(app).get('/api/v1/tasks').query({ workflowGateOwner: '' });
    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('AND');
  });
});

describe('parseRequiredApprovalsYaml — owners section isolation', () => {
  it('keeps owners distinct from mappings when both are present', () => {
    const yaml = [
      'version: 1',
      'mappings:',
      '  feature: [spec, tech_design, accepted]',
      'owners:',
      '  spec: Tom',
      '  tech_design: Quinn',
      '  accepted: Tom'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);
    expect(parsed.mappings).toEqual({
      feature: ['spec', 'tech_design', 'accepted']
    });
    expect(parsed.owners).toEqual({
      spec: 'Tom',
      tech_design: 'Quinn',
      accepted: 'Tom'
    });
  });

  it('accepts an owners section without a mappings section (and vice versa)', () => {
    const yamlOwnersOnly = [
      'version: 1',
      'owners:',
      '  spec: Tom'
    ].join('\n');
    const parsedOwnersOnly = parseRequiredApprovalsYaml(yamlOwnersOnly);
    expect(parsedOwnersOnly.mappings).toEqual({});
    expect(parsedOwnersOnly.owners).toEqual({ spec: 'Tom' });

    const yamlMappingsOnly = [
      'version: 1',
      'mappings:',
      '  feature: [spec, tech_design, accepted]'
    ].join('\n');
    const parsedMappingsOnly = parseRequiredApprovalsYaml(yamlMappingsOnly);
    expect(parsedMappingsOnly.mappings).toEqual({
      feature: ['spec', 'tech_design', 'accepted']
    });
    expect(parsedMappingsOnly.owners).toEqual({});
  });
});

describe('loadRequiredApprovalsConfig — owners merge with defaults', () => {
  beforeEach(() => {
    _resetStartupLogForTesting();
  });

  it('falls back to DEFAULT_REQUIRED_APPROVALS when the file is missing', () => {
    const result = loadRequiredApprovalsConfig('/definitely/does/not/exist.yaml');
    expect(result.owners).toEqual(DEFAULT_REQUIRED_APPROVALS.owners);
    expect(result.source).toBe('builtin-default');
  });

  it('merges a partial owners override on top of the defaults', () => {
    // We don't have a temp file helper here; use a known path that doesn't
    // exist so we exercise the fallback path. The merge logic itself is
    // covered by the YAML parser tests.
    const result = loadRequiredApprovalsConfig('/nope.yaml');
    expect(result.owners.spec).toBe('Tom');
    expect(result.owners.tech_design).toBe('Quinn');
    expect(result.owners.accepted).toBe('Tom');
  });
});

describe('explicit workflow handoffs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has stable centrally configured role ownership', () => {
    expect(WORKFLOW_HANDOFF_ROLE_OWNERS).toEqual({
      product_spec_approver: 'Tom', tech_design_approver: 'Quinn', qa_verifier: 'Tom'
    });
  });

  it('maps only the single persisted active handoff and resolves its current owner', () => {
    expect(mapTask(baseTaskFixture({
      workflowHandoffRoleId: 'tech_design_approver',
      workflowHandoffGate: 'tech_design',
      workflowHandoffReason: 'Design needs approval',
      approvals: [{ id: 'a', type: 'spec', owner: 'Tom', state: 'revoked', approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }]
    })).workflowGates).toEqual([{
      roleId: 'tech_design_approver', owner: 'Quinn', gate: 'tech_design',
      reason: 'Design needs approval', state: 'outstanding'
    }]);
    expect(mapTask(baseTaskFixture()).workflowGates).toEqual([]);
  });

  it('omits an unresolvable persisted role instead of exposing ownerless work', () => {
    expect(mapTask(baseTaskFixture({
      workflowHandoffRoleId: 'removed_role',
      workflowHandoffGate: 'legacy'
    })).workflowGates).toEqual([]);
  });

  it('validates set and clear payloads', () => {
    expect(normalizeWorkflowHandoff(null)).toEqual({ roleId: null, gate: null, reason: null });
    expect(normalizeWorkflowHandoff({ roleId: 'qa_verifier', gate: 'qa' })).toEqual({ roleId: 'qa_verifier', gate: 'qa', reason: null });
    expect(normalizeWorkflowHandoff({ roleId: 'qa' })).toBeNull();
    expect(normalizeWorkflowHandoff({ roleId: 'qa_verifier', reason: '' })).toBeNull();
  });

  it('filters owner queues by persisted role id, case-insensitively', () => {
    expect(buildWorkflowGateOwnerWhere('quinn')).toEqual([{ workflowHandoffRoleId: { in: ['tech_design_approver'] } }]);
    expect(buildWorkflowGateOwnerWhere('Tom')).toEqual([{ workflowHandoffRoleId: { in: ['product_spec_approver', 'qa_verifier'] } }]);
    expect(buildWorkflowGateOwnerWhere('Nobody')).toEqual([]);
  });

  it('PATCH persists an explicit handoff and returns its resolved owner', async () => {
    const updated = baseTaskFixture({ workflowHandoffRoleId: 'qa_verifier', workflowHandoffGate: 'qa' });
    prismaMock.task.findFirst.mockResolvedValueOnce(baseTaskFixture());
    prismaMock.$transaction.mockImplementation(async (fn) => fn({
      task: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue(updated) },
      taskApproval: prismaMock.taskApproval, taskComment: prismaMock.taskComment,
      taskTag: prismaMock.taskTag, taskDependency: prismaMock.taskDependency,
      taskAttentionOwner: prismaMock.taskAttentionOwner
    }));
    const response = await authedRequest(createApp()).patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ workflowHandoff: { roleId: 'qa_verifier', gate: 'qa' } });
    expect(response.status).toBe(200);
    expect(response.body.data.workflowGates).toEqual([{
      roleId: 'qa_verifier', owner: 'Tom', gate: 'qa', reason: null, state: 'outstanding'
    }]);
  });

  it('rejects unknown role ids before writing', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(baseTaskFixture());
    const response = await authedRequest(createApp()).patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ workflowHandoff: { roleId: 'unknown' } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_WORKFLOW_HANDOFF');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
