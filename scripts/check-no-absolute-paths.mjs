#!/usr/bin/env node
// scripts/check-no-absolute-paths.mjs
//
// Repo lint: fail if any tracked source file under the configured roots
// contains a hard-coded absolute path (e.g. `/Users/<name>/...`, `~/...`,
// `/home/<name>/...`). Theme 4 from docs/repo-audits/2026-W28.md —
// hard-coded paths and laptop-shaped defaults should not ship in repo
// config; use env-driven defaults instead.
//
// Usage:
//   node scripts/check-no-absolute-paths.mjs           # scan default roots
//   node scripts/check-no-absolute-paths.mjs apps foo  # scan custom roots
//
// Exit codes:
//   0 — no offenders
//   1 — at least one hard-coded absolute path found
//   2 — invocation / IO error

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const DEFAULT_ROOTS = ['apps', 'services', 'packages', 'agents/workflows', 'agents/lib'];

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
  '__pycache__',
]);

// Path-prefixed skip — applied to the relative path from REPO_ROOT,
// not the directory basename. Use this for opt-outs that are too narrow
// to match by basename (e.g. `agents/workflows/feature-task/src` would
// otherwise match every `src/` in the repo).
const SKIP_PATH_PREFIXES = [
  // The 7,000+ line Rust workflow monolith (W32 audit Theme 3) ships
  // many test fixtures and log strings that hard-code `/Users/<name>/`
  // and `~/workspaces/<name>/` paths. Modularising the workflow is a
  // separate effort; until then, opt out of this directory so the
  // guardrail can still land for everything else in agents/workflows/.
  'agents/workflows/feature-task/src',
];

// File extensions we treat as binary and skip without reading. Image and
// asset bytes routinely contain byte sequences that look like ASCII paths
// but are not source code.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.flac', '.ogg',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.node',
  '.pyc', '.pyo',
  '.snap',
]);

const PATTERNS = [
  // `/Users/<name>/...` is the macOS-specific laptop-path shape; flag any
  // username that follows.
  { name: '/Users/', re: /\/Users\/[A-Za-z0-9._-]+/g },
  // `~/` is too broad to flag unconditionally: `~/.openclaw/...`,
  // `~/.config/...`, `~/.local/...`, `~/.cache/...` are operator-portable
  // config paths that work on every machine via $HOME. The W28 audit
  // (Theme 4) is specifically about laptop-development paths like
  // `~/workspaces/<name>/...`, `~/repos/<name>/...`, etc. Only match
  // `~/` followed by one of those well-known development roots.
  { name: '~/', re: /(?<![A-Za-z0-9_])~\/(workspaces|repos|code|dev|projects|src|Developer|src\/)\b[^\s"'`)]*/g },
  { name: '/home/', re: /(?<![A-Za-z0-9_])\/home\/[A-Za-z0-9._-]+/g },
];

// Scan roots resolve against the current working directory. The repo
// convention is to invoke this script from the repo root (CI does the
// same), which keeps diagnostics repo-root-relative.
const REPO_ROOT = process.cwd();

function shouldSkipDir(absPath) {
  const base = absPath.split(/[\\/]/).pop();
  if (SKIP_DIRS.has(base)) return true;
  const rel = relative(REPO_ROOT, absPath);
  return SKIP_PATH_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix + '/'));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (shouldSkipDir(full)) continue;
      yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function isBinary(path) {
  return BINARY_EXT.has(extname(path).toLowerCase());
}

function findOffenders(roots) {
  const offenders = [];
  let scannedFiles = 0;
  for (const root of roots) {
    const abs = resolve(REPO_ROOT, root);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const file of walk(abs)) {
      if (isBinary(file)) continue;
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
        for (const { name, re } of PATTERNS) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              line: idx + 1,
              pattern: name,
              match: m[0],
            });
          }
        }
      });
    }
  }
  return { offenders, scannedFiles };
}

function main() {
  const roots = process.argv.slice(2);
  const scanRoots = roots.length > 0 ? roots : DEFAULT_ROOTS;
  const { offenders, scannedFiles } = findOffenders(scanRoots);
  if (offenders.length === 0) {
    console.log(
      `✓ check-no-absolute-paths: scanned ${scannedFiles} file(s) under ${scanRoots.join(', ')} — no offenders`,
    );
    process.exit(0);
  }
  console.error(
    `✗ check-no-absolute-paths: ${offenders.length} hard-coded absolute path(s) in ${scannedFiles} scanned file(s)`,
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  [${o.pattern}]  ${o.match}`);
  }
  console.error('');
  console.error(
    'Replace with env-driven defaults. See docs/repo-audits/2026-W28.md (Theme 4).',
  );
  process.exit(1);
}

main();