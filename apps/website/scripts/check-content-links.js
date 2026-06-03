#!/usr/bin/env node
/**
 * Validates that every image path referenced in content JSON files exists
 * on disk under apps/website/public/. Exits 1 if any are missing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = resolve(__dirname, '../src/content');
const publicDir = resolve(__dirname, '../public');

function loadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function collectJsonFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(full));
    } else if (entry.name.endsWith('.json') && entry.name !== 'package.json') {
      files.push(full);
    }
  }
  return files;
}

function checkImages(items, sourceFile) {
  const failures = [];
  for (const item of Array.isArray(items) ? items : [items]) {
    const image = item.image;
    if (!image) continue;
    // image paths are relative to public/, e.g. /brand/systems/foo.jpg
    const normalized = image.startsWith('/') ? image.slice(1) : image;
    const diskPath = join(publicDir, normalized);
    if (!existsSync(diskPath)) {
      failures.push({ file: sourceFile, slug: item.slug || item.name || '(unknown)', image, diskPath });
    }
  }
  return failures;
}

const jsonFiles = collectJsonFiles(contentDir);
const allFailures = [];

for (const file of jsonFiles) {
  const data = loadJson(file);
  allFailures.push(...checkImages(data, file));
}

if (allFailures.length === 0) {
  console.log(`✓ All content image references are valid (${jsonFiles.length} files checked)`);
  process.exit(0);
} else {
  console.error(`✗ ${allFailures.length} missing image file(s):\n`);
  for (const { file, slug, image } of allFailures) {
    const rel = file.replace(contentDir + '/', '');
    console.error(`  ${rel}  [${slug}]  image: ${image}`);
  }
  console.error('\nCreate the missing images before merging.');
  process.exit(1);
}
