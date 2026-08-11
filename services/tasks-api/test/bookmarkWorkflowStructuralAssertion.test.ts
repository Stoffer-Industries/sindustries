import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC4 structural assertion for task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574`.
//
// The bookmark workflow must not depend on the description-marker helpers
// removed by WS1 (PR #420). The legacy surface was:
//
//   - `uncheckApprovalMarker(description)` in services/tasks-api/src/routes/tasks/_spec.ts
//   - `setApprovalMarkerChecked(description)`
//   - `descriptionWithSpecDriftApprovalState(description, checksum)`
//   - `descriptionsDifferOnlyByApprovalMarker(a, b)`
//   - `ApprovalMarker` enum constant
//
// Re-introducing any of these into the bookmark workflow source would
// re-couple the structured `TaskApproval` workflow with the
// description-marker surface and break the cutover contract. The test
// fails fast if any such reference appears, regardless of whether the
// import still resolves (the import would fail at compile/test time, but
// a stale copy in a docstring or test fixture would not — this test
// catches that.
//
// Path computation assumes vitest runs from services/tasks-api/ with
// services/tasks-api/test/<this-file>. From there, 3 ascents reach the
// repo root (services/tasks-api → services → /).

const REPO_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..'
);
const BOOKMARK_SRC = resolve(REPO_ROOT, 'agents/workflows/bookmarks');

const REMOVED_HELPERS = [
  'uncheckApprovalMarker',
  'setApprovalMarkerChecked',
  'descriptionWithSpecDriftApprovalState',
  'descriptionsDifferOnlyByApprovalMarker',
  'ApprovalMarker'
];

// Files in the bookmark tree that legitimately mention the marker by
// name in a forensic / migration context (e.g. a runbook comment that
// notes "this route previously depended on the legacy marker"). Each
// allowance is auditable at code review; if a regression adds a NEW
// file to this allowlist, the diff must justify the addition.
const ALLOWLIST_FILES = new Set<string>([
  // The Python spec-lifecycle test pins the marker as input for the
  // brain-spec reconciler. The bookmark workflow's pipeline still
  // recognises the marker in spec FILES (AC4 invariant) — that is
  // covered separately by agents/workflows/bookmarks/tests/.
]);

const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.git', 'dist']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.pyc', '.pyo'
]);

interface ScannedFile {
  rel: string;
  abs: string;
  content: string;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function scanBookmarkSrc(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const abs of walk(BOOKMARK_SRC)) {
    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    files.push({
      rel: abs.slice(BOOKMARK_SRC.length + 1),
      abs,
      content
    });
  }
  return files;
}

describe('bookmark workflow structural assertion (AC4 — e2aba106)', () => {
  const files = scanBookmarkSrc();

  it('discovers at least one bookmark workflow file', () => {
    // Guard against an empty-tree test that passes vacuously. If the
    // bookmark workflow tree is ever relocated, this test surfaces the
    // path-computation drift before the assertion below falsely passes.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(REMOVED_HELPERS)(
    'bookmark workflow has no reference to removed helper `%s`',
    (helper) => {
      const offenders = files.filter(
        (f) =>
          !ALLOWLIST_FILES.has(f.rel) &&
          f.content.includes(helper)
      );
      expect(
        offenders,
        `bookmark workflow references removed helper \`${helper}\`. ` +
          'Re-introducing description-marker coupling breaks the e2aba106 cutover contract. ' +
          'If this is a legitimate forensic reference, document it in ALLOWLIST_FILES ' +
          'with a justification comment.'
      ).toEqual([]);
    }
  );

  // AC4's symmetric invariant — "the bookmark workflow still routes
  // approvals through the structured `TaskApproval` surface, not the
  // description marker" — is intentionally NOT covered by this test.
  // The bookmark workflow drives approval via the `tasks_api_client`
  // Python module (`api_request("POST", base, "/tasks/<id>/approvals", ...)`),
  // and that the URL pattern + payload is correct is already exercised
  // by `agents/workflows/bookmarks/tests/test_spec_lifecycle.py` and
  // `test_run_dedup.py`, which run in the bookmark workflow's own test
  // harness. Adding a parallel assertion here would duplicate coverage
  // and create false-positive coupling between this task's test suite
  // and the bookmark API client implementation. The negative assertion
  // above is the load-bearing AC4 invariant: it pins the cutover
  // contract that description-marker helpers stay out of the bookmark
  // workflow.
});
