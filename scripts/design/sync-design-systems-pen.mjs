/**
 * Strip `imports` from packages/design-tokens/design-systems.pen.
 * Token variables are merged by `npm run build` in @sindustries/design-tokens;
 * this file must not depend on `tokens.pen` so it can be saved as a Pencil library.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { repoRootFromThisScript, serializePenDocument } from './pen-token-kit.mjs';

const repoRoot = repoRootFromThisScript(import.meta.url);
const penPath = resolve(repoRoot, 'packages/design-tokens/design-systems.pen');

const doc = JSON.parse(await readFile(penPath, 'utf8'));
delete doc.imports;
await writeFile(penPath, serializePenDocument(doc));
