#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(repoRoot, 'packages/ui');
const designTokensRoot = resolve(repoRoot, 'packages/design-tokens');

const REACT_EXPORT_PATTERN = /^export (?:const|function) (\w+)/gm;
const UTIL_EXPORTS = new Set(['cx', 'PULSE_TILT_CLASSES']);

async function readReactExports() {
  const source = await readFile(resolve(uiRoot, 'src/react/index.jsx'), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(REACT_EXPORT_PATTERN)) {
    if (!UTIL_EXPORTS.has(match[1])) names.add(match[1]);
  }
  return names;
}

async function readCatalogComponents() {
  const catalog = JSON.parse(await readFile(resolve(uiRoot, 'component-catalog.json'), 'utf8'));
  return new Set(Object.keys(catalog.components));
}

function runBuild() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@sindustries/design-tokens'], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runGitDiff(paths) {
  const result = spawnSync('git', ['diff', '--quiet', '--', ...paths], { cwd: repoRoot });
  return result.status === 0;
}

async function main() {
  const reactExports = await readReactExports();
  const catalogComponents = await readCatalogComponents();

  const missingFromCatalog = [...reactExports].filter((name) => !catalogComponents.has(name));
  const extraInCatalog = [...catalogComponents].filter((name) => !reactExports.has(name));

  if (missingFromCatalog.length) {
    console.error('React exports missing from component-catalog.json:', missingFromCatalog.join(', '));
    process.exit(1);
  }

  if (extraInCatalog.length) {
    console.error('component-catalog.json entries not exported from React:', extraInCatalog.join(', '));
    process.exit(1);
  }

  runBuild();

  const generatedPaths = [
    'packages/design-tokens/styles.css',
    'packages/design-tokens/src/tokens.ts',
    'packages/design-tokens/pen-tokens.json',
    'packages/design-tokens/design-systems.pen',
    'packages/ui/src/specimen/generated/manifest.js',
    'packages/ui/src/specimen/generated/pages.js',
    'packages/ui/src/specimen/generated/catalog.js'
  ];

  if (!runGitDiff(generatedPaths)) {
    console.error('Generated design-system artifacts are out of date. Run: npm run build --workspace @sindustries/design-tokens');
    process.exit(1);
  }

  console.log('Design system sync check passed.');
}

await main();
