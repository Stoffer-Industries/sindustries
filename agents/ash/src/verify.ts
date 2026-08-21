/**
 * Ash QA-verifier agent: semantic AC-judgment script.
 *
 * Pure functions in this file are exported for unit testing; the CLI
 * orchestration lives below the `if (import.meta.url === ...)` guard.
 *
 * The script is invoked by Quinn's Ash heartbeat/cron AFTER the agent
 * identity is provisioned at `~/.openclaw/workspace/agents/ash/`. Until
 * then, this file is a placeholder — see the [openclaw-needed] comment
 * posted on task f6a4d56a for the bootstrap steps.
 *
 * **Scope (after PR #3 of task 5e35dc25):** this file is **semantic-only**.
 * Mechanical checks (cited-file existence, cited-test pass/fail,
 * evidence-text matching against the PR diff) live in the lobster's
 * `mechanical_evidence_failures` function at
 * `agents/workflows/feature-task/src/ac_parsing.rs:331` and run before
 * `qa_agent` is gated. Ash's qa_agent approval is only requested after
 * the lobster's mechanical gate has passed, and is scoped to judging
 * whether the PR diff actually satisfies each AC's intent — not whether
 * the cited file exists or the cited test passes.
 *
 * Per `docs/specs/migrate-ash-mechanical-checks-tech-design.md` step 4.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One parsed AC line from a PR body. Semantic judgment reads the bare
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
   * The raw patch text (concatenated per-file diffs). Populated by the
   * default `fetchPr` implementation via the GitHub patch API
   * (`Accept: application/vnd.github.v3.patch`); tests can inject a
   * stub that returns a smaller string. The semantic judgment reads
   * this directly, not the per-file `files[]` list.
   */
  patch: string;
};

/**
 * Result of a single AC's intent judgment. `ok: true` means the diff
 * actually satisfies the AC's intent. `ok: false` carries a human
 * reason that surfaces in the [qa-agent-blocked] comment.
 */
export type JudgeIntentResult = { ok: true } | { ok: false; reason: string };

/**
 * I/O + judgment dependencies for the semantic orchestrator. Tests
 * inject fakes instead of touching the network or running an LLM call.
 *
 * `judgeIntent` is the only piece Quinn owns: the recommended shape is
 * an LLM call against `ac.description + pr.patch` with a strict
 * `ok: true | { ok: false; reason: string }` JSON response (see the
 * `defaultJudgeIntent` placeholder below for the contract). Tests
 * stub it with a fake that returns a deterministic verdict.
 */
export type Deps = {
  fetchPr: (prUrl: string) => Promise<PrSummary>;
  postComment: (taskId: string, text: string) => Promise<void>;
  postApproval: (taskId: string, type: string) => Promise<void>;
  judgeIntent: (ac: AcEvidence, patchText: string) => Promise<JudgeIntentResult>;
};

export type VerifyOutcome = {
  ok: boolean;
  acResults: Array<{ ac: AcEvidence; result: JudgeIntentResult }>;
  // The comment text we'd post (success or failure). Empty string only
  // means "no comment needed" (e.g. nothing to verify).
  commentText: string;
};

// ---------------------------------------------------------------------------
// AC line extraction — minimal, no evidence parsing.
// ---------------------------------------------------------------------------

// Same regex as the prior agent-side parser; the lobster's evidence
// regex in agents/workflows/feature-task/src/ac_parsing.rs:127 is the
// canonical match. We only walk AC lines here for the semantic loop;
// the lobster owns evidence-tag parsing.
const AC_LINE_RE = /^\s*-\s*\[[xX]\]\s*AC(\d+):\s*(.+)$/;

export function extractAcLines(prBody: string): AcEvidence[] {
  const result: AcEvidence[] = [];
  for (const line of prBody.split('\n')) {
    const m = line.match(AC_LINE_RE);
    if (!m) continue;
    // The lobster's parse_evidence handles `(testID: ...)` /
    // `(not tested: ...)`. For the semantic judgment we want the bare
    // AC description — strip the trailing evidence annotation if any
    // so the LLM doesn't get thrown by test IDs in the prompt.
    const description = stripTrailingEvidence(m[2].trim());
    result.push({ ac: m[1], description });
  }
  return result;
}

function stripTrailingEvidence(text: string): string {
  // Mirrors the lobster's strip_trailing_evidence regex shape: a
  // trailing `(keyword: value)` block. The keyword is one of
  // testID | not tested | not code | pr, with optional non-letter,
  // non-`)` prefix (emoji, space, punctuation).
  const m = text.match(/\s*\(([^a-zA-Z)]*)(testID|not tested|not code|pr):\s*[^)]+\)\s*$/);
  if (!m) return text;
  return text.slice(0, m.index).trimEnd();
}

// ---------------------------------------------------------------------------
// Semantic judgment — placeholder for Quinn's implementation.
//
// The lobster's mechanical-evidence gate already verified that the
// cited file exists, the cited test passes, and the evidence text
// matches the PR diff. Ash's residual judgment is whether the diff
// actually satisfies the AC's *intent* — not just whether the cited
// surface is present.
//
// Recommended approach (Quinn): an LLM call against the AC's bare
// description + the PR's patch text with a strict
// `{ ok: true } | { ok: false; reason: string }` JSON response,
// deterministically reproducible by setting temperature=0 and
// recording the model + prompt version.
//
// Alternative deterministic approaches (e.g. extracted function/class
// symbols compared against AC claim keywords) are acceptable when LLM
// budget is a concern. See the design's "Open questions / risks" for
// the trade-off table.
//
// Until Quinn's implementation is wired, the placeholder returns
// `ok: false` with an explicit reason so the task stays in `doing`
// rather than reaching acceptance on a stub. The lobster's mechanical
// gate still runs — it just doesn't transition the task to acceptance
// without a semantic pass.
// ---------------------------------------------------------------------------

export async function defaultJudgeIntent(
  _ac: AcEvidence,
  _patchText: string,
): Promise<JudgeIntentResult> {
  return {
    ok: false,
    reason:
      'semantic judgment not yet implemented (Quinn owns) — see agents/ash/src/verify.ts:defaultJudgeIntent',
  };
}

// ---------------------------------------------------------------------------
// Semantic orchestrator — reads PR diff, walks each AC, calls judgeIntent,
// posts the [qa-agent-verified] / [qa-agent-blocked] comment and (on
// success) satisfies the qa_agent gate.
// ---------------------------------------------------------------------------

/**
 * Core orchestrator. Given the task ID, PR URL, and injected I/O +
 * judgment deps, runs the semantic verification and returns the
 * outcome. The CLI layer below is a thin wrapper that wires up real
 * fetch/post + error handling.
 *
 * Pre-conditions (raised by the lobster's mechanical gate, not by this
 * function): the PR is merged, the body has AC evidence tags, and the
 * cited files / tests pass. By the time Ash runs, those are already
 * satisfied — this function only judges intent.
 */
export async function verifySemantic(
  taskId: string,
  prUrl: string,
  deps: Deps,
): Promise<VerifyOutcome> {
  if (!taskId) {
    throw new Error('verifySemantic() requires a taskId');
  }
  if (!prUrl) {
    return {
      ok: false,
      acResults: [],
      commentText:
        '[qa-agent-blocked] No PR URL found in task. Verify the task has an `[implementer-prs]` comment with a PR URL.',
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

  const acs = extractAcLines(pr.body);
  if (acs.length === 0) {
    return {
      ok: false,
      acResults: [],
      commentText:
        '[qa-agent-blocked] No AC evidence tags found in PR body. Each AC must end with (testID|not tested|not code|pr: <value>).',
    };
  }

  const acResults: Array<{ ac: AcEvidence; result: JudgeIntentResult }> = [];
  for (const ac of acs) {
    const result = await deps.judgeIntent(ac, pr.patch);
    acResults.push({ ac, result });
  }

  const failures = acResults.filter((r) => !r.result.ok);

  if (failures.length > 0) {
    const lines = failures
      .map(({ ac, result }) =>
        result.ok ? '' : `AC${ac.ac}: ${result.reason}`,
      )
      .filter((line) => line.length > 0)
      .join('\n');
    return {
      ok: false,
      acResults,
      commentText: `[qa-agent-blocked]\n${lines}`,
    };
  }

  // All ACs satisfied semantically — satisfy the gate.
  await deps.postApproval(taskId, 'qa_agent');
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

async function defaultFetchPr(prUrl: string, token: string): Promise<PrSummary> {
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

  // Pull the raw patch text for the judgment prompt. The `.patch` media
  // type returns the unified diff as plain text — easier to embed in
  // an LLM prompt than the JSON file list.
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

async function defaultPostComment(
  taskId: string,
  baseUrl: string,
  token: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`post comment on ${taskId} failed: ${res.status} ${res.statusText}`);
}

async function defaultPostApproval(
  taskId: string,
  baseUrl: string,
  token: string,
  type: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/tasks/${taskId}/approvals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
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
    console.error(
      '[qa-agent-blocked] Missing ASH_TASKS_API_APPROVAL_TOKEN or ASH_GITHUB_TOKEN env vars. Both are required at runtime.',
    );
    return 2;
  }
  if (!taskId || !prUrl) {
    console.error('--task-id and --pr-url are required');
    return 2;
  }

  const deps: Deps = {
    fetchPr: (url) => defaultFetchPr(url, githubToken),
    postComment: (id, text) => defaultPostComment(id, baseUrl, tasksToken, text),
    postApproval: (id, type) => defaultPostApproval(id, baseUrl, tasksToken, type),
    judgeIntent: defaultJudgeIntent,
  };

  try {
    const outcome = await verifySemantic(taskId, prUrl, deps);
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
      console.error(
        `[qa-agent-blocked] (and additionally failed to post comment: ${(commentErr as Error).message})`,
      );
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
