#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function args(argv) {
  const result = { repoRoot: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--surface') result.surface = argv[++index];
    else if (arg === '--url') result.url = argv[++index];
    else if (arg === '--repo-root') result.repoRoot = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.surface) throw new Error('--surface is required');
  return result;
}

export async function verifyLiveBundle({ surface, url, repoRoot = DEFAULT_ROOT, fetchImpl = fetch }) {
  const hostMatrix = JSON.parse(readFileSync(resolve(repoRoot, 'infra/cloud/hostname-matrix.json'), 'utf8'));
  const envMatrix = JSON.parse(readFileSync(resolve(repoRoot, 'infra/cloud/vercel-env-matrix.json'), 'utf8'));
  const hostSurface = hostMatrix.surfaces.find((entry) => entry.id === surface && entry.kind === 'frontend');
  if (!hostSurface) throw new Error(`unknown frontend surface "${surface}"`);
  const project = envMatrix.vercelProjects.find((entry) => entry.vercelProjectId === hostSurface.vercelProject);
  const environment = project?.environments?.production;
  if (!environment || environment.servesEnvironment !== 'production') throw new Error(`no production Vercel contract exists for "${surface}"`);
  const baseUrl = new URL(url ?? `https://${environment.customDomain}/`);
  const htmlResponse = await fetchImpl(baseUrl, { redirect: 'follow' });
  if (!htmlResponse.ok) throw new Error(`GET ${baseUrl} returned ${htmlResponse.status}`);
  const html = await htmlResponse.text();
  const assets = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => new URL(match[1], baseUrl));
  if (assets.length === 0) throw new Error('live HTML contains no script assets');
  const bodies = [];
  for (const asset of assets) {
    const response = await fetchImpl(asset, { redirect: 'follow' });
    if (!response.ok) throw new Error(`GET ${asset} returned ${response.status}`);
    bodies.push(await response.text());
  }
  const bundle = bodies.join('\n');
  const expected = Object.values(environment.env ?? {});
  for (const value of expected) {
    if (!bundle.includes(value)) throw new Error(`live bundle is missing expected production value ${value}`);
  }
  const stagingNeedles = hostMatrix.surfaces.flatMap((entry) => [entry.staging, entry.staging ? `https://${entry.staging}` : null]).filter(Boolean);
  for (const needle of stagingNeedles) {
    if (bundle.includes(needle)) throw new Error(`live production bundle leaks staging value ${needle}`);
  }
  return { surface, url: baseUrl.href, assets: assets.length, expectedValues: expected.length };
}

async function main() {
  try {
    const evidence = await verifyLiveBundle(args(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    process.stderr.write(`verify-live-vercel-bundle: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
