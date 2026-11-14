#!/usr/bin/env node
// stable-hostname-live-verify-workflow.test.mjs — task 5cb4a8fe contract test.
//
// The AC5 live hostname harness has so far only run from the operator's Mac,
// which sits behind a secret egress proxy. Every request to a
// *.sindustries.co.nz host from there came back 502 with the body "Secret
// egress proxy could not reach the upstream host", which the harness
// classifies as failureMode=proxy_blocked — an observer-side block, not a
// deployment verdict. With the proxy unset the same two frontend rows fail
// as failureMode=transport_error.
//
// Neither observation can close the AC5 frontend clause ("frontend roots and
// assets work through the stable hostnames") or the AC2 TLS clause
// ("certificates valid for every public hostname"): both need one run from a
// host that is simply on the public internet.
//
// .github/workflows/stable-hostname-live-verify.yml is that path: a
// dispatch-only, credential-free, proxy-free runner that executes the live
// harness and uploads the redacted result JSON.
//
// This test locks that contract down STRUCTURALLY, not by string matching.
// The first version of this test asserted loose substrings, and it stayed
// green through edits that broke the contract it claimed to protect: it
// would have passed if the workflow had gained a `workflow_call` trigger, an
// inline trigger, a `github.token` reference, a checkout that persisted
// credentials, a deploy command, an `if: always()` on an unrelated step, or
// a proxy clear that left the host-specific egress variables in place. Each
// of those is a different way for this job to stop being a public-internet
// observer, so each is now asserted structurally: the workflow is parsed
// into jobs and steps, and the assertions are made about that shape.
//
// Pure Node 22, no deps (node:test + node:assert). Reads the workflow from
// the repository tree; it makes no network call and needs no credentials.
//
// Run with: node --test tests/cloud/tests/stable-hostname-live-verify-workflow.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = join(repoRoot, '.github/workflows/stable-hostname-live-verify.yml');
const harnessPath = join(repoRoot, 'tests/cloud/scripts/stable-hostname-verification.mjs');

const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';

// The executable content of the workflow: YAML comment lines are stripped so
// that prose about secrets cannot trip the credential guard, while a real
// reference (in a step, an env block or an `if:`) still does.
const executable = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// ---------------------------------------------------------------------------
// Minimal YAML parser for the subset this workflow uses.
//
// The repository has no YAML dependency at the root, and the contract test
// must run offline on the runner's Node. The workflow is a plain block
// mapping: two-space indentation, `key: value` scalars, nested mappings,
// one sequence (the step list) and block scalars (`run: |`). That subset is
// small enough to parse here, and parsing it — instead of grepping the raw
// text — is what makes the structural assertions possible.
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBlockScalar(src, start, parentIndent) {
  const collected = [];
  let index = start;
  while (index < src.length) {
    const line = src[index];
    if (line.trim() === '') {
      collected.push('');
      index += 1;
      continue;
    }
    if (indentOf(line) <= parentIndent) break;
    collected.push(line);
    index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  const meaningful = collected.filter((line) => line.trim() !== '');
  const strip = meaningful.length > 0 ? Math.min(...meaningful.map(indentOf)) : 0;
  return [collected.map((line) => (line === '' ? '' : line.slice(strip))).join('\n'), index];
}

function parseMap(src, start, indent) {
  const map = {};
  let index = start;
  while (index < src.length) {
    while (index < src.length && isIgnorable(src[index])) index += 1;
    if (index >= src.length) break;
    const line = src[index];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) break;
    const match = /^([^:#]+):(.*)$/.exec(trimmed);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1].trim();
    const rest = match[2].trim();
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const [text, next] = parseBlockScalar(src, index + 1, lineIndent);
      map[key] = text;
      index = next;
      continue;
    }
    if (rest === '') {
      const [value, next] = parseBlock(src, index + 1, lineIndent + 1);
      map[key] = value === undefined ? null : value;
      index = next;
      continue;
    }
    map[key] = parseScalar(rest);
    index += 1;
  }
  return [map, index];
}

function parseSeq(src, start, indent) {
  const items = [];
  let index = start;
  while (index < src.length) {
    while (index < src.length && isIgnorable(src[index])) index += 1;
    if (index >= src.length) break;
    const line = src[index];
    if (indentOf(line) !== indent || !line.trim().startsWith('- ')) break;
    const rest = line.trim().slice(2);
    const itemIndent = indent + 2;
    const collected = [' '.repeat(itemIndent) + rest];
    let cursor = index + 1;
    while (cursor < src.length) {
      const candidate = src[cursor];
      if (candidate.trim() === '') {
        collected.push('');
        cursor += 1;
        continue;
      }
      if (indentOf(candidate) <= indent) break;
      collected.push(candidate);
      cursor += 1;
    }
    const [value] = parseMap(collected, 0, itemIndent);
    items.push(value);
    index = cursor;
  }
  return [items, index];
}

function parseBlock(src, start, indent) {
  let index = start;
  while (index < src.length && isIgnorable(src[index])) index += 1;
  if (index >= src.length) return [null, index];
  const lineIndent = indentOf(src[index]);
  if (lineIndent < indent) return [null, index];
  if (src[index].trim().startsWith('- ')) return parseSeq(src, index, lineIndent);
  return parseMap(src, index, lineIndent);
}

function parseYamlSubset(text) {
  const [value] = parseBlock(text.split('\n'), 0, 0);
  return value;
}

const parsed = parseYamlSubset(workflow);
const jobNames = parsed && parsed.jobs ? Object.keys(parsed.jobs) : [];
const steps = jobNames.length === 1 && parsed.jobs[jobNames[0]].steps
  ? parsed.jobs[jobNames[0]].steps
  : [];
const harnessStep = steps.find((step) => typeof step.run === 'string' && step.run.includes('stable-hostname-verification.mjs'));
const checkoutStep = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'));
const artifactStep = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact'));

// ---------------------------------------------------------------------------
// Shell helpers: split a run block into logical lines and read the first
// command of each one, so the "this workflow only runs the harness" claim is
// checked against the shell it actually executes.
// ---------------------------------------------------------------------------

function splitShellLogicalLines(text) {
  const lines = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        current += ch + (text[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 1;
      current += ' ';
      continue;
    }
    // A `#` that starts a word begins a comment, which runs to the end of
    // the line. Comments are stripped BEFORE quote tracking, because an
    // apostrophe in prose ("the repository's own wrappers") would otherwise
    // open a quote that swallows the rest of the run block.
    if (ch === '#' && (current === '' || /[\s;()]/.test(current[current.length - 1]))) {
      while (i < text.length && text[i] !== '\n') i += 1;
      lines.push(current);
      current = '';
      continue;
    }
    if (ch === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  lines.push(current);
  return lines;
}

function firstCommandOf(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return null; // plain assignment
  const match = /^([A-Za-z0-9_./-]+)/.exec(trimmed);
  return match ? match[1] : null;
}

function unsetVariables(runBlock) {
  const cleared = [];
  for (const line of splitShellLogicalLines(runBlock)) {
    const trimmed = line.trim();
    if (!/^unset\s+/.test(trimmed)) continue;
    for (const name of trimmed.replace(/^unset\s+/, '').split(/\s+/)) {
      if (name) cleared.push(name);
    }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// The contract, stated once.
// ---------------------------------------------------------------------------

// The complete direct-egress list. The six standard HTTP proxy variables
// come from the original workflow; the CA-bundle variables are the ones the
// repository's own direct-egress wrappers drop (agents/lib/github-cli.sh,
// infra/cloud/bin/status — an ambient SSL_CERT_FILE pointing at a proxy
// trust bundle makes a direct connection fail TLS verification); the
// host-specific egress variables are this host's own proxy settings.
const REQUIRED_UNSET = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HUMAN_PROXY',
  'SECRET_EGRESS_PROXY',
  'human_proxy',
  'secret_egress_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

// The only actions this job may run.
const ALLOWED_ACTIONS = [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/upload-artifact@v4',
];

// The only commands a run block may start with.
const ALLOWED_COMMANDS = new Set([
  'set',
  'unset',
  'export',
  'echo',
  'node',
  'git',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'exit',
  'true',
  'false',
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the live verification workflow exists and is non-empty', () => {
  assert.ok(existsSync(workflowPath), 'workflow file is missing');
  assert.ok(workflow.length > 0, 'workflow file is empty');
});

test('the harness it invokes exists in the tree', () => {
  assert.ok(existsSync(harnessPath), 'the AC5 live harness is missing');
});

test('the workflow parses into exactly one job with a step list', () => {
  assert.ok(parsed && typeof parsed === 'object', 'the workflow did not parse');
  assert.equal(jobNames.length, 1, 'the workflow must declare exactly one job');
  assert.ok(Array.isArray(steps) && steps.length > 0, 'the job must declare steps');
});

test('it declares exactly one trigger: workflow_dispatch', () => {
  assert.ok(parsed.on, 'the workflow must declare an `on:` block');
  assert.deepEqual(
    Object.keys(parsed.on),
    ['workflow_dispatch'],
    'workflow_dispatch must be the only trigger',
  );
  const inputs = parsed.on.workflow_dispatch.inputs;
  assert.deepEqual(
    Object.keys(inputs),
    ['intent_commit'],
    'workflow_dispatch may only declare the intent_commit input',
  );
  assert.equal(inputs.intent_commit.required, false);
  assert.equal(inputs.intent_commit.default, '');
});

test('it needs no credentials', () => {
  assert.deepEqual(
    parsed.permissions,
    { contents: 'read' },
    'the job must declare read-only contents permission and nothing else',
  );
  assert.ok(!executable.includes('secrets.'), 'the workflow must not reference a secret');
  assert.ok(!executable.includes('github.token'), 'the workflow must not reference github.token');
  for (const job of Object.values(parsed.jobs ?? {})) {
    assert.ok(!('environment' in job), 'the workflow must not require a GitHub environment');
  }
});

test('the checkout persists no credentials and is pinned to the dispatched commit', () => {
  assert.ok(checkoutStep, 'the workflow must have a checkout step');
  assert.equal(checkoutStep.uses, 'actions/checkout@v4');
  assert.equal(
    checkoutStep.with?.['persist-credentials'],
    false,
    'actions/checkout must set persist-credentials: false',
  );
  assert.ok(
    String(checkoutStep.with?.ref ?? '').includes('github.sha'),
    'the checkout must be pinned to the dispatched commit (github.sha)',
  );
});

test('every action it uses is on the allowlist, exactly once', () => {
  const used = steps.map((step) => step.uses).filter(Boolean);
  for (const action of used) {
    assert.ok(
      ALLOWED_ACTIONS.includes(action),
      `the workflow must not use the action ${action}`,
    );
  }
  for (const action of ALLOWED_ACTIONS) {
    assert.equal(
      used.filter((entry) => entry === action).length,
      1,
      `the workflow must use ${action} exactly once`,
    );
  }
});

test('the evidence is bound to the commit the run actually executed', () => {
  assert.ok(harnessStep, 'the workflow must have a step that runs the harness');
  const resolveStep = steps.find(
    (step) => typeof step.run === 'string' && step.run.includes('git rev-parse HEAD'),
  );
  assert.ok(resolveStep, 'the workflow must resolve the checked-out commit');
  assert.ok(
    resolveStep.run.includes('GITHUB_OUTPUT'),
    'the resolved commit must be published as a step output',
  );
  assert.ok(
    String(harnessStep.env?.VERIFY_COMMIT ?? '').includes('steps.commit.outputs.commit'),
    'the harness must receive the resolved commit from the resolve step',
  );
  assert.ok(
    harnessStep.run.includes('--intent-commit "${VERIFY_COMMIT}"'),
    'the harness must record the resolved commit as its intent commit',
  );
  assert.ok(
    !harnessStep.run.includes('github.event.inputs.intent_commit'),
    'the harness must not receive the raw intent_commit input',
  );
  assert.ok(
    /r\.intentCommit\s*!==\s*expected/.test(harnessStep.run),
    'the result JSON must be checked against the executed commit',
  );
});

test('it clears the complete proxy environment so the request path is direct', () => {
  assert.ok(harnessStep, 'the workflow must have a step that runs the harness');
  const cleared = unsetVariables(harnessStep.run);
  for (const name of REQUIRED_UNSET) {
    assert.ok(cleared.includes(name), `the direct path must clear ${name}`);
  }
  for (const name of cleared) {
    assert.ok(
      REQUIRED_UNSET.includes(name),
      `the proxy clear list must not grow unreviewed (${name})`,
    );
  }
  assert.ok(harnessStep.run.includes("export NO_PROXY='*'"), 'NO_PROXY must be pinned');
  assert.ok(harnessStep.run.includes("no_proxy='*'"), 'no_proxy must be pinned');
});

test('it runs the live harness on a public-internet runner', () => {
  assert.ok(parsed.jobs[jobNames[0]]['runs-on'] === 'ubuntu-latest');
  assert.ok(harnessStep.run.includes('tests/cloud/scripts/stable-hostname-verification.mjs'));
  assert.ok(harnessStep.run.includes('--mode live'));
});

test('it uploads the redacted result even when the harness fails', () => {
  assert.ok(artifactStep, 'the workflow must have an artifact upload step');
  assert.equal(artifactStep.uses, 'actions/upload-artifact@v4');
  assert.equal(
    artifactStep.if,
    'always()',
    'the artifact step itself must run even when the harness fails',
  );
  const conditional = steps.filter((step) => step.if !== undefined);
  assert.equal(
    conditional.length,
    1,
    'no step other than the artifact upload may carry an `if:` condition',
  );
  assert.ok(String(artifactStep.with?.path ?? '').includes('stable-hostname-verification.json'));
});

test('it never deploys or touches a provider control plane', () => {
  for (const step of steps) {
    if (typeof step.run !== 'string') continue;
    for (const line of splitShellLogicalLines(step.run)) {
      const command = firstCommandOf(line);
      if (command === null) continue;
      assert.ok(
        ALLOWED_COMMANDS.has(command),
        `the workflow must not run the command ${command}`,
      );
    }
  }
  for (const forbidden of [
    'fly deploy',
    'flyctl deploy',
    'vercel deploy',
    'fly secrets set',
    'fly certs add',
    'npm publish',
    'gh api',
    'curl',
    'wget',
    'ssh ',
  ]) {
    assert.ok(
      !executable.includes(forbidden),
      `the workflow must not run a provider command: ${forbidden}`,
    );
  }
});
