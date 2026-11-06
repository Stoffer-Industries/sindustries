#!/usr/bin/env node
/**
 * verify-lockfile-fidelity.mjs — assert that the dependency graph installed
 * inside the built GymTrack MCP image matches the root package-lock.json.
 *
 * Task 83edc146 ("Fix gymtrack-mcp production lockfile verification argv
 * overflow"). Tech design:
 * docs/specs/fix-gymtrack-lockfile-verification-argv-overflow-tech-design.md
 *
 * WHY THIS EXISTS
 * ---------------
 * The deploy workflow used to capture the image's full
 * `npm ls --omit=dev --depth=0 --json` output into a shell variable and then
 * hand that entire document to `node -e "...JSON.parse(process.argv[1])..."`
 * as a command-line argument. The image's dependency graph is large enough
 * (the hoisted workspace install makes npm ls enumerate many `extraneous:`
 * packages) to exceed the runner's exec argv limit, so node never started
 * and the fidelity assertions never ran:
 *
 *     /home/runner/work/_temp/<uuid>.sh: line 27: node: Argument list too long
 *
 * The failure was silent in the worst way: the step died before it could
 * report a verdict, so a genuinely drifted image would have produced the
 * same "Argument list too long" as a healthy one.
 *
 * THE CONTRACT
 * ------------
 * The observed graph arrives on STDIN. It is never placed in an argv
 * element and never placed in an environment variable, so the size of the
 * document does not depend on the operating system's argument limit. The
 * expected versions come from the root package-lock.json, which stays the
 * single source of truth for dependency versions.
 *
 * The dependency set is derived from the service's own package.json
 * (`services/gymtrack-mcp/package.json`) rather than hard-coded here, so a
 * new production dependency is verified automatically instead of silently
 * escaping the check.
 *
 * EXIT CODES
 * ----------
 *   0  the installed graph matches the lockfile exactly
 *   1  the observed graph is invalid (npm ls reported `invalid`)
 *   2  a direct dependency is missing from the installed graph
 *   3  an installed version differs from the lockfile version
 *   4  the input could not be used (unreadable lockfile, malformed JSON)
 *
 * Usage:
 *   npm ls --omit=dev --depth=0 --json | node scripts/verify-lockfile-fidelity.mjs
 *
 * Optional flags:
 *   --repo-root <dir>   repository root (default: the root this script lives under)
 *   --observed <file>   read the observed graph from a file instead of stdin
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** Repository root: scripts/ -> gymtrack-mcp/ -> services/ -> <root>. */
export const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');

const SERVICE_PACKAGE_PATH = 'services/gymtrack-mcp/package.json';
const ROOT_LOCKFILE_PATH = 'package-lock.json';

export const EXIT = {
  MATCH: 0,
  INVALID_GRAPH: 1,
  MISSING_DEPENDENCY: 2,
  VERSION_MISMATCH: 3,
  UNUSABLE_INPUT: 4,
};

/**
 * Paths inside the lockfile where a direct dependency's resolved version
 * lives. npm hoists workspace dependencies to the root `node_modules`, so
 * `node_modules/<name>` is where the image's copy comes from too.
 */
function lockfileEntryFor(name) {
  return `node_modules/${name}`;
}

/**
 * Read the direct production dependencies of the service, in the order the
 * service declares them.
 *
 * @param {string} repoRoot
 * @returns {string[]} dependency names
 */
export function serviceDependencyNames(repoRoot = DEFAULT_REPO_ROOT) {
  const pkg = JSON.parse(
    readFileSync(resolve(repoRoot, SERVICE_PACKAGE_PATH), 'utf8'),
  );
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * The expected version of every direct dependency, read from the root
 * package-lock.json.
 *
 * @param {string} repoRoot
 * @returns {Map<string, string>} dependency name -> expected version
 */
export function expectedVersions(repoRoot = DEFAULT_REPO_ROOT) {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, ROOT_LOCKFILE_PATH), 'utf8'));
  const packages = lock.packages ?? {};
  const expected = new Map();
  for (const name of serviceDependencyNames(repoRoot)) {
    const entry = packages[lockfileEntryFor(name)];
    if (!entry?.version) {
      throw new Error(
        `package-lock.json has no resolved version for "${name}" at ${lockfileEntryFor(name)}`,
      );
    }
    expected.set(name, entry.version);
  }
  return expected;
}

/**
 * Parse the observed `npm ls --json` document.
 *
 * @param {string} text
 * @returns {object} the parsed graph
 * @throws {Error} when the document is not usable JSON
 */
export function parseObserved(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`observed npm ls output is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observed npm ls output is not a JSON object');
  }
  return parsed;
}

/**
 * Collect the paths of every node npm flagged as invalid.
 *
 * `npm ls --json` reports an invalid graph either at the root or on an
 * individual dependency, so both are checked — a single bad subtree must
 * not pass.
 *
 * @param {object} graph
 * @returns {string[]} JSON paths of invalid nodes
 */
export function invalidNodePaths(graph) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.invalid === true) found.push(path);
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      walk(child, `${path}.dependencies.${name}`);
    }
  };
  walk(graph, '$');
  return found;
}

/**
 * Compare the observed graph against the expected versions.
 *
 * The check order matters: an invalid graph is reported before a missing
 * dependency, and a missing dependency before a version mismatch, so the
 * diagnostic always names the most fundamental problem present.
 *
 * @param {object} graph     the parsed `npm ls` document
 * @param {Map<string,string>} expected  dependency name -> expected version
 * @returns {{code: number, messages: string[], details: string[]}}
 */
export function verify(graph, expected) {
  const invalid = invalidNodePaths(graph);
  if (invalid.length > 0) {
    return {
      code: EXIT.INVALID_GRAPH,
      messages: ['npm ls inside the image reported an invalid dependency graph'],
      details: invalid.map((path) => `invalid node: ${path}`),
    };
  }

  const installed = graph.dependencies ?? {};
  const missing = [];
  const mismatched = [];
  const details = [];

  for (const [name, expectedVersion] of expected) {
    const actualVersion = installed[name]?.version;
    if (actualVersion === undefined || actualVersion === null || actualVersion === '') {
      missing.push(name);
      continue;
    }
    if (actualVersion !== expectedVersion) {
      mismatched.push(`${name}: image ${actualVersion} != lockfile ${expectedVersion}`);
    }
    details.push(`${name}: image ${actualVersion} | lockfile ${expectedVersion}`);
  }

  if (missing.length > 0) {
    return {
      code: EXIT.MISSING_DEPENDENCY,
      messages: ['A direct dependency is missing from the built image.'],
      details: missing.map((name) => `missing: ${name}`),
    };
  }

  if (mismatched.length > 0) {
    return {
      code: EXIT.VERSION_MISMATCH,
      messages: ['Image installed versions differ from package-lock.json.'],
      details: mismatched,
    };
  }

  return { code: EXIT.MATCH, messages: ['Lockfile fidelity: OK.'], details };
}

/**
 * Read the whole observed document from stdin.
 *
 * @returns {Promise<string>}
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT, observedFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root') {
      options.repoRoot = resolve(argv[++i]);
    } else if (arg === '--observed') {
      options.observedFile = resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    return EXIT.UNUSABLE_INPUT;
  }

  let text;
  try {
    text = options.observedFile
      ? readFileSync(options.observedFile, 'utf8')
      : await readStdin();
  } catch (error) {
    process.stderr.write(`::error::could not read the observed dependency graph: ${error.message}\n`);
    return EXIT.UNUSABLE_INPUT;
  }

  if (text.trim() === '') {
    process.stderr.write('::error::observed dependency graph was empty\n');
    return EXIT.UNUSABLE_INPUT;
  }

  let graph;
  let expected;
  try {
    graph = parseObserved(text);
    expected = expectedVersions(options.repoRoot);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    return EXIT.UNUSABLE_INPUT;
  }

  const result = verify(graph, expected);

  // On success everything goes to stdout. On failure every line — the
  // summary and the supporting detail alike — goes to stderr, so a CI log
  // shows the whole diagnostic next to the failed step instead of splitting
  // the explanation across two streams.
  const sink = result.code === EXIT.MATCH ? process.stdout : process.stderr;
  for (const detail of result.details) {
    sink.write(`${detail}\n`);
  }
  for (const message of result.messages) {
    if (result.code === EXIT.MATCH) {
      sink.write(`${message}\n`);
    } else {
      sink.write(`::error::${message}\n`);
    }
  }

  return result.code;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`::error::${error?.message ?? error}\n`);
      process.exitCode = EXIT.UNUSABLE_INPUT;
    },
  );
}
