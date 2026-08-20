import { describe, it, expect, vi } from 'vitest';
import {
  parseEvidenceTag,
  extractAcEvidence,
  checkTestId,
  checkNotTested,
  checkPrReference,
  checkAcEvidence,
  runAllAcChecks,
  verify,
  type AcEvidence,
  type Deps,
  type PrFile,
  type PrSummary,
  type TaskSummary,
} from '../src/verify.ts';

// ---------------------------------------------------------------------------
// parseEvidenceTag — quick anchors against the Rust regex at
// agents/workflows/feature-task/src/ac_parsing.rs:86-115. Both emoji and
// plain variants are accepted; truncated values without a closing `)`
// return null. Note: the Rust regex uses `[^)]+` which stops at the first
// inner `)` — TypeScript port uses non-greedy `[^)]*` to match the
// closest closing paren and tolerate nested parens in values.
// ---------------------------------------------------------------------------

describe('parseEvidenceTag', () => {
  it('recognises testID with no emoji', () => {
    expect(parseEvidenceTag('foo (testID: tests/foo.test.ts)')).toEqual({
      type: 'testID',
      value: 'tests/foo.test.ts',
    });
  });

  it('recognises testID with the 🧪 emoji', () => {
    expect(parseEvidenceTag('foo (🧪 testID: cal-10-day-render)')).toEqual({
      type: 'testID',
      value: 'cal-10-day-render',
    });
  });

  it('recognises not tested with the ⚠️ emoji', () => {
    expect(parseEvidenceTag('foo (⚠️ not tested: drag requires manual browser QA)')).toEqual({
      type: 'not tested',
      value: 'drag requires manual browser QA',
    });
  });

  it('recognises not code with the 📄 emoji', () => {
    expect(parseEvidenceTag('foo (📄 not code: updated docs/systems/content-scheduler.md)')).toEqual({
      type: 'not code',
      value: 'updated docs/systems/content-scheduler.md',
    });
  });

  it('recognises pr with a # reference', () => {
    expect(parseEvidenceTag('foo (pr: #471)')).toEqual({
      type: 'pr',
      value: '#471',
    });
  });

  it('returns null when no evidence tag is present', () => {
    expect(parseEvidenceTag('foo bar baz')).toBeNull();
  });

  it('returns null for unknown annotations like (file: ...)', () => {
    expect(parseEvidenceTag('bar (file: apps/tasks/src/X.jsx:42)')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAcEvidence — pulls every checked AC line out of a PR body.
// ---------------------------------------------------------------------------

describe('extractAcEvidence', () => {
  it('extracts all five ACs with evidence tags', () => {
    const body = `
Some preamble.

- [x] AC1: foo (testID: tests/foo.test.ts)
- [x] AC2: bar (🧪 testID: tests/bar.test.ts)
- [x] AC3: baz (📄 not code: doc update)
- [x] AC4: qux (pr: #471)
- [x] AC5: zut (⚠️ not tested: drag requires manual browser QA)
    `;
    const acs = extractAcEvidence(body);
    expect(acs).toHaveLength(5);
    expect(acs.map((a) => a.ac)).toEqual(['1', '2', '3', '4', '5']);
    expect(acs[0].evidence).toEqual({ type: 'testID', value: 'tests/foo.test.ts' });
    expect(acs[2].evidence).toEqual({ type: 'not code', value: 'doc update' });
    expect(acs[3].evidence).toEqual({ type: 'pr', value: '#471' });
  });

  it('skips unchecked AC lines', () => {
    const body = `
- [x] AC1: foo (testID: tests/foo.test.ts)
- [ ] AC2: not done
    `;
    const acs = extractAcEvidence(body);
    expect(acs).toHaveLength(1);
    expect(acs[0].ac).toBe('1');
  });

  it('returns an empty array when no AC lines are present', () => {
    expect(extractAcEvidence('Just a description, no ACs.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkTestId — structural check on the cited test file path.
// ---------------------------------------------------------------------------

describe('checkTestId', () => {
  const prFiles: PrFile[] = [
    { filename: 'tests/foo.test.ts', status: 'added' },
    { filename: 'src/main.ts', status: 'modified' },
  ];

  it('passes when the cited file is in the diff', () => {
    expect(checkTestId('tests/foo.test.ts', prFiles)).toEqual({ ok: true });
  });

  it('fails when the cited file is NOT in the diff (missing-test case)', () => {
    const result = checkTestId('tests/missing.test.ts', prFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('tests/missing.test.ts');
      expect(result.reason).toContain('not in the merged PR diff');
    }
  });

  it('fails when the value does not look like a test file path', () => {
    const result = checkTestId('some_test_name', prFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('does not look like a test file path');
    }
  });

  it('matches by suffix so packages/.../tests/foo.test.ts find tests/foo.test.ts', () => {
    const deepFiles: PrFile[] = [
      { filename: 'packages/foo/src/tests/foo.test.ts', status: 'added' },
    ];
    expect(checkTestId('tests/foo.test.ts', deepFiles)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// checkNotTested — file-path existence in the diff.
// ---------------------------------------------------------------------------

describe('checkNotTested', () => {
  const prFiles: PrFile[] = [
    { filename: 'agents/ash/src/verify.ts', status: 'added' },
    { filename: 'services/tasks-api/src/config/requiredApprovals.ts', status: 'modified' },
  ];

  it('passes when the cited file is in the diff', () => {
    expect(checkNotTested('agents/ash/src/verify.ts', prFiles)).toEqual({ ok: true });
  });

  it('fails when the cited file is NOT in the diff (missing-artifact case)', () => {
    const result = checkNotTested('apps/tasks/src/newFeature.tsx', prFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('apps/tasks/src/newFeature.tsx');
    }
  });
});

// ---------------------------------------------------------------------------
// checkPrReference — accepts #N references and URLs verbatim; only
// file-path values are checked against the diff.
// ---------------------------------------------------------------------------

describe('checkPrReference', () => {
  const prFiles: PrFile[] = [
    { filename: 'services/tasks-api/prisma/schema.prisma', status: 'modified' },
  ];

  it('passes for a #N sibling PR reference', () => {
    expect(checkPrReference('#471', prFiles)).toEqual({ ok: true });
  });

  it('passes for a full URL sibling PR reference', () => {
    expect(checkPrReference('https://github.com/foo/bar/pull/471', prFiles)).toEqual({ ok: true });
  });

  it('fails when a file path is cited but not in the diff (missing-artifact case)', () => {
    const result = checkPrReference('services/tasks-api/src/newFile.ts', prFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not in the merged PR diff');
    }
  });
});

// ---------------------------------------------------------------------------
// checkAcEvidence — routing by evidence type.
// ---------------------------------------------------------------------------

describe('checkAcEvidence', () => {
  const prFiles: PrFile[] = [
    { filename: 'tests/foo.test.ts', status: 'added' },
  ];

  it('returns a failure when evidence is null', () => {
    const ac: AcEvidence = { ac: '1', description: 'no tag here', evidence: null };
    const result = checkAcEvidence(ac, prFiles);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('AC1');
      expect(result.reason).toContain('no evidence tag');
    }
  });

  it('routes testID to checkTestId', () => {
    const ac: AcEvidence = {
      ac: '2',
      description: 'foo (testID: tests/foo.test.ts)',
      evidence: { type: 'testID', value: 'tests/foo.test.ts' },
    };
    expect(checkAcEvidence(ac, prFiles)).toEqual({ ok: true });
  });

  it('routes not code to a no-op success', () => {
    const ac: AcEvidence = {
      ac: '3',
      description: 'foo (📄 not code: doc update)',
      evidence: { type: 'not code', value: 'doc update' },
    };
    expect(checkAcEvidence(ac, prFiles)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// runAllAcChecks — collects per-AC results.
// ---------------------------------------------------------------------------

describe('runAllAcChecks', () => {
  it('returns one result per AC, pass and fail', () => {
    const body = `
- [x] AC1: foo (testID: tests/foo.test.ts)
- [x] AC2: bar (testID: tests/missing.test.ts)
- [x] AC3: baz (📄 not code: doc update)
    `;
    const prFiles: PrFile[] = [{ filename: 'tests/foo.test.ts', status: 'added' }];
    const results = runAllAcChecks(body, prFiles);
    expect(results).toHaveLength(3);
    expect(results[0].result.ok).toBe(true);
    expect(results[1].result.ok).toBe(false);
    expect(results[2].result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify() — the three AC3 test cases driven through the orchestrator
// with injected I/O deps. Each case asserts:
//   (a) the outcome is ok: false
//   (b) the comment text begins with [qa-agent-blocked]
//   (c) postApproval was NOT called
//   (d) the failure reason names the specific claim that failed
// ---------------------------------------------------------------------------

const task: TaskSummary = { id: 'f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47', status: 'doing' };

function makeDeps(pr: PrSummary, posts: { approval: string[]; comments: string[] }) {
  const postApproval = vi.fn(async (taskId: string, type: string) => {
    posts.approval.push(`${taskId}:${type}`);
  });
  const postComment = vi.fn(async (_taskId: string, text: string) => {
    posts.comments.push(text);
  });
  const fetchPr = vi.fn(async (_url: string) => pr);
  const fetchTask = vi.fn(async (_id: string) => task);
  return { deps: { fetchTask, fetchPr, postComment, postApproval } satisfies Deps, postApproval, postComment };
}

describe('verify() — AC3 missing-test case', () => {
  it('posts [qa-agent-blocked] naming the missing test file and does NOT post approval', async () => {
    const pr: PrSummary = {
      number: 474,
      state: 'merged',
      merged: true,
      body: `
- [x] AC1: A new workflowGate is created (testID: tests/foo.test.ts)
- [x] AC2: Missing test (testID: tests/missing.test.ts)
- [x] AC3: Stub (📄 not code: doc update)
      `,
      files: [{ filename: 'tests/foo.test.ts', status: 'added' }],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText.startsWith('[qa-agent-blocked]')).toBe(true);
    expect(outcome.commentText).toContain('tests/missing.test.ts');
    expect(postApproval).not.toHaveBeenCalled();
  });
});

describe('verify() — AC3 missing-artifact case', () => {
  it('posts [qa-agent-blocked] naming the missing artifact and does NOT post approval', async () => {
    const pr: PrSummary = {
      number: 474,
      state: 'merged',
      merged: true,
      body: `
- [x] AC1: One passing AC (testID: tests/foo.test.ts)
- [x] AC2: Missing artifact (pr: apps/tasks/src/newFeature.tsx)
- [x] AC3: Adds something (testID: tests/bar.test.ts)
      `,
      files: [
        { filename: 'tests/foo.test.ts', status: 'added' },
        { filename: 'tests/bar.test.ts', status: 'added' },
      ],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText.startsWith('[qa-agent-blocked]')).toBe(true);
    expect(outcome.commentText).toContain('apps/tasks/src/newFeature.tsx');
    expect(postApproval).not.toHaveBeenCalled();
  });
});

describe('verify() — AC3 fabricated-evidence case', () => {
  it('posts [qa-agent-blocked] when the diff has no code changes despite a testID claim', async () => {
    // PR body claims a test exists at agents/ash/test/verify.test.ts:50
    // but the diff only adds a README. The testID value matches the
    // *.test.ts shape, so the structural check sees the cited file
    // IS in the diff — but the rest of the diff is missing the claimed
    // code surface. We exercise the "fabricated claim" path by including
    // a testID that points to a file that exists in the diff but with
    // data that does not match the AC's stated claim.
    //
    // The deterministic structural check the design commits to (per
    // design step 9 + open question #2) is "every cited test name/file
    // exists in the repo and passes, every cited artifact/file path
    // actually exists, AC evidence text cross-checked against the real
    // diff for overstated or fabricated claims." The "passes" and
    // "claim-vs-diff" axes are out of scope for the structural check;
    // they land in the follow-up dynamic-test-execution pass. Here we
    // assert the structural surface AC3 is wired to: the cited file
    // exists in the diff, and any fabricated file path is named.
    const pr: PrSummary = {
      number: 474,
      state: 'merged',
      merged: true,
      body: `
- [x] AC1: Real test (testID: tests/foo.test.ts)
- [x] AC2: Fabricated check (testID: tests/fabricated.test.ts)
- [x] AC3: Doc-only (📄 not code: README only)
      `,
      files: [
        // Only the README is in the diff — the test file is fabricated.
        { filename: 'agents/ash/README.md', status: 'added' },
      ],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText.startsWith('[qa-agent-blocked]')).toBe(true);
    // Both testIDs are missing from the diff — both should be named.
    expect(outcome.commentText).toContain('tests/foo.test.ts');
    expect(outcome.commentText).toContain('tests/fabricated.test.ts');
    expect(postApproval).not.toHaveBeenCalled();
  });
});

describe('verify() — happy path', () => {
  it('posts approval and a [qa-agent-verified] comment when all ACs pass', async () => {
    const pr: PrSummary = {
      number: 474,
      state: 'merged',
      merged: true,
      body: `
- [x] AC1: Real test (testID: tests/foo.test.ts)
- [x] AC2: Doc update (📄 not code: README added)
      `,
      files: [
        { filename: 'tests/foo.test.ts', status: 'added' },
        { filename: 'agents/ash/README.md', status: 'added' },
      ],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(true);
    expect(postApproval).toHaveBeenCalledWith(task.id, 'qa_agent');
    expect(outcome.commentText.startsWith('[qa-agent-verified]')).toBe(true);
  });
});

describe('verify() — pre-conditions', () => {
  it('returns a no-PR-URL outcome when no PR URL is supplied', async () => {
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(
      { number: 1, state: 'merged', merged: true, body: '', files: [] },
      posts,
    );

    const outcome = await verify(task.id, '', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('No PR URL');
    expect(postApproval).not.toHaveBeenCalled();
  });

  it('returns a not-merged outcome when the PR is open', async () => {
    const pr: PrSummary = {
      number: 474,
      state: 'open',
      merged: false,
      body: '- [x] AC1: foo (testID: tests/foo.test.ts)',
      files: [{ filename: 'tests/foo.test.ts', status: 'added' }],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('not merged');
    expect(postApproval).not.toHaveBeenCalled();
  });

  it('returns a no-evidence-tag outcome when the PR body has no AC tags', async () => {
    const pr: PrSummary = {
      number: 474,
      state: 'merged',
      merged: true,
      body: 'Just a description, no ACs.',
      files: [],
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const { deps, postApproval } = makeDeps(pr, posts);

    const outcome = await verify(task.id, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('No AC evidence tags');
    expect(postApproval).not.toHaveBeenCalled();
  });
});
