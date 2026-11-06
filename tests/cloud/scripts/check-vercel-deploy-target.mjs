#!/usr/bin/env node
// check-vercel-deploy-target.mjs — task 37622d4f static check.
//
// The website staging deploy failed on main because the workflow built
// production-targeted prebuilt output (`vercel build --prod`) and then
// deployed it without a matching target (`vercel deploy --prebuilt`),
// so Vercel refused to publish production-targeted output as a preview
// deployment.
//
// The fix resolves ONE Vercel target at job scope and makes the pull,
// build, and deploy phases all consume it. This checker asserts that
// contract, so the build and deploy targets cannot drift apart again.
//
// It asserts semantic anchors and shared-variable use rather than exact
// step bodies, so harmless YAML formatting changes do not fail the gate.
// The matching
// `tests/cloud/tests/check-vercel-deploy-target.test.mjs` exercises the
// checker against synthetic good and mutated workflows, proving each
// assertion can demonstrably fail.
//
// Pure Node 22, no deps. Exits 0 when every assertion holds, 1 when one
// fails, 2 on an invocation/IO error.
//
// Usage:
//   node scripts/check-vercel-deploy-target.mjs [<repo-root>]

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = '.github/workflows/website-deploy.yml';
const JOB_ID = 'deploy';

const STEP_NAMES = {
  pull: 'Pull Vercel environment',
  build: 'Build Vercel output',
  deploy: 'Deploy candidate to staging',
  smoke: 'Smoke check staging candidate',
};

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

function parseArgs() {
  const args = process.argv.slice(2);
  return { repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

// Strip quotes so a flag written as --target="$VERCEL_TARGET" and one
// written as --target=$VERCEL_TARGET are treated as the same assertion.
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

function findStep(steps, name) {
  return steps.find((step) => step.name === name) || null;
}

function main() {
  const { repoRoot } = parseArgs();
  const workflowPath = join(repoRoot, WORKFLOW_PATH);

  let text;
  try {
    text = readFileSync(workflowPath, 'utf8');
  } catch (err) {
    stderr.write(`vercel deploy target check failed: could not read ${workflowPath}: ${err.message}\n`);
    exit(2);
  }

  const errors = [];

  const jobBlock = extractJobBlock(text, JOB_ID);
  if (!jobBlock) {
    stderr.write(`vercel deploy target check failed: no \`${JOB_ID}\` job found in ${WORKFLOW_PATH}\n`);
    exit(1);
  }

  const env = extractJobEnv(jobBlock);
  const steps = extractSteps(jobBlock);
  const stepBodies = new Map(steps.map((step) => [step.name, unquote(step.body)]));

  // 1. Exactly one target decision, at job scope.
  const target = env.get('VERCEL_TARGET');
  if (target === undefined) {
    errors.push(`the \`${JOB_ID}\` job does not define a job-scope \`VERCEL_TARGET\``);
  } else {
    if (!target.includes('inputs.production-candidate')) {
      errors.push(`\`VERCEL_TARGET\` is not derived from \`inputs.production-candidate\` (found: ${target})`);
    }
    if (!target.includes("'production'") || !target.includes("'preview'")) {
      errors.push(`\`VERCEL_TARGET\` does not resolve to both 'production' and 'preview' (found: ${target})`);
    }
  }

  // 2. No step may re-decide the target.
  const decisionsInSteps = steps.filter((step) => step.body.includes('production-candidate'));
  if (decisionsInSteps.length > 0) {
    errors.push(
      `step(s) ${decisionsInSteps.map((s) => `"${s.name}"`).join(', ')} still evaluate \`production-candidate\`; `
      + 'the target must be resolved once at job scope',
    );
  }

  // 3. Pull, build, and deploy all consume the shared target.
  const expectations = [
    { key: 'pull', flag: '--environment=$VERCEL_TARGET', what: 'environment' },
    { key: 'build', flag: '--target=$VERCEL_TARGET', what: 'target' },
    { key: 'deploy', flag: '--target=$VERCEL_TARGET', what: 'target' },
  ];
  for (const expectation of expectations) {
    const name = STEP_NAMES[expectation.key];
    const body = stepBodies.get(name);
    if (body === undefined) {
      errors.push(`the \`${JOB_ID}\` job has no step named "${name}"`);
      continue;
    }
    if (!body.includes(expectation.flag)) {
      errors.push(
        `step "${name}" does not consume the shared \`VERCEL_TARGET\` `
        + `(expected ${expectation.flag}); build and deploy must not decide the target separately`,
      );
    }
  }

  // 4. The build step must not carry its own production flag.
  const buildBody = stepBodies.get(STEP_NAMES.build);
  if (buildBody !== undefined && buildBody.includes('--prod')) {
    errors.push(`step "${STEP_NAMES.build}" uses \`--prod\`; the target must come from the shared \`VERCEL_TARGET\``);
  }

  // 5. The production deploy path must skip automatic production-domain
  //    assignment, and that flag must ride the resolved target.
  const deployBody = stepBodies.get(STEP_NAMES.deploy);
  if (deployBody !== undefined) {
    if (!deployBody.includes('--skip-domain')) {
      errors.push(`step "${STEP_NAMES.deploy}" does not pass \`--skip-domain\`; a production-configured candidate would claim the production domains before promotion`);
    }
    if (!/\$VERCEL_TARGET\s*=\s*production/.test(deployBody)) {
      errors.push(`step "${STEP_NAMES.deploy}" does not bind \`--skip-domain\` to the resolved \`VERCEL_TARGET\``);
    }
    if (!deployBody.includes('vercel alias set $DEPLOY_URL $STAGING_DOMAIN')) {
      errors.push(`step "${STEP_NAMES.deploy}" no longer aliases the candidate to the staging domain`);
    }
  }

  // 6. The smoke check must still run against the candidate URL.
  const smokeBody = stepBodies.get(STEP_NAMES.smoke);
  if (smokeBody !== undefined && !smokeBody.includes('steps.staging_deploy.outputs.url')) {
    errors.push(`step "${STEP_NAMES.smoke}" no longer checks the candidate deployment URL`);
  }

  if (errors.length > 0) {
    stderr.write(`vercel deploy target check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const error of errors) stderr.write(`  - ${error}\n`);
    exit(1);
  }

  stdout.write(`vercel deploy target check passed (one shared VERCEL_TARGET drives pull, build, and deploy in ${WORKFLOW_PATH})\n`);
}

main();
