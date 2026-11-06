#!/usr/bin/env node
// check-workflow-shell-syntax.mjs — task 83edc146 static check.
//
// The `gymtrack-mcp production` deploy job failed on main with:
//
//   /home/runner/work/_temp/<uuid>.sh: line 6: syntax error near unexpected token `|'
//
// while the OAuth discovery document the step was checking was correct. The
// cause was a `stable-fallback` annotation comment placed BETWEEN the two
// halves of a backslash-continued pipeline:
//
//   curl --fail ... --max-time 15 \
//     "https://${FLY_APP}.fly.dev/.well-known/oauth-authorization-server" \
//     # stable-fallback: ... rationale ...
//     | grep -F '"registration_endpoint":"..."'
//
// Bash removes the backslash-newline, so the comment swallows the rest of
// the logical line — including the `| grep` — and the next physical line
// starts with a bare `|`, which is a syntax error. The step fails before
// it can assert anything, so a healthy deployment reads as a broken one.
//
// A shell script inside a workflow is not executed at parse time, so a
// syntax error in one is invisible until the job runs it — and then it
// fails at the worst possible moment, during a production deploy. This
// checker parses every `run:` block in every workflow and asks bash to
// parse it too, so the failure lands in CI on the PR that introduced it.
//
// The extraction is line-based rather than YAML-based: this script runs in
// a job with no `npm install`, so it cannot depend on a YAML package. It
// reads the `run:` block scalars GitHub Actions actually uses.
//
// Pure Node 22, no deps. Exits 0 when every run block parses, 1 when one
// does not, 2 on an invocation/IO error.
//
// Usage:
//   node scripts/check-workflow-shell-syntax.mjs [<repo-root>]

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKFLOW_DIR = '.github/workflows';

// A step whose shell is not a POSIX shell is not bash source and is not
// checked. `shell:` is unset for almost every step, and GitHub's default
// on a Linux runner is `bash -e {0}` — which is what this checker parses.
const BASH_SHELLS = new Set(['bash', 'sh']);

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

/**
 * Mask GitHub Actions expressions so bash can parse the surrounding shell.
 *
 * `${{ ... }}` is not valid bash, and the checker is about bash syntax —
 * not about expression interpolation. Replacing the expression with a bare
 * word keeps the surrounding quoting and command structure intact.
 */
export function maskExpressions(script) {
  return script.replace(/\$\{\{[^]*?\}\}/g, 'EXPR');
}

/**
 * Pull every `run:` script out of one workflow file.
 *
 * Returns `[{ job, step, shell, line, script }]`. The parser is
 * line-based on purpose (see the file header): the checker must run in a
 * job with no installed dependencies.
 */
export function extractRunScripts(text) {
  const lines = text.split('\n');
  const results = [];

  let job = null;
  let step = null;

  const flushStep = () => {
    if (!step) return;
    for (const run of step.runs) {
      results.push({
        job: step.job,
        step: step.name,
        shell: step.shell,
        line: run.line,
        script: run.script,
      });
    }
    step = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A job header sits at two-space indentation.
    const jobMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (jobMatch) {
      flushStep();
      job = jobMatch[1];
      continue;
    }

    // A step starts at six-space indentation. The dash may be followed by
    // the step's first key (`- name: ...`) or by a nested mapping.
    const stepMatch = /^ {6}- (.*)$/.exec(line);
    if (stepMatch) {
      flushStep();
      const nameMatch = /^name:\s*(.*)$/.exec(stepMatch[1]);
      step = {
        job,
        name: nameMatch ? nameMatch[1].trim() : '(unnamed step)',
        shell: null,
        runs: [],
      };
      continue;
    }

    if (!step) continue;

    // A step property: `shell:` or `run:`.
    // GitHub custom-shell values may contain arguments, for example
    // `python {0}` or `pwsh -command ". '{0}'"`. The executable is the
    // first token; the remaining tokens are template arguments, not part
    // of the shell name.
    const shellMatch = /^\s*shell:\s*['"]?([^\s'"]+)/.exec(line);
    if (shellMatch) {
      step.shell = shellMatch[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    const runMatch = /^(\s*)run:(.*)$/.exec(line);
    if (!runMatch) continue;

    const indent = runMatch[1].length;
    const rest = runMatch[2].trim();

    // Block scalar: `run: |`, `run: |-`, `run: >`, `run: |2`.
    if (/^[|>][-+]?\d*$/.test(rest)) {
      const folded = rest.startsWith('>');
      const body = [];
      let blockIndent = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bodyLine = lines[j];
        if (bodyLine.trim() === '') {
          body.push('');
          continue;
        }
        const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
        if (bodyIndent <= indent) break;
        if (blockIndent === null) blockIndent = bodyIndent;
        body.push(bodyLine.slice(blockIndent));
      }
      // A folded scalar is one logical line to YAML; joining with a space
      // is the closest bash can get to it.
      step.runs.push({
        line: i + 1,
        script: folded ? body.join(' ').trim() : body.join('\n'),
      });
      i = j - 1;
      continue;
    }

    // Inline scalar: `run: npm ci`.
    if (rest) {
      step.runs.push({ line: i + 1, script: rest });
    }
  }

  flushStep();
  return results;
}

/**
 * Ask bash to parse one script. Returns null when it parses, or the
 * parser's own diagnostic when it does not.
 */
export function bashSyntaxError(script) {
  const result = spawnSync('bash', ['-n'], {
    input: maskExpressions(script),
    encoding: 'utf8',
  });
  if (result.status === 0) return null;
  const message = (result.stderr || '').trim();
  return message || `bash -n exited ${result.status}`;
}

function listWorkflows(repoRoot) {
  const dir = join(repoRoot, WORKFLOW_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join(dir, name));
}

export function checkRepo(repoRoot) {
  const failures = [];
  let checked = 0;

  for (const path of listWorkflows(repoRoot)) {
    const text = readFileSync(path, 'utf8');
    for (const entry of extractRunScripts(text)) {
      if (entry.shell && !BASH_SHELLS.has(entry.shell)) continue;
      checked += 1;
      const error = bashSyntaxError(entry.script);
      if (!error) continue;
      failures.push({
        file: path.slice(repoRoot.length + 1),
        job: entry.job,
        step: entry.step,
        line: entry.line,
        error,
      });
    }
  }

  return { checked, failures };
}

function main(argv) {
  const repoRoot = resolve(argv[0] ?? DEFAULTS);
  let result;
  try {
    result = checkRepo(repoRoot);
  } catch (error) {
    stderr.write(`check-workflow-shell-syntax: ${error.message}\n`);
    exit(2);
  }

  if (result.failures.length === 0) {
    stdout.write(
      `check-workflow-shell-syntax: ${result.checked} workflow run block(s) parse as bash.\n`,
    );
    exit(0);
  }

  stderr.write(
    `check-workflow-shell-syntax: ${result.failures.length} workflow run block(s) do not parse as bash:\n`,
  );
  for (const failure of result.failures) {
    stderr.write(
      `\n  ${failure.file}:${failure.line} — job "${failure.job}", step "${failure.step}"\n`,
    );
    for (const line of failure.error.split('\n')) {
      stderr.write(`    ${line}\n`);
    }
  }
  stderr.write(
    '\nA `run:` block that does not parse fails at run time, not at parse time. ' +
      'Check for a comment placed inside a backslash-continued command: bash removes ' +
      'the continuation, so the comment swallows the rest of the line and the next ' +
      'physical line can start with a bare `|`.\n',
  );
  exit(1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2));
}
