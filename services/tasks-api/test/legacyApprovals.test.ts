import { describe, expect, it } from 'vitest';
import {
  detectLegacyApprovals,
  existingApprovalKeys,
  summarizeMigration
} from '../src/lib/legacyApprovals.ts';

function taskFixture(overrides: Partial<{
  id: string;
  description: string | null;
  approvals: Array<{ type: 'spec' | 'tech_design' | 'qa' }>;
  comments: Array<{ author: string; text: string }>;
}> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    description: null,
    approvals: [],
    comments: [],
    ...overrides
  };
}

describe('detectLegacyApprovals', () => {
  it('detects a checked Approved-by-Tom marker in the description', () => {
    const description = [
      'Some prose',
      '',
      '- [x] **Approved by Tom**',
      '',
      'More prose'
    ].join('\n');

    const detected = detectLegacyApprovals(taskFixture({ description }));

    expect(detected).toEqual([
      {
        type: 'spec',
        owner: 'Tom',
        note: 'Migrated from `**Approved by Tom**` in task description.'
      }
    ]);
  });

  it('skips an unchecked Approved-by-Tom marker', () => {
    const description = '- [ ] **Approved by Tom**';
    const detected = detectLegacyApprovals(taskFixture({ description }));
    expect(detected).toEqual([]);
  });

  it('detects [tech-design-approved] true in a comment', () => {
    const detected = detectLegacyApprovals(
      taskFixture({
        comments: [
          { author: 'Quinn', text: 'Some review text\n\n[tech-design-approved] true\n' }
        ]
      })
    );
    expect(detected).toEqual([
      {
        type: 'tech_design',
        owner: 'Quinn',
        note: 'Migrated from `[tech-design-approved] true` comment.'
      }
    ]);
  });

  it('detects [qa-ac-verified] true in a comment', () => {
    const detected = detectLegacyApprovals(
      taskFixture({
        comments: [{ author: 'Tom', text: '[qa-ac-verified] true' }]
      })
    );
    expect(detected).toEqual([
      {
        type: 'qa',
        owner: 'Tom',
        note: 'Migrated from `[qa-ac-verified] true` comment.'
      }
    ]);
  });

  it('detects multiple approval signals in one task', () => {
    const description = '- [x] **Approved by Tom**';
    const detected = detectLegacyApprovals(
      taskFixture({
        description,
        comments: [
          { author: 'Quinn', text: '[tech-design-approved] true' },
          { author: 'Tom', text: '[qa-ac-verified] true' }
        ]
      })
    );

    expect(detected.map((a) => a.type)).toEqual(['spec', 'tech_design', 'qa']);
  });

  it('returns an empty list when no legacy signals are present', () => {
    const detected = detectLegacyApprovals(
      taskFixture({
        description: 'No approval markers here.',
        comments: [{ author: 'Quinn', text: 'Just a regular comment.' }]
      })
    );
    expect(detected).toEqual([]);
  });
});

describe('existingApprovalKeys', () => {
  it('returns a set of `<taskId>:<type>` strings', () => {
    const keys = existingApprovalKeys(
      taskFixture({
        id: 'task-1',
        approvals: [{ type: 'spec' }, { type: 'qa' }]
      })
    );
    expect([...keys].sort()).toEqual(['task-1:qa', 'task-1:spec']);
  });
});

describe('summarizeMigration', () => {
  it('counts createdApprovals and skippedExisting across the task set', () => {
    const summary = summarizeMigration([
      taskFixture({
        id: 'task-1',
        description: '- [x] **Approved by Tom**',
        approvals: [] // not yet approved in API
      }),
      taskFixture({
        id: 'task-2',
        description: '- [x] **Approved by Tom**',
        approvals: [{ type: 'spec' }] // already approved in API
      }),
      taskFixture({
        id: 'task-3',
        comments: [{ author: 'Tom', text: '[qa-ac-verified] true' }]
      })
    ]);

    expect(summary.totalTasks).toBe(3);
    expect(summary.createdApprovals).toBe(2);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.breakdownByType).toEqual([
      { type: 'spec', created: 1, skippedExisting: 1 },
      { type: 'qa', created: 1, skippedExisting: 0 }
    ]);
  });

  it('returns zero counts when no legacy signals are present', () => {
    const summary = summarizeMigration([
      taskFixture({ description: 'No signals here.' }),
      taskFixture({
        comments: [{ author: 'Quinn', text: 'Plain comment.' }]
      })
    ]);
    expect(summary.totalTasks).toBe(2);
    expect(summary.createdApprovals).toBe(0);
    expect(summary.skippedExisting).toBe(0);
    expect(summary.breakdownByType).toEqual([]);
  });
});
