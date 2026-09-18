// scripts/test/build-tailwind-theme.test.mjs
//
// Unit tests for scripts/build-tailwind-theme.mjs. Run with:
//   node --test scripts/test/build-tailwind-theme.test.mjs
//
// Each test creates an isolated temp directory holding a synthetic
// `packages/design-tokens/styles.css` source and a synthetic output
// path under a fake `packages/ui/src/react/`, runs the generator, and
// asserts on the produced file. The tests do not touch the repo's real
// files; the generator is invoked directly via dynamic import.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT_URL = new URL('../build-tailwind-theme.mjs', import.meta.url).pathname;

async function runGenerator(inputCss, outputDir) {
  // The generator resolves its input/output paths relative to its
  // own location (`repoRoot/packages/design-tokens/styles.css` ->
  // `repoRoot/packages/ui/src/react/tailwind-theme.css`). The
  // `BTT_INPUT_CSS` / `BTT_OUTPUT_CSS` env vars redirect both
  // endpoints to temp paths so each test is fully isolated.
  const inputAbs = resolve(outputDir, 'input.css');
  const outputAbs = resolve(outputDir, 'output.css');
  writeFileSync(inputAbs, inputCss);

  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', [SCRIPT_URL], {
    cwd: outputDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BTT_INPUT_CSS: inputAbs,
      BTT_OUTPUT_CSS: outputAbs
    }
  });
  assert.equal(
    r.status,
    0,
    `generator exited non-zero\nstdout: ${r.stdout}\nstderr: ${r.stderr}`
  );
  return { stdout: r.stdout, output: readFileSync(outputAbs, 'utf8') };
}

function makeWorkdir() {
  return mkdtempSync(join(tmpdir(), 'btt-'));
}

test('emits the @theme inline header + tailwind import (no tokens @import to avoid double-bundle)', async () => {
  const dir = makeWorkdir();
  try {
    const { output } = await runGenerator(
      ':root {\n  --si-color-cta-primary: #ff0000;\n}\n',
      dir
    );
    assert.match(output, /@import "tailwindcss";/);
    // The bridge deliberately does NOT `@import` the source tokens
    // CSS — the consuming stylesheet (packages/ui/src/react/styles.css)
    // already does, and a second @import would cause Lightning CSS to
    // emit the tokens file's own @import url() twice. Confirm the
    // bridge only carries the Tailwind @import.
    assert.equal(
      (output.match(/^@import /gm) || []).length,
      1,
      'expected exactly one @import directive (tailwindcss)'
    );
    assert.match(output, /@theme inline \{/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps each --si-<category>-* declaration to its tailwind namespace', async () => {
  const dir = makeWorkdir();
  try {
    const { output } = await runGenerator(
      [
        ':root {',
        '  --si-color-cta-primary: #ff0000;',
        '  --si-color-bone-50: #f4f2ee;',
        '  --si-font-ui: "Inter", sans-serif;',
        '  --si-radius-md: 0.5rem;',
        '  --si-shadow-soft: 0 1px 2px rgba(0,0,0,0.05);',
        '  --si-space-1: 4px;',
        '  --si-space-4: 16px;',
        '}'
      ].join('\n'),
      dir
    );
    assert.match(output, /--color-cta-primary: var\(--si-color-cta-primary\);/);
    assert.match(output, /--color-bone-50: var\(--si-color-bone-50\);/);
    assert.match(output, /--font-ui: var\(--si-font-ui\);/);
    assert.match(output, /--radius-md: var\(--si-radius-md\);/);
    assert.match(output, /--shadow-soft: var\(--si-shadow-soft\);/);
    assert.match(output, /--spacing-1: var\(--si-space-1\);/);
    assert.match(output, /--spacing-4: var\(--si-space-4\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drops unknown categories (no namespace mapping)', async () => {
  const dir = makeWorkdir();
  try {
    const { output } = await runGenerator(
      ':root {\n  --si-z-index-modal: 100;\n  --si-color-cta-primary: #ff0000;\n}\n',
      dir
    );
    assert.doesNotMatch(output, /--z-index/);
    assert.match(output, /--color-cta-primary: var\(--si-color-cta-primary\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sorts declarations alphabetically within each section', async () => {
  const dir = makeWorkdir();
  try {
    const { output } = await runGenerator(
      ':root {\n  --si-color-zeta: #000;\n  --si-color-alpha: #fff;\n  --si-color-mid: #888;\n}\n',
      dir
    );
    const colorSection = output.split('/* color')[1].split('/* font')[0];
    const lines = colorSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('--color-'));
    assert.deepEqual(lines, [
      '--color-alpha: var(--si-color-alpha);',
      '--color-mid: var(--si-color-mid);',
      '--color-zeta: var(--si-color-zeta);'
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deduplicates declarations when both :root and [data-si-theme="dark"] declare the same token', async () => {
  const dir = makeWorkdir();
  try {
    const { output } = await runGenerator(
      [
        ':root, [data-si-theme="dark"] {',
        '  --si-color-cta-primary: #ff0000;',
        '  --si-color-cta-primary: #ff0000;',
        '}'
      ].join('\n'),
      dir
    );
    const occurrences = (output.match(/--color-cta-primary:/g) || []).length;
    assert.equal(occurrences, 1, 'duplicate declaration should be deduplicated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs a token-count summary on stdout', async () => {
  const dir = makeWorkdir();
  try {
    const { stdout } = await runGenerator(
      ':root {\n  --si-color-a: #000;\n  --si-color-b: #111;\n  --si-font-ui: Inter;\n}\n',
      dir
    );
    assert.match(stdout, /^wrote .+\.css \(\d+ tokens;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});