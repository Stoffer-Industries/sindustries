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
  requiredApprovalsFor,
  _resetStartupLogForTesting
} = await import('../src/config/requiredApprovals.ts');

describe('parseRequiredApprovalsYaml', () => {
  it('parses the canonical config shape', () => {
    const yaml = [
      'version: 2',
      'mappings:',
      '  feature: [spec, tech_design, qa_agent, accepted]',
      '  code: [tech_design, qa_agent, accepted]',
      '  content: [spec, qa_agent, accepted]',
      '  research: []'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(2);
    expect(parsed.mappings).toEqual({
      feature: ['spec', 'tech_design', 'qa_agent', 'accepted'],
      code: ['tech_design', 'qa_agent', 'accepted'],
      content: ['spec', 'qa_agent', 'accepted'],
      research: []
    });
    expect(parsed.source).toBe('config-file');
  });

  it('ignores end-of-line comments and blank lines', () => {
    const yaml = [
      '# top of file',
      'version: 2 # trailing comment',
      '',
      'mappings: # header',
      '  # nested comment',
      '  feature: [spec, tech_design, qa_agent, accepted]',
      '  code: [tech_design, qa_agent, accepted]'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(2);
    expect(parsed.mappings.feature).toEqual(['spec', 'tech_design', 'qa_agent', 'accepted']);
    expect(parsed.mappings.code).toEqual(['tech_design', 'qa_agent', 'accepted']);
  });

  it('throws when version is missing', () => {
    // Use a valid approval type so the parser reaches the version check; the
    // `qa`-removal from `validApprovalTypes` would otherwise short-circuit
    // this assertion with an `unknown approval type` error.
    expect(() => parseRequiredApprovalsYaml('mappings:\n  feature: [spec]')).toThrow(
      /missing top-level `version: <number>` directive/
    );
  });

  it('throws on unknown approval type', () => {
    const yaml = ['version: 1', 'mappings:', '  feature: [spec, not_a_real_type]'].join('\n');
    expect(() => parseRequiredApprovalsYaml(yaml)).toThrow(/unknown approval type/);
  });

  it('silently ignores unknown top-level keys (permissive schema by design)', () => {
    // The loader is intentionally lenient about unknown top-level keys so a
    // partial future-proofed config file (e.g. an `audience:` header that a
    // newer release understands) still parses. Unknown keys must not throw;
    // they just exit the mappings block.
    const yaml = [
      'version: 2',
      'extra_header: anything',
      'mappings:',
      '  feature: [spec, tech_design, qa_agent, accepted]'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(2);
    expect(parsed.mappings).toEqual({ feature: ['spec', 'tech_design', 'qa_agent', 'accepted'] });
  });

  it('silently skips mapping entries whose shape does not match `<taskType>: [...]`', () => {
    // Lines inside the mappings block that are not `<taskType>: [list]` must
    // not throw — only entries that look right but contain an unknown
    // approval type are rejected. Stray prose or scalar entries are skipped
    // so a partial config file remains usable.
    const yaml = [
      'version: 2',
      'mappings:',
      '  feature: [spec, tech_design, qa_agent, accepted]',
      '  not_an_entry: oops',
      '  free_text: should be skipped'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(2);
    expect(parsed.mappings).toEqual({ feature: ['spec', 'tech_design', 'qa_agent', 'accepted'] });
  });

  it('lets the last duplicate task-type entry win without throwing', () => {
    // A duplicated task-type key silently overrides the earlier entry. This
    // is documented permissive behaviour: the parser does not surface a
    // duplicate-key error, but downstream `requiredApprovalsFor` returns the
    // last-seen list. Operators rely on the merged-over-defaults behaviour in
    // `loadRequiredApprovalsConfig` for deltas; a literal duplicate inside a
    // single file is the operator\'s last write winning.
    const yaml = [
      'version: 2',
      'mappings:',
      '  feature: [accepted]',
      '  feature: [spec, tech_design, qa_agent, accepted]'
    ].join('\n');

    const parsed = parseRequiredApprovalsYaml(yaml);

    expect(parsed.version).toBe(2);
    expect(parsed.mappings.feature).toEqual(['spec', 'tech_design', 'qa_agent', 'accepted']);
  });
});

describe('loadRequiredApprovalsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'req-approvals-'));
    // Each `it` block exercises the resolved-policy startup log in isolation.
    // The memoization flag is module-private; reset it before every test so
    // ordering cannot leak state between cases.
    _resetStartupLogForTesting();
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
      ['version: 2', 'mappings:', '  feature: [accepted]'].join('\n'),
      'utf8'
    );

    const config = loadRequiredApprovalsConfig(path);

    expect(config.source).toBe('config-file');
    expect(config.mappings.feature).toEqual(['accepted']);
    // Untouched task types keep their default values.
    expect(config.mappings.code).toEqual(['tech_design', 'qa_agent', 'accepted']);
    expect(config.mappings.content).toEqual(['spec', 'qa_agent', 'accepted']);
    expect(config.mappings.research).toEqual([]);
    expect(config.path).toBe(path);
    expect(config.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to default when file is malformed', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(path, 'this is not the right shape', 'utf8');

    const config = loadRequiredApprovalsConfig(path);

    expect(config.source).toBe('builtin-default');
    expect(config.mappings).toEqual(DEFAULT_REQUIRED_APPROVALS.mappings);
    expect(config.path).toBeNull();
    expect(config.hash).toBe(DEFAULT_REQUIRED_APPROVALS.hash);
  });

  it('emits a console.warn naming the file when parse fails', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(path, 'this is not the right shape', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadRequiredApprovalsConfig(path);
      expect(config.source).toBe('builtin-default');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/\[required-approvals\]/);
      expect(message).toContain(path);
      expect(message).toMatch(/Falling back to built-in default/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the config file is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadRequiredApprovalsConfig(join(tmpDir, 'does-not-exist.yaml'));
      expect(config.source).toBe('builtin-default');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the config file parses cleanly', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(
      path,
      ['version: 2', 'mappings:', '  feature: [accepted]'].join('\n'),
      'utf8'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadRequiredApprovalsConfig(path);
      expect(config.source).toBe('config-file');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns a stable hash for the builtin default', () => {
    expect(DEFAULT_REQUIRED_APPROVALS.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(DEFAULT_REQUIRED_APPROVALS.hash).toBe(DEFAULT_REQUIRED_APPROVALS.hash);
  });

  it('produces a different hash when the merged mappings change', () => {
    const basePath = join(tmpDir, 'base.yaml');
    writeFileSync(
      basePath,
      ['version: 2', 'mappings:', '  feature: [accepted]'].join('\n'),
      'utf8'
    );
    const baseConfig = loadRequiredApprovalsConfig(basePath);

    const overridePath = join(tmpDir, 'override.yaml');
    writeFileSync(
      overridePath,
      ['version: 2', 'mappings:', '  feature: [spec, accepted]'].join('\n'),
      'utf8'
    );
    const overrideConfig = loadRequiredApprovalsConfig(overridePath);

    expect(overrideConfig.hash).not.toBe(baseConfig.hash);
    expect(overrideConfig.hash).not.toBe(DEFAULT_REQUIRED_APPROVALS.hash);
  });

  it('emits a console.info with the resolved policy on first call (audit drift signal)', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(
      path,
      ['version: 2', 'mappings:', '  feature: [accepted]'].join('\n'),
      'utf8'
    );

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      loadRequiredApprovalsConfig(path);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const message = String(infoSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/\[required-approvals\] resolved policy/);
      expect(message).toMatch(/source=config-file/);
      expect(message).toMatch(/version=2/);
      // Hash prefix is the first 12 chars of a 64-char SHA-256 hex digest.
      expect(message).toMatch(/hash=[0-9a-f]{12}…/);
      expect(message).toContain(`path=${path}`);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('emits a console.info on first call even when the config file is missing (built-in default path)', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      loadRequiredApprovalsConfig(join(tmpDir, 'does-not-exist.yaml'));
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const message = String(infoSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/source=builtin-default/);
      expect(message).toMatch(/path=<built-in default>/);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('does not re-emit the resolved-policy log on subsequent calls in the same process', () => {
    const path = join(tmpDir, 'required-approvals.yaml');
    writeFileSync(
      path,
      ['version: 2', 'mappings:', '  feature: [accepted]'].join('\n'),
      'utf8'
    );

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      loadRequiredApprovalsConfig(path);
      loadRequiredApprovalsConfig(path);
      loadRequiredApprovalsConfig(path);
      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('requiredApprovalsFor', () => {
  const config = DEFAULT_REQUIRED_APPROVALS;

  it('returns the configured list for known task types', () => {
    expect(requiredApprovalsFor(config, 'feature')).toEqual(['spec', 'tech_design', 'qa_agent', 'accepted']);
    expect(requiredApprovalsFor(config, 'content')).toEqual(['spec', 'qa_agent', 'accepted']);
    expect(requiredApprovalsFor(config, 'code')).toEqual(['tech_design', 'qa_agent', 'accepted']);
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
        requiredApprovals: ['spec', 'tech_design', 'qa_agent', 'accepted'],
        version: 2,
        source: 'builtin-default',
        path: null,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/)
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
