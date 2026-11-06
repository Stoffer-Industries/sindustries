/**
 * verify-lockfile-fidelity.test.js — task 83edc146 tests.
 *
 * Covers the three things the tech design asks for:
 *
 *   AC1  the observed graph never crosses argv. The unit test feeds a
 *        payload larger than the per-argument exec limit through stdin and
 *        asserts it is parsed; the static test asserts the workflow no
 *        longer hands the npm ls document to `node -e` as an argument.
 *   AC2  the failure classes keep their teeth: invalid graph, missing
 *        dependency and version mismatch each produce their own exit code
 *        and their own diagnostic.
 *   AC3/AC4 are live-operator evidence and are recorded in the task, not
 *        asserted here.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  EXIT,
  expectedVersions,
  invalidNodePaths,
  parseObserved,
  serviceDependencyNames,
  verify,
} from '../scripts/verify-lockfile-fidelity.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'services/gymtrack-mcp/scripts/verify-lockfile-fidelity.mjs');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/gymtrack-mcp-deploy.yml');

/** Linux caps a single argv element at 128 KiB (MAX_ARG_STRLEN). */
const MAX_ARGV_ELEMENT_BYTES = 128 * 1024;

const EXPECTED = expectedVersions(REPO_ROOT);

/**
 * Build an `npm ls --json` shaped document for the service's direct
 * dependencies, optionally padded with extraneous packages.
 *
 * @param {{versions?: Record<string,string>, omit?: string[], invalid?: boolean, extraneous?: number}} options
 * @returns {object}
 */
function observedGraph(options = {}) {
  const { versions = {}, omit = [], invalid = false, extraneous = 0 } = options;
  const dependencies = {};
  for (const [name, expectedVersion] of EXPECTED) {
    if (omit.includes(name)) continue;
    dependencies[name] = { version: versions[name] ?? expectedVersion };
  }
  for (let i = 0; i < extraneous; i += 1) {
    dependencies[`extraneous-package-${i}`] = { version: '0.0.0', extraneous: true };
  }
  const graph = { name: '@sindustries/gymtrack-mcp', version: '0.1.0', dependencies };
  if (invalid) graph.invalid = true;
  return graph;
}

/**
 * Run the verifier CLI, feeding `input` on stdin.
 *
 * `spawn` rather than `execFile`: the asynchronous `execFile` has no
 * `input` option, so the child would wait forever for stdin that never
 * arrives. `stdin.end(input)` writes the document and closes the pipe.
 *
 * @param {string} input
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runVerifier(input, extraArgs = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...extraArgs], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {
      // The verifier may exit before stdin is fully drained; that is not
      // itself a failure of the assertion under test.
    });
    child.stdin.end(input);
  });
}

describe('AC1 — the observed graph never crosses argv', () => {
  test('a payload larger than the argv element limit is parsed through stdin', async () => {
    const graph = observedGraph({ extraneous: 4000 });
    const payload = JSON.stringify(graph);
    expect(payload.length).toBeGreaterThan(MAX_ARGV_ELEMENT_BYTES);

    const result = await runVerifier(payload);
    expect(result.stderr).not.toContain('Argument list too long');
    expect(result.code).toBe(EXIT.MATCH);
    expect(result.stdout).toContain('Lockfile fidelity: OK.');
  });

  test('the same payload still fails the way it should when a version drifts', async () => {
    const [firstDependency] = serviceDependencyNames(REPO_ROOT);
    const graph = observedGraph({ extraneous: 4000, versions: { [firstDependency]: '0.0.0-bogus' } });
    const result = await runVerifier(JSON.stringify(graph));
    expect(result.code).toBe(EXIT.VERSION_MISMATCH);
  });
});

describe('AC2 — the failure classes keep their teeth', () => {
  test('a matching graph exits 0', () => {
    const result = verify(observedGraph(), EXPECTED);
    expect(result.code).toBe(EXIT.MATCH);
  });

  test('an invalid graph exits 1 with its own diagnostic', async () => {
    const result = await runVerifier(JSON.stringify(observedGraph({ invalid: true })));
    expect(result.code).toBe(EXIT.INVALID_GRAPH);
    expect(result.stderr).toContain('npm ls inside the image reported an invalid dependency graph');
  });

  test('an invalid nested node is still reported', () => {
    const graph = observedGraph();
    graph.dependencies.express.invalid = true;
    expect(invalidNodePaths(graph)).toEqual(['$.dependencies.express']);
    expect(verify(graph, EXPECTED).code).toBe(EXIT.INVALID_GRAPH);
  });

  test.each(serviceDependencyNames(REPO_ROOT))('a missing %s exits 2', async (name) => {
    const result = await runVerifier(JSON.stringify(observedGraph({ omit: [name] })));
    expect(result.code).toBe(EXIT.MISSING_DEPENDENCY);
    expect(result.stderr).toContain('A direct dependency is missing from the built image.');
    expect(result.stderr).toContain(name);
  });

  test('a version mismatch exits 3 and names both versions', async () => {
    const [firstDependency] = serviceDependencyNames(REPO_ROOT);
    const result = await runVerifier(
      JSON.stringify(observedGraph({ versions: { [firstDependency]: '9.9.9' } })),
    );
    expect(result.code).toBe(EXIT.VERSION_MISMATCH);
    expect(result.stderr).toContain('Image installed versions differ from package-lock.json.');
    expect(result.stderr).toContain('9.9.9');
    expect(result.stderr).toContain(EXPECTED.get(firstDependency));
  });

  test('an invalid graph is reported before a missing dependency', () => {
    const graph = observedGraph({ invalid: true, omit: [serviceDependencyNames(REPO_ROOT)[0]] });
    expect(verify(graph, EXPECTED).code).toBe(EXIT.INVALID_GRAPH);
  });

  test('malformed JSON exits 4 rather than throwing', async () => {
    const result = await runVerifier('{not json');
    expect(result.code).toBe(EXIT.UNUSABLE_INPUT);
    expect(result.stderr).toContain('not valid JSON');
  });

  test('an empty document exits 4', async () => {
    const result = await runVerifier('   ');
    expect(result.code).toBe(EXIT.UNUSABLE_INPUT);
    expect(result.stderr).toContain('empty');
  });

  test('parseObserved rejects a non-object document', () => {
    expect(() => parseObserved('[]')).toThrow(/not a JSON object/);
  });
});

describe('AC1 — the workflow does not pass the document through argv', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  /** The body of the "Verify image build matches lockfile" step. */
  const verifyStep = (() => {
    const marker = '- name: Verify image build matches lockfile (gymtrack-mcp)';
    const start = workflow.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const rest = workflow.slice(start + marker.length);
    const nextStep = rest.search(/\n {6}- name:/);
    return nextStep === -1 ? rest : rest.slice(0, nextStep);
  })();

  test('the step pipes npm ls into the verifier script', () => {
    expect(verifyStep).toContain('services/gymtrack-mcp/scripts/verify-lockfile-fidelity.mjs');
    expect(verifyStep).toMatch(/npm ls[^\n]*\n?[^\n]*\|\s*node\s+services\/gymtrack-mcp\/scripts\/verify-lockfile-fidelity\.mjs/);
  });

  test('the step no longer parses the document with an inline node -e argument', () => {
    expect(verifyStep).not.toMatch(/node\s+-e/);
    expect(verifyStep).not.toMatch(/\$ACTUAL_JSON/);
    expect(verifyStep).not.toMatch(/\$EXPECTED_JSON/);
  });

  test('the Dockerfile npm install lint is preserved', () => {
    expect(verifyStep).toContain("npm install");
    expect(verifyStep).toContain("Dockerfile contains an unpinned 'npm install' step.");
  });
});
