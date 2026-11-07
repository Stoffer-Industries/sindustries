#!/usr/bin/env node
// check-vercel-production-promotion-scope.mjs — task 1ac03ee8 static check.
//
// The website production deploy failed on main with "Deployment belongs to a
// different team". The staging job creates the candidate deployment under
// the Vercel project and team recorded in VERCEL_PROJECT_ID / VERCEL_ORG_ID
// (its `vercel pull` writes the project link). The production job runs on a
// clean runner with no project link, so the CLI resolved the candidate under
// the token's default scope and the promotion was refused.
//
// The fix makes the production path establish that scope explicitly, from
// the same two secrets the staging job uses:
//
//   - a production step links the project (`vercel link --project
//     $VERCEL_PROJECT_ID --scope $VERCEL_ORG_ID`), and
//   - every mutating production call (`vercel promote`, `vercel alias set`)
//     carries `--scope $VERCEL_ORG_ID`.
//
// This checker asserts that contract, so the scoping cannot regress
// silently. It asserts semantic anchors and shared-variable use rather than
// exact step bodies, so harmless YAML formatting changes do not fail the
// gate. The matching
// `tests/cloud/tests/check-vercel-production-promotion-scope.test.mjs`
// exercises the checker against synthetic good and mutated workflows,
// proving each assertion can demonstrably fail.
//
// Pure Node 22, no deps. Exits 0 when every assertion holds, 1 when one
// fails, 2 on an invocation/IO error.
//
// Usage:
//   node scripts/check-vercel-production-promotion-scope.mjs [<repo-root>]

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = '.github/workflows/website-deploy.yml';
const JOB_ID = 'deploy';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

function parseArgs() {
  const args = process.argv.slice(2);
  return { repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

// Strip quotes so a flag written as --scope="$VERCEL_ORG_ID" and one
// written as --scope=$VERCEL_ORG_ID are treated as the same assertion.
function unquote(text) {
  return text.replace(/["']/g, '');
}

// The block of a single job: every line from the job's own key up to the
// next job key at the same indent.
function extractJobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// Job-scope `env:` entries (two levels below the job key, so four-space
// `env:` with six-space keys).
function extractJobEnv(jobBlock) {
  const env = new Map();
  const lines = jobBlock.split(/\r?\n/);
  let inEnv = false;
  for (const line of lines) {
    if (/^    env:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      // Blank lines and comments belong to the env block and must not end it.
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      const match = /^      ([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (match) {
        env.set(match[1], match[2].trim());
        continue;
      }
      inEnv = false;
    }
  }
  return env;
}

// Steps of the job, in order, with the body of each step.
function extractSteps(jobBlock) {
  const lines = jobBlock.split(/\r?\n/);
  const steps = [];
  let current = null;
  for (const line of lines) {
    const match = /^      - name:\s*(.+)$/.exec(line);
    if (match) {
      current = { name: match[1].trim(), lines: [] };
      steps.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return steps.map((step) => ({
    name: step.name,
    body: step.lines.join('\n'),
  }));
}

// The `vercel <command>` invocations of a step body, with the command and
// the line it was found on. Comment lines are ignored, and a leading dot
// (".vercel/project.json") is not a command.
function extractVercelInvocations(body) {
  const invocations = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /(?:^|[;&|(\s])vercel\s+([a-z][a-z-]*)/.exec(trimmed);
    if (match) invocations.push({ command: match[1], line: trimmed });
  }
  return invocations;
}

// The value passed to --scope on a command line, or null when the flag is
// absent.
function scopeArgument(line) {
  const match = /--scope(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(line);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return unquote(value);
}

// The value passed to --project on a command line, or null when the flag is
// absent.
function projectArgument(line) {
  const match = /--project(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(line);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return unquote(value);
}

// The `--scope` values used anywhere in the workflow file.
function allScopeArguments(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const match = /--scope(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(trimmed);
    if (match) values.push(unquote(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  return values;
}

function main() {
  const { repoRoot } = parseArgs();
  const workflowPath = join(repoRoot, WORKFLOW_PATH);

  let text;
  try {
    text = readFileSync(workflowPath, 'utf8');
  } catch (err) {
    stderr.write(`vercel production promotion scope check failed: could not read ${workflowPath}: ${err.message}\n`);
    exit(2);
  }

  const errors = [];

  const jobBlock = extractJobBlock(text, JOB_ID);
  if (!jobBlock) {
    stderr.write(`vercel production promotion scope check failed: no \`${JOB_ID}\` job found in ${WORKFLOW_PATH}\n`);
    exit(1);
  }

  const env = extractJobEnv(jobBlock);
  const steps = extractSteps(jobBlock);

  // 1. The scope has one explicit source: the job-scope secrets.
  const scopeSource = env.get('VERCEL_ORG_ID');
  if (scopeSource === undefined) {
    errors.push(`the \`${JOB_ID}\` job does not define a job-scope \`VERCEL_ORG_ID\``);
  } else if (!scopeSource.includes('secrets.VERCEL_ORG_ID')) {
    errors.push(`job-scope \`VERCEL_ORG_ID\` does not come from \`secrets.VERCEL_ORG_ID\` (found: ${scopeSource})`);
  }

  const projectSource = env.get('VERCEL_PROJECT_ID');
  if (projectSource === undefined) {
    errors.push(`the \`${JOB_ID}\` job does not define a job-scope \`VERCEL_PROJECT_ID\``);
  } else if (!projectSource.includes('secrets.VERCEL_PROJECT_ID')) {
    errors.push(`job-scope \`VERCEL_PROJECT_ID\` does not come from \`secrets.VERCEL_PROJECT_ID\` (found: ${projectSource})`);
  }

  const tokenSource = env.get('VERCEL_TOKEN');
  if (tokenSource === undefined) {
    errors.push(`the \`${JOB_ID}\` job does not define a job-scope \`VERCEL_TOKEN\``);
  } else if (!tokenSource.includes('secrets.VERCEL_TOKEN')) {
    errors.push(`job-scope \`VERCEL_TOKEN\` does not come from \`secrets.VERCEL_TOKEN\` (found: ${tokenSource})`);
  }

  // 2. Every scope in the workflow is that one variable — never a literal
  //    team id or slug, which is how the two sides drift apart.
  for (const value of allScopeArguments(text)) {
    if (value !== '$VERCEL_ORG_ID') {
      errors.push(`a \`--scope\` argument is not the job-scope \`$VERCEL_ORG_ID\` (found: ${value})`);
    }
  }

  // 3. The production path must establish the project and team scope.
  const productionSteps = steps.filter((step) => step.body.includes("inputs.target == 'production'"));
  if (productionSteps.length === 0) {
    errors.push(`the \`${JOB_ID}\` job has no production step`);
  }

  const productionInvocations = [];
  for (const step of productionSteps) {
    for (const invocation of extractVercelInvocations(step.body)) {
      productionInvocations.push({ ...invocation, step: step.name });
    }
  }

  const linkInvocations = productionInvocations.filter((invocation) => invocation.command === 'link');
  if (linkInvocations.length === 0) {
    errors.push('the production path never links the Vercel project; the candidate\'s project/team context is not established');
  }
  for (const invocation of linkInvocations) {
    const project = projectArgument(invocation.line);
    if (project !== '$VERCEL_PROJECT_ID') {
      errors.push(
        `step "${invocation.step}" links the project with \`${project}\`; `
        + 'it must link the job-scope `$VERCEL_PROJECT_ID` so the scope has one source',
      );
    }
  }

  // 4. Every mutating production call carries the explicit scope.
  for (const invocation of productionInvocations) {
    const scope = scopeArgument(invocation.line);
    if (scope === null) {
      errors.push(
        `step "${invocation.step}" runs \`vercel ${invocation.command}\` without \`--scope\`; `
        + 'the production path must resolve the candidate in an explicit Vercel team scope',
      );
      continue;
    }
    if (scope !== '$VERCEL_ORG_ID') {
      errors.push(
        `step "${invocation.step}" runs \`vercel ${invocation.command}\` with scope \`${scope}\`; `
        + 'the scope must be the job-scope `$VERCEL_ORG_ID`',
      );
    }
  }

  // 5. The promotion itself must still exist, and still target the
  //    production domain.
  const promoteInvocations = productionInvocations.filter((invocation) => invocation.command === 'promote');
  if (promoteInvocations.length === 0) {
    errors.push('the production path no longer promotes a candidate deployment');
  }
  const productionAlias = productionInvocations.find(
    (invocation) => invocation.command === 'alias' && invocation.line.includes('$PRODUCTION_DOMAIN'),
  );
  if (!productionAlias) {
    errors.push('the production path no longer aliases the candidate to `$PRODUCTION_DOMAIN`');
  }

  // 6. The staging path that creates the candidate must stay intact.
  const stagingSteps = steps.filter((step) => step.body.includes("inputs.target == 'staging'"));
  const stagingInvocations = stagingSteps.flatMap((step) => extractVercelInvocations(step.body));
  const commands = new Set(stagingInvocations.map((invocation) => invocation.command));
  for (const command of ['pull', 'build', 'deploy']) {
    if (!commands.has(command)) {
      errors.push(`the staging path no longer runs \`vercel ${command}\`; the candidate is no longer created the same way`);
    }
  }

  if (errors.length > 0) {
    stderr.write(`vercel production promotion scope check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const error of errors) stderr.write(`  - ${error}\n`);
    exit(1);
  }

  stdout.write(
    'vercel production promotion scope check passed '
    + `(the production path resolves the candidate in the job-scope $VERCEL_ORG_ID team in ${WORKFLOW_PATH})\n`,
  );
}

main();
