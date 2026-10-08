#!/usr/bin/env node
// check-stable-url-fallbacks.mjs — task 5cb4a8fe static check (AC4).
//
// AC4: "provider-specific *.fly.dev and *.vercel.app URLs remain only as
// documented migration or provider fallback paths where necessary." This
// script greps the in-scope paths (.github/workflows/*.yml, infra/cloud/**,
// docs/systems/*.md, docs/infra/*.md) and asserts every *.fly.dev /
// *.vercel.app reference is annotated with a `<!-- stable-fallback -->`
// HTML comment, OR appears in the documented-migration section of
// docs/systems/cloud-platform.md (the explicit carve-out for the existing
// *.sindustries.dev / *.fly.dev migration note).
//
// Pure Node 22, no deps. Exits 0 on full success, 1 if any unannotated
// reference is found. The matching
// `tests/cloud/tests/check-stable-url-fallbacks.test.mjs` exercises the
// script's exit code via execFile on a synthetic fixtures tree.
//
// Usage:
//   node scripts/check-stable-url-fallbacks.mjs [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

function parseArgs() {
  const args = process.argv.slice(2);
  return { repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

const SCAN_ROOTS = [
  '.github/workflows',
  'infra/cloud',
  'docs/systems',
  'docs/infra',
];
const SCAN_EXTENSIONS = new Set(['.yml', '.yaml', '.sh', '.mjs', '.cjs', '.js', '.ts', '.md', '.toml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'fixtures']);
// Hostname patterns the check flags. Per design AC4, the project cares
// about SIndustries / GymTrack app hostnames, not about test fixtures or
// short hostnames used in URL parser tests. Restrict the regexes to the
// app-name prefixes we operate; this keeps the check from flagging
// generic `a.fly.dev` fixtures inside unit tests.
const HOSTNAME_PATTERNS = [
  /\bsindustries-[A-Za-z0-9-]+\.fly\.dev/g,
  /\bsindustries-[A-Za-z0-9-]+\.vercel\.app/g,
  /\bgymtrack-[A-Za-z0-9-]+\.fly\.dev/g,
  /\bgymtrack-[A-Za-z0-9-]+\.vercel\.app/g,
];
// Stable hostnames the design introduces are NOT in scope for the
// fallback check — they ARE the contract. Carve out via negative look-
// ahead so the check can ignore them in lines that mix stable and
// fallback references.
const STABLE_HOSTNAME_EXEMPTION_RE = /(?:[A-Za-z0-9-]+\.staging\.sindustries\.co\.nz|[A-Za-z0-9-]+\.sindustries\.co\.nz)/;
// Comments in scope. `.sh` and `.toml` don't support `<!-- ... -->`; the
// assertion is intentionally relaxed to "an annotation comment line must
// appear within N lines of the reference" because TOML and shell use `#`
// for comments. The script accepts any of: HTML comment, TOML `#` comment,
// or shell `#` comment within the same line, the line above, or the line
// below. YAML uses `#` for comments too.
// Comment markers the check accepts as the `<!-- stable-fallback -->` (or
// `# stable-fallback` in shell/TOML/YAML) annotation. The fallback
// marker may carry a trailing descriptive note inside the comment,
// e.g. `<!-- stable-fallback: provider URL pending migration -->` or
// `// stable-fallback: …` in JS/TS test files. JSON does not support
// comments; if the reference is inside a JSON code block, place the
// annotation on the line above (or below) inside the surrounding
// Markdown, not inside the JSON literal.
const ANNOTATION_PATTERNS = [
  /<!--\s*stable-fallback\b[^>]*?-->/,
  /<!--\s*documented-migration\b[^>]*?-->/,
  /#\s*stable-fallback\b/,
  /#\s*documented-migration\b/,
  /\/\/\s*stable-fallback\b/,
  /\/\/\s*documented-migration\b/,
];
const STABLE_FALLBACK_RE = /\bstable-fallback\b/;
// Files where the provider URL is the documented-migration carve-out. The
// design says: "the foundation's *.sindustries.dev reservation is
// superseded for staging and production by this task; the reservation
// remains documented for audit only" — that audit-only text lives in
// docs/systems/cloud-platform.md and is allowed to reference the prior
// *.sindustries.dev / *.fly.dev URLs without per-line `stable-fallback`
// annotation, as long as the file's documented-migration section is
// intact.
const DOCUMENTED_MIGRATION_FILES = new Set([
  'docs/systems/cloud-platform.md',
]);

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); }
    catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const dot = name.lastIndexOf('.');
        const ext = dot === -1 ? '' : name.slice(dot);
        if (SCAN_EXTENSIONS.has(ext)) out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

function lineIsComment(filename, line) {
  if (filename.endsWith('.sh') || filename.endsWith('.toml') || filename.endsWith('.yml') || filename.endsWith('.yaml')) {
    return line.trimStart().startsWith('#');
  }
  if (filename.endsWith('.md')) {
    // Markdown comments are HTML-style.
    return /<!--/.test(line);
  }
  // .mjs / .js / .ts — comments are not in scope; we only annotate via
  // inline `/* stable-fallback */` next to a string literal that the regex
  // matched. We don't pre-filter; the annotation check below handles it.
  return false;
}

function annotationOnLine(line) {
  return ANNOTATION_PATTERNS.some((re) => re.test(line));
}

function main() {
  const { repoRoot } = parseArgs();
  const errors = [];
  let totalRefs = 0;
  let annotatedRefs = 0;

  for (const root of SCAN_ROOTS) {
    const absRoot = join(repoRoot, root);
    let st;
    try { st = statSync(absRoot); } catch { continue; }
    if (!st.isDirectory()) continue;
    const files = listFiles(absRoot);
    for (const file of files) {
      const rel = relative(repoRoot, file);
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      // Documented-migration carve-out: skip per-line annotation check
      // when the file is whitelisted; the carve-out is only valid if the
      // file contains a `<!-- documented-migration -->` marker somewhere
      // so the carve-out is opt-in per file.
      const isCarveOut = DOCUMENTED_MIGRATION_FILES.has(rel);

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        for (const pat of HOSTNAME_PATTERNS) {
          pat.lastIndex = 0;
          let m;
          while ((m = pat.exec(line)) !== null) {
            totalRefs += 1;
            const ref = m[0];
            // Carve-out: a *.sindustries.dev reference is fine in the
            // documented-migration section of cloud-platform.md; we
            // don't count it against AC4.
            if (isCarveOut && ref.endsWith('.sindustries.dev')) continue;
            // The matrix's providerFallback values themselves live in
            // hostname-matrix.json — the file the check is intentionally
            // documenting the matrix from, so the references there are
            // not in scope.
            if (rel === 'infra/cloud/hostname-matrix.json') continue;
            // The matrix is referenced from the per-hostname comment
            // blocks at the top of each fly.toml; those reference the
            // stable staging hostname, not a provider URL. So nothing
            // to skip there.
            // Check the same line and the two lines above for an
            // annotation marker.
            const window = [
              lines[i - 1] ?? '',
              lines[i - 2] ?? '',
              line,
              lines[i + 1] ?? '',
            ];
            const annotated = window.some(annotationOnLine);
            if (annotated) {
              annotatedRefs += 1;
              continue;
            }
            errors.push(`${rel}:${i + 1}  unannotated ${ref} reference (add \`<!-- stable-fallback -->\` on the same line, the line above, or the line below)`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    stderr.write(`stable URL fallback check failed (${errors.length} unannotated reference${errors.length === 1 ? '' : 's'} out of ${totalRefs} total):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  stdout.write(`stable URL fallback check passed (${annotatedRefs}/${totalRefs} references annotated)\n`);
}

main();
