#!/usr/bin/env node
// check-agent-caller-routes.mjs — task 020f423e (AC2 caller inventory).
//
// WHY THIS EXISTS
//
// The production cutover's AC2 is: after the switch, no active in-scope caller
// still targets prodlike, except the explicitly documented rollback surfaces.
// That is only provable if EVERY in-scope caller is named.
//
// The route adapter names the runtime configuration files — the `.env` keys
// `TASKS_API_BASE_URL`, `CONTENT_SCHEDULER_BASE_URL`, `MISSION_CONTROL_BASE_URL`
// and `TASKS_APP_BASE_URL` — and it moves those. The read-back reads those
// same files back, so the read-back proves what the adapter moved.
//
// It does NOT read the repository. And the repository is where the other
// in-scope callers live: the cron prompts, the heartbeat prompts and the
// skills that agents run. Before this check existed, several of those pinned
// `http://localhost:4001/api/v1` literally — a hard-coded origin that no
// switch could move. The read-back would have reported the window clean
// while a cron caller was still writing to prodlike, and the runbook's claim
// that "repository-owned prompts, heartbeats, and skills consume these
// variables; they no longer pin a local URL over the runtime value" was
// simply false.
//
// So this check makes the claim mechanical: a live agent automation surface
// may name a prodlike origin as a FALLBACK of a runtime route variable, and
// may never name one as the target it actually calls.
//
// WHAT COUNTS AS A PIN
//
// A pin is a prodlike origin used as the request target:
//
//   * a hard assignment — `TASKS_API_BASE_URL=http://localhost:4001/api/v1`
//   * a curl target — `curl -s "http://localhost:4001/api/v1/tasks?..."`
//   * an HTTP client call — `urlopen('http://localhost:4001/api/v1/tasks')`
//   * a method and a URL — `POST http://localhost:4001/api/v1/tasks`
//
// WHAT IS ALLOWED
//
// The origin may appear as the DEFAULT of a runtime route variable, which is
// how a caller resolves the route with a local-dev fallback:
//
//   * `"${TASKS_API_BASE_URL:-http://localhost:4001/api/v1}"`
//   * `os.environ.get("TASKS_API_BASE_URL") or "http://localhost:4001/api/v1"`
//   * `os.getenv("TASKS_API_BASE_URL", "http://localhost:4001/api/v1")`
//
// Prose that merely mentions an origin ("Prodlike uses `http://localhost:4004`")
// is not a pin: it names no target and moves no route.
//
// SCOPE
//
// Markdown under `agents/crons/`, `agents/definitions/`, `agents/skills/` and
// `agents/workflows/` — the surfaces an agent or a cron executes. Test,
// fixture and eval directories are excluded.
//
// Source files are deliberately out of scope. The Python clients read the
// route from the environment and FAIL CLOSED when it is unset, so their
// module-level defaults are named constants used as env fallbacks rather than
// targets. The Rust CLI's `--base-url` default is shadowed by `run.py`, which
// resolves `TASKS_API_BASE_URL` from the environment and always passes the
// resolved value.
//
// Pure Node, no deps. Exits 0 when no surface pins a prodlike origin, 1 when
// one does, 2 on a usage error.
//
// Usage:
//   node tests/cloud/scripts/check-agent-caller-routes.mjs [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
})();

/** The trees whose markdown an agent or a cron actually executes. */
export const SCANNED_TREES = Object.freeze([
  'agents/crons',
  'agents/definitions',
  'agents/skills',
  'agents/workflows',
]);

/** Directories whose contents are fixtures rather than live surfaces. */
export const EXCLUDED_DIRS = Object.freeze([
  '__pycache__',
  'evals',
  'fixtures',
  'node_modules',
  'tests',
]);

/**
 * The prodlike origins a pin may target.
 *
 * These are the origins the cutover's own manifest names as the source the
 * switch moves away from — the prodlike Tasks API, Content Scheduler,
 * Mission Control and Tasks app.
 */
export const PRODLIKE_ORIGINS = Object.freeze([
  'http://localhost:4001',
  'http://localhost:4004',
  'http://localhost:5175',
  'http://localhost:5176',
]);

/**
 * The pin patterns, in the order they are reported.
 *
 * `DEFAULT_` is excluded from the hard-assignment pattern on purpose: a
 * constant named `DEFAULT_BASE_URL` is a fallback by its name and by its use,
 * not a target.
 */
export const PIN_PATTERNS = Object.freeze([
  {
    id: 'hard-assignment',
    reason: 'a runtime route variable is assigned a prodlike origin, so the caller can never follow the live route',
    regex: new RegExp(
      `(?:export\\s+)?(?!DEFAULT_)([A-Z][A-Z0-9_]*)=\\s*["']?https?://localhost:(?:4001|4004|5175|5176)`,
    ),
  },
  {
    id: 'curl-target',
    reason: 'a curl command targets a prodlike origin directly, so the route cannot be switched',
    regex: new RegExp(
      `\\bcurl\\b[^\\n]*["']?https?://localhost:(?:4001|4004|5175|5176)`,
    ),
  },
  {
    id: 'http-client-target',
    reason: 'an HTTP client call targets a prodlike origin directly, so the route cannot be switched',
    regex: new RegExp(
      `\\b(?:urlopen|urlretrieve|requests\\.(?:get|post|put|patch|delete)|fetch|httpx\\.(?:get|post|put|patch|delete))\\s*\\(\\s*f?["']?https?://localhost:(?:4001|4004|5175|5176)`,
    ),
  },
  {
    id: 'method-and-url',
    reason: 'a request method is paired with a prodlike origin, so the route cannot be switched',
    regex: new RegExp(
      `\\b(?:POST|GET|PATCH|PUT|DELETE)\\s+["']?https?://localhost:(?:4001|4004|5175|5176)`,
    ),
  },
]);

/**
 * Find every prodlike pin in one file's text.
 *
 * @param {string} text
 * @returns {Array<{pattern: string, reason: string, line: number, lineText: string}>}
 */
export function detectPins(text) {
  const findings = [];
  const lines = String(text).split('\n');

  lines.forEach((lineText, index) => {
    for (const pattern of PIN_PATTERNS) {
      const match = pattern.regex.exec(lineText);
      if (match) {
        findings.push({
          pattern: pattern.id,
          reason: pattern.reason,
          line: index + 1,
          lineText: lineText.trim(),
        });
      }
    }
  });

  return findings;
}

/**
 * List the markdown files this check reads.
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-root-relative paths, sorted
 */
export function listScannedFiles(repoRoot) {
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.includes(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      found.push(join(dir, entry.name));
    }
  };

  for (const tree of SCANNED_TREES) {
    walk(join(repoRoot, tree));
  }

  return found
    .map((path) => relative(repoRoot, path))
    .sort();
}

/**
 * Check every scanned surface for a prodlike pin.
 *
 * @param {string} repoRoot
 * @returns {Array<{file: string, line: number, lineText: string, pattern: string, reason: string}>}
 */
export function checkRepo(repoRoot) {
  const violations = [];

  for (const file of listScannedFiles(repoRoot)) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const finding of detectPins(text)) {
      violations.push({ file, ...finding });
    }
  }

  return violations;
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== '--');
  if (args.length > 1) return { usage: true };
  return { usage: false, repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

export async function main(argv = process.argv) {
  const { usage, repoRoot } = parseArgs(argv);

  if (usage) {
    stdout.write('Usage: node tests/cloud/scripts/check-agent-caller-routes.mjs [<repo-root>]\n');
    return 2;
  }

  if (!statSync(repoRoot).isDirectory()) {
    stderr.write(`[check-agent-caller-routes] ${repoRoot} is not a directory\n`);
    return 2;
  }

  const violations = checkRepo(repoRoot);

  for (const violation of violations) {
    stderr.write(
      `[check-agent-caller-routes] PINNED ${violation.file}:${violation.line} — ${violation.reason}\n` +
        `    ${violation.pattern}: ${violation.lineText}\n` +
        '    fix: resolve the route from the runtime environment instead — ' +
        '"${TASKS_API_BASE_URL:-<prodlike origin>}" for shell, ' +
        'os.environ.get("TASKS_API_BASE_URL") for Python.\n',
    );
  }

  if (violations.length > 0) {
    stderr.write(
      `[check-agent-caller-routes] FAILED — ${violations.length} agent automation surface(s) pin a ` +
        'prodlike origin. The cutover read-back cannot see these surfaces, so an AC2 proof that ' +
        'reports them as clean is not a proof.\n',
    );
    return 1;
  }

  stdout.write(
    '[check-agent-caller-routes] OK — no agent automation surface pins a prodlike origin; every ' +
      'in-scope caller resolves its route from the runtime environment.\n',
  );
  return 0;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await main(process.argv);
  exit(code);
}
