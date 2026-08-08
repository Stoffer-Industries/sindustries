import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  task: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  taskComment: { create: vi.fn() },
  taskTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  tag: { findMany: vi.fn(), upsert: vi.fn() },
  taskDependency: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  taskApproval: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');
const {
  DEFAULT_REQUIRED_APPROVALS,
  loadRequiredApprovalsConfig,
  parseRequiredApprovalsYaml,
  requiredApprovalsFor
} = await import('../src/config/requiredApprovals.ts');

describe('parseRequiredApprovalsYaml', () => {
  it('parses the canonical config shape', () => {
    const yaml = [
      'version: 1',
      'mappings:',
      '  feature: [spec, tech_design, qa]',
      '  code: [tech_design, qa]',
      '  content: [spec, qa]',
      '  research: []'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(1);
    expect(parsed.mappings).toEqual({
      feature: ['spec', 'tech_design', 'qa'],
      code: ['tech_design', 'qa'],
      content: ['spec', 'qa'],
      research: []
    });
    expect(parsed.source).toBe('config-file');
  });

  it('ignores end-of-line comments and blank lines', () => {
    const yaml = [
      '# top of file',
      'version: 1 # trailing comment',
      '',
      'mappings: # header',
      '  # nested comment',
      '  feature: [spec, tech_design, qa]',
      '  code: [tech_design, qa]'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(1);
    expect(parsed.mappings.feature).toEqual(['spec', 'tech_design', 'qa']);
    expect(parsed.mappings.code).toEqual(['tech_design', 'qa']);
  });

  it('throws when version is missing', () => {
    expect(() => parseRequiredApprovalsYaml('mappings:\n  feature: [qa]')).toThrow(
      /missing top-level `version: <number>` directive/
    );
  });

  it('throws on unknown approval type', () => {
    const yaml = ['version: 1', 'mappings:', '  feature: [spec, not_a_real_type]'].join('\n');
    expect(() => parseRequiredApprovalsYaml(yaml)).toThrow(/unknown approval type/);
  });
});

describe('loadRequiredApprovalsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'req-approvals-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default config when file is missing', () => {
    const config = loadRequiredApprovalsConfig(join(tmpDir, 'does-not-exist.yaml'));
    expect(config.source).toBe('builtin-default');
    expect(config.mappings).toEqual(DEFAULT_REQUIRED_APPROVALS.mappings);
  });

  it('merges parsed mappings over the default', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(
      path,
      ['version: 1', 'mappings:', '  feature: [qa]'].join('\n'),
      'utf8'
    );

    const config = loadRequiredApprovalsConfig(path);

    expect(config.source).toBe('config-file');
    expect(config.mappings.feature).toEqual(['qa']);
    // Untouched task types keep their default values.
    expect(config.mappings.code).toEqual(['tech_design', 'qa']);
    expect(config.mappings.content).toEqual(['spec', 'qa']);
    expect(config.mappings.research).toEqual([]);
  });

  it('falls back to default when file is malformed', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(path, 'this is not the right shape', 'utf8');

    const config = loadRequiredApprovalsConfig(path);

    expect(config.source).toBe('builtin-default');
    expect(config.mappings).toEqual(DEFAULT_REQUIRED_APPROVALS.mappings);
  });
});

describe('requiredApprovalsFor', () => {
  const config = DEFAULT_REQUIRED_APPROVALS;

  it('returns the configured list for known task types', () => {
    expect(requiredApprovalsFor(config, 'feature')).toEqual(['spec', 'tech_design', 'qa']);
    expect(requiredApprovalsFor(config, 'content')).toEqual(['spec', 'qa']);
    expect(requiredApprovalsFor(config, 'code')).toEqual(['tech_design', 'qa']);
    expect(requiredApprovalsFor(config, 'research')).toEqual([]);
  });

  it('returns [] for unknown or null task types', () => {
    expect(requiredApprovalsFor(config, null)).toEqual([]);
    expect(requiredApprovalsFor(config, undefined)).toEqual([]);
    expect(requiredApprovalsFor(config, 'not-a-real-type')).toEqual([]);
  });
});

describe('GET /api/v1/task-types/:taskType/required-approvals', () => {
  it('returns the configured approval list for a known task type', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/task-types/feature/required-approvals');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        taskType: 'feature',
        requiredApprovals: ['spec', 'tech_design', 'qa'],
        version: 1,
        source: 'builtin-default'
      }
    });
  });

  it('returns the empty list for `research`', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/task-types/research/required-approvals');

    expect(response.status).toBe(200);
    expect(response.body.data.requiredApprovals).toEqual([]);
  });

  it('400s on an unknown task type', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/task-types/not-a-type/required-approvals');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TASK_TYPE');
  });
});
