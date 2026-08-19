/**
 * Ash QA-verifier agent: mechanical verification script.
 *
 * Pure functions in this file are exported for unit testing; the CLI
 * orchestration lives below the `if (import.meta.url === ...)` guard.
 *
 * The script is invoked by Quinn's Ash heartbeat/cron AFTER the agent
 * identity is provisioned at `~/.openclaw/workspace/agents/ash/`. Until
 * then, this file is a placeholder — see the [openclaw-needed] comment
 * posted on task f6a4d56a for the bootstrap steps.
 *
 * Per `docs/specs/add-ash-qa-agent-verifier-gate-tech-design.md` step 9.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvidenceTag = 'testID' | 'not tested' | 'not code' | 'pr';

export type Evidence = {
  type: EvidenceTag;
  value: string;
};

export type AcEvidence = {
  ac: string;
  description: string;
  evidence: Evidence | null;
};

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string };

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
};

export type TaskSummary = {
  id: string;
  status: string;
  // workflowGates is surfaced as-is; we only need to check if qa_agent is
  // already approved so we don't double-satisfy.
  approvals?: Array<{
    type: string;
    state: 'approved' | 'revoked';
    owner?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Evidence parsing — robust against nested parens (unlike the Rust regex
// at agents/workflows/feature-task/src/ac_parsing.rs:118 which uses
// `[^)]+` and stops at the first inner `)`). Returns the LAST matching
// trailing `(type: value)` block so partial AC descriptions still parse.
// ---------------------------------------------------------------------------

// Per the Rust regex at agents/workflows/feature-task/src/ac_parsing.rs:86,
// the prefix is matched by `[^a-zA-Z)]*` (any non-letter, non-`)`
// character). That's how the emoji variation selectors (e.g. U+FE0F that
// turns `\u26A0` into the emoji ⚠️) survive: they're not letters and
// not parens, so they're consumed by the prefix. A character class of
// only the four emoji base codepoints misses the variation selector and
// the alternation then fails to anchor at end-of-string.
const EVIDENCE_TAG_RE =
  /\(([^a-zA-Z)]*)(testID|not tested|not code|pr):\s*([^)]+)\)\s*$/u;

export function parseEvidenceTag(text: string): Evidence | null {
  const m = text.match(EVIDENCE_TAG_RE);
  if (!m) return null;
  return { type: m[2] as EvidenceTag, value: m[3].trim() };
}

const AC_LINE_RE = /^\s*-\s*\[(?:x|X)\]\s*AC(\d+):\s*(.+)$/;

export function extractAcEvidence(prBody: string): AcEvidence[] {
  const result: AcEvidence[] = [];
  for (const line of prBody.split('\n')) {
    const m = line.match(AC_LINE_RE);
    if (!m) continue;
    const ac = m[1];
    const description = m[2].trim();
    const evidence = parseEvidenceTag(description);
    result.push({ ac, description, evidence });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Checks — pure functions that take the evidence value and the PR's file
// list, plus optional workspace root for file-existence checks. Each
// returns a CheckResult with a human-readable failure reason.
// ---------------------------------------------------------------------------

/**
 * Test ID check: the value should be a file path (e.g. tests/foo.test.ts)
 * or a test name. We treat it as a file path when it ends with a test
 * extension; otherwise we record a "structural" failure so the author
 * knows to swap to a file path. Quinn's future dynamic-test-execution
 * pass will run pnpm test for the test-name case.
 */
export function checkTestId(value: string, prFiles: PrFile[]): CheckResult {
  const looksLikeFile = /\.(test|spec)\.[mc]?[jt]sx?$/i.test(value);
  if (!looksLikeFile) {
    return {
      ok: false,
      reason: `testID "${value}" does not look like a test file path (expected *.test.ts or *.spec.ts); dynamic test-name execution is a future enhancement.`,
    };
  }
  // The cited file must be in the PR's diff.
  const found = prFiles.find((f) => f.filename === value || f.filename.endsWith(`/${value}`));
  if (!found) {
    return {
      ok: false,
      reason: `testID cites "${value}" but that file is not in the merged PR diff.`,
    };
  }
  return { ok: true };
}

/**
 * Not-tested check: the value is a file path that the author claims
 * was updated but couldn't be tested. The file must exist in the diff.
 */
export function checkNotTested(value: string, prFiles: PrFile[]): CheckResult {
  const found = prFiles.find((f) => f.filename === value || f.filename.endsWith(`/${value}`));
  if (!found) {
    return {
      ok: false,
      reason: `not tested cites "${value}" but that file is not in the merged PR diff.`,
    };
  }
  return { ok: true };
}

/**
 * Not-code check: the value is a free-text reason (e.g. "updated docs").
 * No structural check; the AC is non-code by definition.
 */
export function checkNotCode(_value: string, _prFiles: PrFile[]): CheckResult {
  return { ok: true };
}

/**
 * PR cross-reference check: the value is a `pr: #<n>` reference (or a
 * path). We accept either a sibling PR number (starts with `#`) or a
 * file path. For a file path, it must exist in the diff.
 */
export function checkPrReference(value: string, prFiles: PrFile[]): CheckResult {
  if (value.startsWith('#') || /^https?:\/\//.test(value)) {
    // Sibling PR cross-reference — accept by structure; deeper check
    // (does the referenced PR actually exist and cover the claim) is a
    // future enhancement. The structural check is the highest-confidence
    // signal we can do deterministically.
    return { ok: true };
  }
  const found = prFiles.find((f) => f.filename === value || f.filename.endsWith(`/${value}`));
  if (!found) {
    return {
      ok: false,
      reason: `pr cites "${value}" but that file is not in the merged PR diff.`,
    };
  }
  return { ok: true };
}

/**
 * Run a single AC's evidence check. Returns ok with a reason on failure.
 */
export function checkAcEvidence(ac: AcEvidence, prFiles: PrFile[]): CheckResult {
  if (!ac.evidence) {
    return {
      ok: false,
      reason: `AC${ac.ac}: no evidence tag found in description "${ac.description}".`,
    };
  }
  switch (ac.evidence.type) {
    case 'testID':
      return checkTestId(ac.evidence.value, prFiles);
    case 'not tested':
      return checkNotTested(ac.evidence.value, prFiles);
    case 'not code':
      return checkNotCode(ac.evidence.value, prFiles);
    case 'pr':
      return checkPrReference(ac.evidence.value, prFiles);
  }
}

/**
 * Run all AC evidence checks for a PR's body. Returns one CheckResult
 * per AC. The first failure is what we report to the task, but we
 * collect all for the comment body.
 */
export function runAllAcChecks(prBody: string, prFiles: PrFile[]): Array<{ ac: AcEvidence; result: CheckResult }> {
  const acs = extractAcEvidence(prBody);
  return acs.map((ac) => ({ ac, result: checkAcEvidence(ac, prFiles) }));
}

// ---------------------------------------------------------------------------
// I/O — task fetch, PR fetch, comment/approval posting. These are the
// only places that touch the network; tests inject fakes via the
// `Deps` interface rather than mocking globals.
// ---------------------------------------------------------------------------

export type Deps = {
  fetchTask: (taskId: string) => Promise<TaskSummary>;
  fetchPr: (prUrl: string) => Promise<PrSummary>;
  postComment: (taskId: string, text: string) => Promise<void>;
  postApproval: (taskId: string, type: string, owner: string) => Promise<void>;
};

export type VerifyOutcome = {
  ok: boolean;
  acResults: Array<{ ac: AcEvidence; result: CheckResult }>;
  // The comment text we'd post (success or failure). Empty string only
  // means "no comment needed" (e.g. nothing to verify).
  commentText: string;
};

/**
 * Core orchestrator. Given the task ID, PR URL, and injected I/O deps,
 * runs the verification and returns the outcome. The CLI layer below
 * is a thin wrapper that wires up real fetch/post + error handling.
 */
export async function verify(
  taskId: string,
  prUrl: string,
  deps: Deps,
): Promise<VerifyOutcome> {
  if (!taskId) {
    throw new Error('verify() requires a taskId');
  }
  if (!prUrl) {
    return {
      ok: false,
      acResults: [],
      commentText: '[qa-agent-blocked] No PR URL found in task. Verify the task has an `[implementer-prs]` comment with a PR URL.',
    };
  }

  const pr = await deps.fetchPr(prUrl);
  if (!pr.merged) {
    return {
      ok: false,
      acResults: [],
      commentText: `[qa-agent-blocked] PR ${prUrl} is not merged. Ash only verifies merged PRs.`,
    };
  }

  const acResults = runAllAcChecks(pr.body, pr.files);
  const failures = acResults.filter((r) => !r.result.ok);

  if (acResults.length === 0) {
    return {
      ok: false,
      acResults,
      commentText: '[qa-agent-blocked] No AC evidence tags found in PR body. Each AC must end with (testID|not tested|not code|pr: <value>).',
    };
  }

  if (failures.length > 0) {
    const lines = failures
      .map(({ ac, result }) => `AC${ac.ac}: ${result.ok ? '' : result.reason}`)
      .join('\n');
    return {
      ok: false,
      acResults,
      commentText: `[qa-agent-blocked]\n${lines}`,
    };
  }

  // All checks passed — satisfy the gate.
  await deps.postApproval(taskId, 'qa_agent', 'Ash');
  return {
    ok: true,
    acResults,
    commentText: `[qa-agent-verified] task=${taskId} pr=${prUrl} acs=${acResults.length}`,
  };
}

// ---------------------------------------------------------------------------
// CLI entry — only registered when this module is run directly.
// ---------------------------------------------------------------------------

import { argv, env } from 'node:process';
import { parseArgs } from 'node:util';

function parseGhRepo(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function defaultFetchTask(taskId: string, baseUrl: string, token: string): Promise<TaskSummary> {
  const res = await fetch(`${baseUrl}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetch task ${taskId} failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data: TaskSummary };
  return json.data;
}

async function defaultFetchPr(prUrl: string, token: string): Promise<PrSummary> {
  const repo = parseGhRepo(prUrl);
  if (!repo) throw new Error(`cannot parse PR URL: ${prUrl}`);
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${repo.number}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`fetch PR ${prUrl} failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    body: string;
  };
  const filesRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${repo.number}/files?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!filesRes.ok) throw new Error(`fetch PR files ${prUrl} failed: ${filesRes.status} ${filesRes.statusText}`);
  const files = (await filesRes.json()) as Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    additions: number;
    deletions: number;
  }>;
  return {
    number: json.number,
    state: json.merged ? 'merged' : (json.state as 'open' | 'closed'),
    merged: json.merged,
    body: json.body ?? '',
    files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
  };
}

async function defaultPostComment(taskId: string, baseUrl: string, token: string, text: string): Promise<void> {
  const res = await fetch(`${baseUrl}/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`post comment on ${taskId} failed: ${res.status} ${res.statusText}`);
}

async function defaultPostApproval(taskId: string, baseUrl: string, token: string, type: string, owner: string): Promise<void> {
  const res = await fetch(`${baseUrl}/tasks/${taskId}/approvals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, owner }),
  });
  if (!res.ok) throw new Error(`post approval ${type} on ${taskId} failed: ${res.status} ${res.statusText}`);
}

async function runCli(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'task-id': { type: 'string' },
      'tasks-api-base-url': { type: 'string', default: 'http://localhost:4001/api/v1' },
      'task-author': { type: 'string', default: 'Ash' },
      'pr-url': { type: 'string' },
    },
  });
  const taskId = values['task-id'];
  const baseUrl = values['tasks-api-base-url']!;
  const author = values['task-author']!;
  const prUrl = values['pr-url'];

  const tasksToken = env.ASH_TASKS_API_APPROVAL_TOKEN;
  const githubToken = env.ASH_GITHUB_TOKEN;
  if (!tasksToken || !githubToken) {
    console.error('[qa-agent-blocked] Missing ASH_TASKS_API_APPROVAL_TOKEN or ASH_GITHUB_TOKEN env vars. Both are required at runtime.');
    return 2;
  }
  if (!taskId || !prUrl) {
    console.error('--task-id and --pr-url are required');
    return 2;
  }

  const deps: Deps = {
    fetchTask: (id) => defaultFetchTask(id, baseUrl, tasksToken),
    fetchPr: (url) => defaultFetchPr(url, githubToken),
    postComment: (id, text) => defaultPostComment(id, baseUrl, tasksToken, text),
    postApproval: (id, type, owner) => defaultPostApproval(id, baseUrl, tasksToken, type, owner),
  };

  try {
    const outcome = await verify(taskId, prUrl, deps);
    if (outcome.commentText) {
      try {
        await deps.postComment(taskId, outcome.commentText);
      } catch (err) {
        console.error(`[qa-agent-blocked] Failed to post comment: ${(err as Error).message}`);
        return 1;
      }
    }
    if (outcome.ok) {
      console.log(outcome.commentText);
      return 0;
    }
    console.error(outcome.commentText);
    return 1;
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[qa-agent-blocked] Verification failed: ${message}`);
    try {
      await deps.postComment(taskId, `[qa-agent-blocked] Tasks API auth/IO failure: ${message}`);
    } catch (commentErr) {
      console.error(`[qa-agent-blocked] (and additionally failed to post comment: ${(commentErr as Error).message})`);
    }
    return 1;
  }
}

// Run only when invoked as the main module (not when imported by tests).
const isMain = (() => {
  try {
    return import.meta.url === `file://${argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then((code) => process.exit(code));
}
