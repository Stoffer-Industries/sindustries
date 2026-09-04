import { describe, it, expect, vi } from 'vitest';
import {
  verifySemantic,
  extractAcLines,
  defaultJudgeIntent,
  type AcEvidence,
  type Deps,
  type JudgeIntentResult,
  type PrFile,
  type PrSummary,
} from '../src/verify.ts';

// ---------------------------------------------------------------------------
// extractAcLines — minimal AC walker. Strips trailing evidence annotations
// so the LLM judge prompt sees the bare AC description.
//
// The lobster's parse_evidence at agents/workflows/feature-task/src/ac_parsing.rs:86
// is the canonical evidence-tag parser; here we only walk AC lines for
// the semantic loop. The two implementations must agree on the
// `(testID|not tested|not code|pr: <value>)` annotation shape.
// ---------------------------------------------------------------------------

describe('extractAcLines', () => {
  it('extracts all five ACs and strips trailing evidence', () => {
    const body = `
Some preamble.

- [x] AC1: foo (testID: tests/foo.test.ts)
- [x] AC2: bar (🧪 testID: tests/bar.test.ts)
- [x] AC3: baz (📄 not code: doc update)
- [x] AC4: qux (pr: #471)
- [x] AC5: zut (⚠️ not tested: drag requires manual browser QA)
    `;
    const acs = extractAcLines(body);
    expect(acs).toHaveLength(5);
    expect(acs.map((a) => a.ac)).toEqual(['1', '2', '3', '4', '5']);
    // Evidence stripped so the LLM judge doesn't see the testID tag.
    expect(acs[0].description).toBe('foo');
    expect(acs[2].description).toBe('baz');
    expect(acs[3].description).toBe('qux');
  });

  it('returns the bare description when no evidence tag is present', () => {
    const body = `
- [x] AC1: standalone description
- [x] AC2: another (testID: tests/foo.test.ts)
    `;
    const acs = extractAcLines(body);
    expect(acs).toHaveLength(2);
    expect(acs[0].description).toBe('standalone description');
    expect(acs[1].description).toBe('another');
  });

  it('skips unchecked AC lines', () => {
    const body = `
- [x] AC1: done (testID: tests/foo.test.ts)
- [ ] AC2: not done (testID: tests/bar.test.ts)
    `;
    const acs = extractAcLines(body);
    expect(acs).toHaveLength(1);
    expect(acs[0].ac).toBe('1');
  });

  it('returns an empty array when no AC lines are present', () => {
    expect(extractAcLines('Just a description, no ACs.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defaultJudgeIntent — Quinn's deterministic v1 (token-overlap heuristic).
// Strict on presence, conservative on `ok: false`. False negatives bounce
// back to the implementer with a precise reason; false positives are
// the dangerous direction so the heuristic errs strict.
// ---------------------------------------------------------------------------

describe('defaultJudgeIntent', () => {
  it('returns ok: true when every meaningful token from the AC description appears in the patch', async () => {
    const result = await defaultJudgeIntent(
      { ac: '1', description: 'oauth callback handler' },
      'diff --git a/services/oauth.ts b/services/oauth.ts\n+// OAuth callback handler — wired into the router.\n+export const oauthCallback = () => { ... }',
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok: true with case-insensitive matching', async () => {
    const result = await defaultJudgeIntent(
      { ac: '1', description: 'OPENCLAW PKCE handshake' },
      'diff --git a/x.ts b/x.ts\n+// OpenClaw now completes the PKCE handshake end-to-end.',
    );
    expect(result.ok).toBe(true);
  });

  it('splits camelCase identifiers so each piece is checked independently', async () => {
    const result = await defaultJudgeIntent(
      { ac: '1', description: 'oauthClientCredentials grant' },
      // Realistic patch: an explanatory comment plus the camelCase identifier.
      'diff --git a/x.ts b/x.ts\n+// OAuth client credentials grant type\n+const oauthClientCredentials = ...',
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok: false when a meaningful token from the AC is missing from the patch', async () => {
    const result = await defaultJudgeIntent(
      { ac: '3', description: 'the MCP handshake' },
      'diff --git a/x.ts b/x.ts\n+// initialize() is wired but the handshake state is missing',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('AC3');
      // 'mcp' is the discriminator — the patch has "handshake" but not "MCP".
      expect(result.reason).toContain('mcp');
    }
  });

  it('returns ok: false when the patch is empty (defensive)', async () => {
    const result = await defaultJudgeIntent(
      { ac: '1', description: 'oauth callback handler' },
      '',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('empty');
    }
  });

  it('returns ok: false when the AC description has no meaningful tokens (stopwords only)', async () => {
    const result = await defaultJudgeIntent(
      { ac: '1', description: 'add it' },
      'diff --git a/foo b/foo\n+added',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('no meaningful tokens');
    }
  });

  it('returns ok: false with an explicit reason when the AC description is empty', async () => {
    const result = await defaultJudgeIntent({ ac: '1', description: '' }, 'diff\n+added');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('no meaningful tokens');
    }
  });

  it('truncates the missing-token list at 5 entries in the reason', async () => {
    const result = await defaultJudgeIntent(
      {
        ac: '7',
        description: 'alpha bravo charlie delta echo foxtrot golf',
      },
      // None of the meaningful tokens appear in this patch.
      'diff --git a/x.ts b/x.ts\n+// unrelated change',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('AC7');
      // 5 tokens listed + an ellipsis indicator.
      expect(result.reason).toMatch(/\[.+, .+, .+, .+, .+, …\]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Test fixtures — shared across the four semantic-contract pin tests.
// ---------------------------------------------------------------------------

const taskId = 'f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47';

function makeDeps(opts: {
  pr: PrSummary;
  posts: { approval: string[]; comments: string[] };
  judgeIntent: Deps['judgeIntent'];
}) {
  const postApproval = vi.fn(async (id: string, type: string) => {
    opts.posts.approval.push(`${id}:${type}`);
  });
  const postComment = vi.fn(async (_id: string, text: string) => {
    opts.posts.comments.push(text);
  });
  const fetchPr = vi.fn(async (_url: string) => opts.pr);
  return {
    deps: { fetchPr, postComment, postApproval, judgeIntent: opts.judgeIntent } satisfies Deps,
    postApproval,
    postComment,
  };
}

function makePr(body: string, files: PrFile[] = [], patch = ''): PrSummary {
  return {
    number: 474,
    state: 'merged',
    merged: true,
    body,
    files,
    patch,
  };
}

// ---------------------------------------------------------------------------
// verifySemantic — semantic-contract pin tests. These pin the I/O
// contract (which comment shapes stay machine-parseable, when postApproval
// fires) and don't depend on Quinn's actual judgment logic. Replace
// the fake judgeIntent with a real impl when Quinn lands it.
// ---------------------------------------------------------------------------

describe('verifySemantic — judgeIntent returns ok: true for every AC', () => {
  it('posts [qa-agent-verified] and satisfies the qa_agent gate', async () => {
    const pr = makePr(
      `- [x] AC1: do the thing (testID: tests/foo.test.ts)
- [x] AC2: add a doc (📄 not code: README added)`,
      [],
      'diff --git a/foo b/foo\n+added',
    );
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (_ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => ({ ok: true }),
    );
    const { deps, postApproval } = makeDeps({ pr, posts, judgeIntent: fakeJudge });

    const outcome = await verifySemantic(taskId, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.commentText.startsWith('[qa-agent-verified]')).toBe(true);
    expect(postApproval).toHaveBeenCalledWith(taskId, 'qa_agent');
    // Both ACs passed through the fake — no failures reported.
    expect(fakeJudge).toHaveBeenCalledTimes(2);
  });
});

describe('verifySemantic — judgeIntent returns ok: false for one AC', () => {
  it('posts [qa-agent-blocked] naming the failing AC and does NOT satisfy the gate', async () => {
    const pr = makePr(
      `- [x] AC1: happy path (testID: tests/foo.test.ts)
- [x] AC2: error path (testID: tests/bar.test.ts)`,
      [],
      'diff --git a/foo b/foo\n+added only happy path',
    );
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => {
        if (ac.ac === '2') {
          return {
            ok: false,
            reason:
              'AC2 implementation handles the happy path but not the error case mentioned in the AC text',
          };
        }
        return { ok: true };
      },
    );
    const { deps, postApproval } = makeDeps({ pr, posts, judgeIntent: fakeJudge });

    const outcome = await verifySemantic(taskId, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText.startsWith('[qa-agent-blocked]')).toBe(true);
    expect(outcome.commentText).toContain('AC2');
    expect(outcome.commentText).toContain('error case');
    expect(postApproval).not.toHaveBeenCalled();
  });
});

describe('verifySemantic — pre-conditions', () => {
  it('returns a no-PR-URL outcome when no PR URL is supplied', async () => {
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (_ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => ({ ok: true }),
    );
    const { deps, postApproval } = makeDeps({
      pr: makePr('', [], ''),
      posts,
      judgeIntent: fakeJudge,
    });

    const outcome = await verifySemantic(taskId, '', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('No PR URL');
    expect(postApproval).not.toHaveBeenCalled();
  });

  it('returns a not-merged outcome when the PR is open', async () => {
    const pr: PrSummary = {
      ...makePr('- [x] AC1: foo (testID: tests/foo.test.ts)'),
      state: 'open',
      merged: false,
    };
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (_ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => ({ ok: true }),
    );
    const { deps, postApproval } = makeDeps({
      pr,
      posts,
      judgeIntent: fakeJudge,
    });

    const outcome = await verifySemantic(taskId, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('not merged');
    expect(postApproval).not.toHaveBeenCalled();
  });

  it('returns a no-AC-lines outcome when the PR body has no AC tags', async () => {
    const pr = makePr('Just a description, no ACs.', [], '');
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (_ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => ({ ok: true }),
    );
    const { deps, postApproval } = makeDeps({
      pr,
      posts,
      judgeIntent: fakeJudge,
    });

    const outcome = await verifySemantic(taskId, 'https://github.com/owner/repo/pull/474', deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.commentText).toContain('No AC evidence tags');
    expect(postApproval).not.toHaveBeenCalled();
  });
});

describe('verifySemantic — judgeIntent gets the AC description and patch text', () => {
  it('forwards the bare AC description (without trailing evidence) and the PR patch', async () => {
    const pr = makePr(
      `- [x] AC1: wire the oauth route (testID: tests/auth.test.ts)`,
      [],
      'diff --git a/services/x.ts b/services/x.ts\n+export const oauth = () => { ... }',
    );
    const posts = { approval: [] as string[], comments: [] as string[] };
    const fakeJudge: Deps['judgeIntent'] = vi.fn(
      async (_ac: AcEvidence, _patch: string): Promise<JudgeIntentResult> => ({ ok: true }),
    );
    const { deps } = makeDeps({ pr, posts, judgeIntent: fakeJudge });

    await verifySemantic(taskId, 'https://github.com/owner/repo/pull/474', deps);

    expect(fakeJudge).toHaveBeenCalledTimes(1);
    const mock = fakeJudge as unknown as { mock: { calls: Array<[AcEvidence, string]> } };
    const firstCall = mock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [ac, patchText] = firstCall!;
    expect(ac).toEqual({ ac: '1', description: 'wire the oauth route' });
    expect(patchText).toContain('export const oauth');
  });
});
