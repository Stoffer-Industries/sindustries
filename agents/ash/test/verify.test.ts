import { describe, it, expect, vi } from 'vitest';
import {
  extractAcLines,
  stripTrailingEvidence,
  fetchPrSummary,
  type AcEvidence,
  type PrFile,
  type PrSummary,
} from '../src/verify.ts';

// ---------------------------------------------------------------------------
// extractAcLines — minimal AC walker. Strips trailing evidence annotations
// so Ash's reasoning prompt sees the bare AC description.
//
// The lobster's parse_evidence at agents/workflows/feature-task/src/ac_parsing.rs:86
// is the canonical evidence-tag parser; here we only walk AC lines for
// Ash's reasoning context. The two implementations must agree on the
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
// stripTrailingEvidence — standalone export so the lobster's annotation
// shape can be reused by other consumers (e.g. an external tool that
// needs to strip evidence from a PR description without walking ACs).
// ---------------------------------------------------------------------------

describe('stripTrailingEvidence', () => {
  it('strips a trailing testID annotation', () => {
    expect(stripTrailingEvidence('wire the oauth route (testID: tests/auth.test.ts)')).toBe(
      'wire the oauth route',
    );
  });

  it('strips a trailing not-tested annotation with emoji prefix', () => {
    expect(
      stripTrailingEvidence('manually verify button click (⚠️ not tested: needs browser QA)'),
    ).toBe('manually verify button click');
  });

  it('returns the input unchanged when no annotation is present', () => {
    expect(stripTrailingEvidence('standalone description')).toBe('standalone description');
  });
});

// ---------------------------------------------------------------------------
// fetchPrSummary — fetches PR body + file list + raw patch via the GitHub
// REST API. Tests stub `fetch` with a fake that returns the three
// endpoints Ash's reasoning loop consumes. Live behavior (real network
// calls, real auth) is exercised through Ash's heartbeat path, not unit
// tests.
// ---------------------------------------------------------------------------

describe('fetchPrSummary', () => {
  function makeFakeFetch(handlers: {
    prJson: Record<string, unknown>;
    filesJson: unknown[];
    patchText: string;
  }) {
    return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      // PR JSON endpoint
      if (u.pathname.match(/\/pulls\/\d+$/)) {
        const accept = init?.headers?.['Accept'] ?? init?.headers?.['accept'] ?? '';
        if (accept === 'application/vnd.github.v3.patch') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => handlers.patchText,
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => handlers.prJson,
          text: async () => '',
        } as unknown as Response;
      }
      // PR files endpoint
      if (u.pathname.match(/\/pulls\/\d+\/files/)) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => handlers.filesJson,
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch URL: ${url}`);
    });
  }

  it('fetches body + files + patch from the three PR endpoints', async () => {
    const fakeFetch = makeFakeFetch({
      prJson: {
        number: 471,
        state: 'closed',
        merged: true,
        body: '- [x] AC1: do the thing (testID: tests/foo.test.ts)',
      },
      filesJson: [
        { filename: 'src/foo.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'tests/foo.test.ts', status: 'modified', additions: 10, deletions: 0 },
      ],
      patchText: 'diff --git a/src/foo.ts b/src/foo.ts\n+added',
    });
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const pr = await fetchPrSummary('https://github.com/o/r/pull/471', 'fake-token');
      expect(pr.number).toBe(471);
      expect(pr.merged).toBe(true);
      expect(pr.state).toBe('merged');
      expect(pr.body).toContain('AC1');
      expect(pr.files).toHaveLength(2);
      expect(pr.patch).toContain('+added');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
  });

  it('throws when the token is missing', async () => {
    await expect(
      fetchPrSummary('https://github.com/o/r/pull/471', ''),
    ).rejects.toThrow(/ASH_GITHUB_TOKEN/);
  });

  it('throws on a non-github URL', async () => {
    await expect(
      fetchPrSummary('https://example.com/no-such-pr', 'fake-token'),
    ).rejects.toThrow(/cannot parse PR URL/);
  });
});

// Suppress unused-import warnings: AcEvidence / PrFile / PrSummary are
// exported types used by Ash's reasoning context (and by future test
// files) but not directly referenced inside this file's runtime
// assertions.
type _Unused = AcEvidence | PrFile | PrSummary;
const _u: _Unused | undefined = undefined;
void _u;
