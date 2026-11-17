#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? new URL('../../..', import.meta.url).pathname);
const workflowPath = '.github/workflows/deploy-production-vercel-frontends.yml';
const workflow = readFileSync(resolve(root, workflowPath), 'utf8');
const errors = [];

function requirePattern(pattern, message) {
  if (!pattern.test(workflow)) errors.push(message);
}

requirePattern(/workflow_dispatch:/, 'workflow must be manually dispatchable');
requirePattern(/workflow_call:/, 'workflow must remain reusable');
requirePattern(/environment:\s*production/, 'deploy job must use the production GitHub environment');
requirePattern(/cancel-in-progress:\s*false/, 'production deploys must not cancel in flight');
requirePattern(/PRODUCTION_VERCEL_DEPLOY_ENABLED/, 'workflow must carry the explicit production deploy gate');
requirePattern(/vercel-project-facts\.mjs/, 'project, app path, and domain must come from the repo contract');
requirePattern(/VERCEL_TARGET:\s*production/, 'one production target must drive pull, build, and deploy');
requirePattern(/npm ci/, 'workflow must install from the root workspace lockfile');
requirePattern(/--skip-domain/, 'candidate must stay off the stable domain until promotion');
requirePattern(/vercel promote/, 'candidate must be promoted explicitly');
requirePattern(/verify-live-vercel-bundle\.mjs/, 'workflow must verify the promoted live bundle');
requirePattern(/openssl x509 -noout -checkhost/, 'workflow must verify the stable hostname certificate');
if (/mission-control\.sindustries\.co\.nz|tasks\.sindustries\.co\.nz|sindustries-mission-control|sindustries-tasks/.test(workflow)) {
  errors.push('workflow must not duplicate project names or production hostnames from the matrices');
}
for (const line of workflow.split('\n')) {
  if (!/^\s*vercel (link|pull|build|deploy|promote)\b/.test(line)) continue;
  if (!line.includes('--scope') || !line.includes('--token')) {
    errors.push(`Vercel mutation/read is not explicitly scoped and authenticated: ${line.trim()}`);
  }
  if (line.includes('--token "***"')) errors.push('workflow contains a literal redacted token');
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`production-vercel-deploy contract: ${error}\n`);
  process.exit(1);
}
process.stdout.write('production-vercel-deploy contract check passed\n');
