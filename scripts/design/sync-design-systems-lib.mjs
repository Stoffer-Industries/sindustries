/**
 * Regenerate packages/design-tokens/design-systems.lib.pen from design-systems.pen.
 * Product Pencil files import the .lib.pen copy so source edits to the design
 * system kit need a deterministic export step.
 */
import { readFile, writeFile } from 'node:fs/promises';

import {
  designSystemsLibPenAbs,
  designSystemsPenAbs,
  repoRootFromThisScript,
  serializePenDocument
} from './pen-token-kit.mjs';

const repoRoot = repoRootFromThisScript(import.meta.url);
const designSystemsPenPath = designSystemsPenAbs(repoRoot);
const designSystemsLibPenPath = designSystemsLibPenAbs(repoRoot);

const doc = JSON.parse(await readFile(designSystemsPenPath, 'utf8'));
await writeFile(designSystemsLibPenPath, serializePenDocument(doc));
