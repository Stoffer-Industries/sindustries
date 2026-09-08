/**
 * Ash QA-verifier agent: utility module for AC-line extraction, trailing
 * evidence stripping, and PR summary fetching.
 *
 * Pure functions in this file are exported for unit testing.
 *
 * **Scope (after task 0b16dc37):** this file is **utility-only**. The bespoke
 * `defaultJudgeIntent` placeholder that lived here until 2026-09-08 has been
 * removed; Ash's judgment now runs through her own reasoning loop (see
 * `agents/definitions/ash/{HEARTBEAT,WORKFLOW}.md`), not through a CLI
 * invocation of this file. This module is loaded by Ash's agent context for
 * `extractAcLines` + `stripTrailingEvidence` (so the bare AC description
 * reaches the judgment prompt without test-ID noise) and for `fetchPrSummary`
 * (so the PR body, file list, and raw patch text are available for Ash's
 * reasoning tools to consume).
 *
 * Per `docs/specs/ash-prompt-driven-verifier-tech-design.md`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One parsed AC line from a PR body. Ash's reasoning loop reads the bare
 * description (without trailing evidence annotation) — the evidence
 * tag scope is owned by the lobster's mechanical-evidence gate.
 */
export type AcEvidence = {
  ac: string;
  description: string;
};

export type PrFile = {
  filename: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed';
  additions?: number;
  deletions?: number;
};

export type PrSummary = {
  number: number;
  state: 'open' | 'closed' | 'merged';
  merged: boolean;
  body: string;
  files: PrFile[];
  /**
   * The raw patch text (concatenated per-file diffs). Populated by
   * `fetchPrSummary` via the GitHub patch API
   * (`Accept: application/vnd.github.v3.patch`); tests can inject a stub
   * that returns a smaller string. Ash's reasoning step reads this
   * directly via her own tool calls — the file does not embed it in an
   * LLM prompt.
   */
  patch: string;
};

// ---------------------------------------------------------------------------
// AC line extraction — minimal, no evidence parsing.
// ---------------------------------------------------------------------------

// Same regex as the lobster's evidence parser
// (`agents/workflows/feature-task/src/ac_parsing.rs:127`); both surfaces
// must agree on the AC line shape so the bare descriptions Ash reasons
// over line up with the lobster's mechanical-evidence gate. We only walk
// AC lines here for the agent's reasoning loop; the lobster owns the
// canonical evidence-tag parsing.
const AC_LINE_RE = /^\s*-\s*\[[xX]\]\s*AC(\d+):\s*(.+)$/;

export function extractAcLines(prBody: string): AcEvidence[] {
  const result: AcEvidence[] = [];
  for (const line of prBody.split('\n')) {
    const m = line.match(AC_LINE_RE);
    if (!m) continue;
    // The lobster's parse_evidence handles `(testID: ...)` /
    // `(not tested: ...)` annotations. For Ash's reasoning prompt we
    // want the bare AC description — strip the trailing evidence
    // annotation if any so the agent's prompt doesn't get thrown by
    // test IDs.
    const description = stripTrailingEvidence(m[2].trim());
    result.push({ ac: m[1], description });
  }
  return result;
}

export function stripTrailingEvidence(text: string): string {
  // Mirrors the lobster's strip_trailing_evidence regex shape: a
  // trailing `(keyword: value)` block. The keyword is one of
  // testID | not tested | not code | pr, with optional non-letter,
  // non-`)` prefix (emoji, space, punctuation).
  const m = text.match(/\s*\(([^a-zA-Z)]*)(testID|not tested|not code|pr):\s*[^)]+\)\s*$/);
  if (!m) return text;
  return text.slice(0, m.index).trimEnd();
}

// ---------------------------------------------------------------------------
// PR summary fetching — returns body, file list, and raw patch text for
// Ash's reasoning loop to consume via the agent's own tool calls.
// ---------------------------------------------------------------------------

function parseGhRepo(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Fetch a PR's summary (body + file list + raw patch) via the GitHub REST
 * API. `token` is expected to be set from `ASH_GITHUB_TOKEN` in Ash's
 * runtime env; throws synchronously when the token is missing so Ash's
 * heartbeat surfaces a fail-loud error rather than silently producing
 * empty evidence.
 */
export async function fetchPrSummary(prUrl: string, token: string): Promise<PrSummary> {
  if (!token) {
    throw new Error('fetchPrSummary requires a non-empty GitHub token (ASH_GITHUB_TOKEN)');
  }
  const repo = parseGhRepo(prUrl);
  if (!repo) throw new Error(`cannot parse PR URL: ${prUrl}`);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const prRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${repo.number}`,
    { headers },
  );
  if (!prRes.ok) throw new Error(`fetch PR ${prUrl} failed: ${prRes.status} ${prRes.statusText}`);
  const prJson = (await prRes.json()) as {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    body: string;
  };

  const filesRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${repo.number}/files?per_page=100`,
    { headers },
  );
  if (!filesRes.ok)
    throw new Error(`fetch PR files ${prUrl} failed: ${filesRes.status} ${filesRes.statusText}`);
  const files = (await filesRes.json()) as Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    additions: number;
    deletions: number;
  }>;

  // Pull the raw patch text for the reasoning loop. The `.patch` media
  // type returns the unified diff as plain text — Ash's reasoning tools
  // can either embed it directly or read cited files individually.
  const patchRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${repo.number}`,
    { headers: { ...headers, Accept: 'application/vnd.github.v3.patch' } },
  );
  if (!patchRes.ok)
    throw new Error(`fetch PR patch ${prUrl} failed: ${patchRes.status} ${patchRes.statusText}`);
  const patch = await patchRes.text();

  return {
    number: prJson.number,
    state: prJson.merged ? 'merged' : (prJson.state as 'open' | 'closed'),
    merged: prJson.merged,
    body: prJson.body ?? '',
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
    patch,
  };
}
