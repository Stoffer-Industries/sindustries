#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

function run(script, extraArgs = []) {
  const scriptPath = path.join(__dirname, script);
  console.log(`Running ${script}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}...`);
  execSync(`node "${scriptPath}" ${extraArgs.map(arg => JSON.stringify(String(arg))).join(' ')}`.trim(), {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const maxItemsIndex = args.indexOf('--max-items');
  const maxItems = maxItemsIndex >= 0 ? args[maxItemsIndex + 1] : null;
  const fetchArgs = maxItems ? ['--max-items', maxItems] : [];

  if (force) {
    console.log('=== Processing existing bookmarks (skip fetch) ===');
    run('process.cjs');
  } else {
    console.log('=== Step 1: Fetch bookmarks ===');
    run('fetch.cjs', fetchArgs);

    console.log('\n=== Step 2: Process bookmarks ===');
    run('process.cjs');
  }

  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
