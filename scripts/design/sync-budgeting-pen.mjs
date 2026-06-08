/**
 * Align docs/designs/budgeting/main.pen with @sindustries/design-tokens:
 * - sets imports → design-systems.pen (variables + components; standalone library)
 * - removes duplicate root `variables` if present
 * - removes legacy on-canvas specimen frame (id q4Jkj) if still present
 *
 * Run when that file needs normalization (e.g. after merges).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { repoRootFromThisScript, serializePenDocument } from './pen-token-kit.mjs';

const repoRoot = repoRootFromThisScript(import.meta.url);
const mainPenPath = resolve(repoRoot, 'docs/designs/budgeting/main.pen');
const designSystemsKit = resolve(repoRoot, 'packages/design-tokens/design-systems.pen');

function relTo(fromAbs, toAbs) {
  let r = relative(dirname(fromAbs), toAbs);
  if (!r.startsWith('.') && r !== '') r = `./${r}`;
  return r.split('\\').join('/');
}

const doc = JSON.parse(await readFile(mainPenPath, 'utf8'));
const canvas = doc.children?.[0];
if (canvas?.id === 'dbYmA' && Array.isArray(canvas.children)) {
  canvas.children = canvas.children.filter((n) => n.id !== 'q4Jkj');
}
delete doc.variables;
doc.imports = {
  ui: relTo(mainPenPath, designSystemsKit)
};
await writeFile(mainPenPath, serializePenDocument(doc));
