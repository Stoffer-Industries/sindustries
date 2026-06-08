/**
 * Regenerate packages/design-tokens/design-systems.pen from tokens.json.
 * The package build injects token variables/themes and refreshes the generated
 * token specimen while preserving hand-authored component sections.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { repoRootFromThisScript } from './pen-token-kit.mjs';

const repoRoot = repoRootFromThisScript(import.meta.url);
const buildScript = resolve(repoRoot, 'packages/design-tokens/scripts/build-tokens.mjs');

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [buildScript], {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  child.on('error', rejectBuild);
  child.on('exit', (code, signal) => {
    if (code === 0) {
      resolveBuild();
      return;
    }
    rejectBuild(new Error(`design token build failed${signal ? ` from signal ${signal}` : ` with exit code ${code}`}`));
  });
});
