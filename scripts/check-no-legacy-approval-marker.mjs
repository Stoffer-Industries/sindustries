#!/usr/bin/env node
// scripts/check-no-legacy-approval-marker.mjs
//
// Repo lint: fail if any tracked source file contains the literal legacy
// task-description approval marker outside the detector and test code that
// is allowed to reference the regex. Background: task e2aba106 removed the
// legacy `- [x] **Approved by Tom**` checkbox from task descriptions; the
// structured `TaskApproval` row is now the only source of truth for spec
// approval. Re-introducing the marker literal anywhere is a regression.
//
// Usage:
//   node scripts/check-no-legacy-approval-marker.mjs           # scan default roots
//   node scripts/check-no-legacy-approval-marker.mjs apps foo  # scan custom roots
//
// Exit codes:
//   0 — no offenders
//   1 — at least one occurrence found
//   2 — invocation / IO error

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

// Guard: only auto-run `main()` when the script is invoked directly (not
// imported by tests). Allows unit tests to import the named exports
// below without triggering a filesystem scan of the developer's working
// directory.
const IS_DIRECT_INVOCATION =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

export { ALLOWLIST_FILES, PATTERN, LINE_ESCAPE_RE, findOffenders };

// The detection pattern is intentionally narrow — the strict CHECKED form
// only. Unchecked (`- [ ] **Approved by Tom**`) is intentionally not in
// scope here because WS1/WS2 did not prohibit unchecked markers in
// descriptions and the detector deliberately ignores them; flagging the
// unchecked form here would create false positives on load-bearing test
// fixtures that pin the unchecked text.
const PATTERN = /- \[x\] \*\*Approved by Tom\*\*/g;

const DEFAULT_ROOTS = ['apps', 'services', 'packages', 'agents/workflows', 'agents/lib'];

// Path-prefixed skip — applied to the relative path from the scan root.
// Use this for opt-outs that are too narrow to match by basename (e.g.
// a single Rust workflow monolith with many regression-test fixtures).
const SKIP_PATH_PREFIXES = [
  // The 7,000+ line Rust feature-task workflow ships many regression
  // test fixtures that legitimately pin the literal `- [x] **Approved
  // by Tom**` marker: tests at ~line 4035 verify that the lobster no
  // longer reads the marker from task descriptions (e2aba106 WS2), and
  // tests at ~line 4463 verify that the brain-spec approval reconciler
  // still reads the marker from spec FILES (AC4). Modularising the
  // workflow is a separate effort flagged by the W32 audit; until
  // then, opt out of this directory so the lint can still land for
  // the rest of the repo.
  //
  // Each fixture remains auditable at code review. Use the file-path
  // output (`agents/workflows/feature-task/src/main.rs:<line>`) to
  // verify or refactor individual fixtures during future cleanup.
  'agents/workflows/feature-task/src'
];

// Directories we never descend into. These are build outputs, vendored
// deps, or generated artefacts where absolute paths are expected and
// intentional.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'target',
  'logs',
  'incremental',
  'deps',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vercel',
  '.expo',
  'android',
  'ios',
  'generated',
  '__pycache__'
]);

// File extensions we treat as binary and skip without reading. The marker
// pattern is text-only so binary files cannot contain it, and reading
// arbitrary binary bytes is wasteful.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.flac', '.ogg',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.node',
  '.pyc', '.pyo',
  '.snap'
]);

// Files that legitimately define or pin the regex. The detector lives in
// the Tasks API as `legacyApprovals.ts` (defines both checked and
// unchecked variants); its direct unit test mirrors those patterns.
// The migrateLegacyApprovals test files pin the literal as test input so
// the migration algorithm can be exercised against real-world shapes;
// tasksSpecChecksum and read-endpoints contain description-fixture tests
// that pin the marker to verify the API surface does not transform it.
// The Python bookmark lifecycle test covers the bookmark-workflow
// spec-file reconciler which still recognises the marker in spec FILES.
const ALLOWLIST_FILES = new Set([
  'services/tasks-api/src/lib/legacyApprovals.ts',
  'services/tasks-api/test/legacyApprovals.test.ts',
  'services/tasks-api/test/migrateLegacyApprovals.test.ts',
  'services/tasks-api/test/migrateLegacyApprovalsFetch.test.ts',
  'services/tasks-api/test/tasksSpecChecksum.test.ts',
  'services/tasks-api/test/read-endpoints.test.ts',
  'agents/workflows/bookmarks/tests/test_spec_lifecycle.py'
]);

// Per-line escape hatches. When a legitimate use needs to embed the
// literal (e.g. a Rust test fixture writing a brain-spec FILE that
// legitimately contains the marker — the brain-spec workflow still
// recognizes checked markers as Tom's grant signal), the line may end
// with one of these markers. The comment-form is language-idiomatic for
// the file extension:
//
//   `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.rs`  -> `//`
//   `.sh`, `.py`, `.yml`, `.yaml`, `.md`, `.toml`      -> `#`
//
// Usage: a single trailing inline comment justifying the use. Curate
// every allowance: a future PR touching the line must justify the
// exemption again or remove it.
const LINE_ESCAPE_RE = /\b(allow-legacy-approval-marker)\b/;

function shouldSkipDir(absPath, skipDirs = SKIP_DIRS) {
  const base = absPath.split(/[\\/]/).pop();
  return skipDirs.has(base);
}

function* walk(dir, skipDirs = SKIP_DIRS) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (shouldSkipDir(full, skipDirs)) continue;
      yield* walk(full, skipDirs);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function isBinary(path) {
  return BINARY_EXT.has(extname(path).toLowerCase());
}

function findOffenders(roots, opts = {}) {
  const {
    repoRoot = REPO_ROOT,
    allowlistFiles = ALLOWLIST_FILES,
    pattern = PATTERN,
    lineEscapeRe = LINE_ESCAPE_RE,
    skipDirs = SKIP_DIRS,
    skipPathPrefixes = SKIP_PATH_PREFIXES,
    binaryExt = BINARY_EXT
  } = opts;
  const offenders = [];
  let scannedFiles = 0;
  let skippedPrefixFiles = 0;
  for (const root of roots) {
    const abs = resolve(repoRoot, root);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const file of walk(abs, skipDirs)) {
      if (binaryExt.has(extname(file).toLowerCase())) continue;
      const rel = relative(repoRoot, file);
      if (skipPathPrefixes.some((p) => rel === p || rel.startsWith(p + '/'))) {
        skippedPrefixFiles += 1;
        continue;
      }
      if (allowlistFiles.has(rel)) {
        scannedFiles += 1;
        continue;
      }
      scannedFiles += 1;
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        // unreadable file — let other tooling surface the IO error
        continue;
      }
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line)) !== null) {
          if (lineEscapeRe.test(line)) continue;
          offenders.push({
            file: rel,
            line: idx + 1,
            match: m[0],
          });
        }
      });
    }
  }
  return { offenders, scannedFiles, skippedPrefixFiles };
}

function main() {
  const roots = process.argv.slice(2);
  const scanRoots = roots.length > 0 ? roots : DEFAULT_ROOTS;
  const { offenders, scannedFiles } = findOffenders(scanRoots);
  if (offenders.length === 0) {
    console.log(
      `✓ check-no-legacy-approval-marker: scanned ${scannedFiles} file(s) under ${scanRoots.join(', ')} — no offenders`,
    );
    process.exit(0);
  }
  console.error(
    `✗ check-no-legacy-approval-marker: ${offenders.length} legacy approval marker occurrence(s) in ${scannedFiles} scanned file(s)`
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.match}`);
  }
  console.error('');
  console.error(
    'The legacy `- [x] **Approved by Tom**` checkbox was removed from task descriptions by e2aba106 (WS1 + WS2). Structured TaskApproval rows are the only source of truth.'
  );
  console.error(
    'If a legitimate use is required (e.g. a Rust test fixture writing a brain-spec FILE), append a trailing line-comment with `allow-legacy-approval-marker` and a justification.'
  );
  console.error(
    'Detector files are allowlisted: services/tasks-api/src/lib/legacyApprovals.ts and services/tasks-api/test/legacyApprovals.test.ts.'
  );
  process.exit(1);
}

if (IS_DIRECT_INVOCATION) {
  main();
}
