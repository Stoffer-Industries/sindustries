#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function productionProjectFacts(surfaceId, repoRoot = DEFAULT_ROOT) {
  const hostMatrix = JSON.parse(readFileSync(resolve(repoRoot, 'infra/cloud/hostname-matrix.json'), 'utf8'));
  const envMatrix = JSON.parse(readFileSync(resolve(repoRoot, 'infra/cloud/vercel-env-matrix.json'), 'utf8'));
  const surface = hostMatrix.surfaces?.find((entry) => entry.id === surfaceId && entry.kind === 'frontend');
  if (!surface) throw new Error(`unknown frontend surface "${surfaceId}"`);
  const project = envMatrix.vercelProjects?.find((entry) => entry.vercelProjectId === surface.vercelProject);
  if (!project) throw new Error(`no env-matrix row exists for production project "${surface.vercelProject}"`);
  const environment = project.environments?.production;
  if (!environment || environment.servesEnvironment !== 'production') {
    throw new Error(`${project.vercelProjectId} does not carry a production deployment target serving production`);
  }
  if (environment.customDomain !== surface.production) {
    throw new Error(`${project.vercelProjectId} custom domain does not match the hostname matrix`);
  }
  const appPackage = JSON.parse(readFileSync(resolve(repoRoot, project.appPath, 'package.json'), 'utf8'));
  return {
    surfaceId,
    vercelProjectId: project.vercelProjectId,
    appPath: project.appPath,
    workspaceName: appPackage.name,
    customDomain: environment.customDomain,
    servesEnvironment: environment.servesEnvironment,
    branch: environment.branch,
    provisioned: project.provisioned,
    env: environment.env ?? {},
  };
}

function parseArgs(argv) {
  let surface;
  let field;
  let repoRoot = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--surface') surface = argv[++index];
    else if (arg === '--field') field = argv[++index];
    else if (arg === '--repo-root') repoRoot = resolve(argv[++index]);
    else if (arg === '--json') {}
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!surface) throw new Error('--surface is required');
  return { surface, field, repoRoot };
}

function fieldValue(object, field) {
  return field.split('.').reduce((value, key) => value?.[key], object);
}

function main() {
  try {
    const { surface, field, repoRoot } = parseArgs(process.argv.slice(2));
    const facts = productionProjectFacts(surface, repoRoot);
    if (!field) {
      process.stdout.write(`${JSON.stringify(facts)}\n`);
      return;
    }
    const value = fieldValue(facts, field);
    if (value === undefined || (typeof value === 'object' && value !== null)) {
      throw new Error(`field "${field}" is missing or not scalar`);
    }
    process.stdout.write(`${value}\n`);
  } catch (error) {
    process.stderr.write(`vercel-project-facts: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
