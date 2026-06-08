/**
 * Shared helpers for .pen files that touch @sindustries/design-tokens Pencil outputs.
 * `design-systems.pen` uses local variables named `si-color-*`, `si-radius-*`, …
 * On-canvas references use `$si-color-bg-canvas`, `$si-radius-md`, etc.
 * Product files should import `design-systems.pen`; it carries both token variables and components.
 * `design-systems.pen` is merged by `npm run build` and must not use nested imports (Pencil library constraint).
 * Use stripRootVariables only for product files that must not carry a duplicate variable table.
 */
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRootFromThisScript(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), '../..');
}

export function designSystemsPenAbs(repoRoot) {
  return resolve(repoRoot, 'packages/design-tokens/design-systems.pen');
}

/** Backwards-compatible name for callers that mean "the token-carrying Pencil library". */
export function designTokensPenAbs(repoRoot) {
  return designSystemsPenAbs(repoRoot);
}

/** Relative POSIX path from the importing .pen file to design-systems.pen */
export function importPathToDesignTokens(fromPenAbsPath, repoRoot) {
  const kit = designSystemsPenAbs(repoRoot);
  let rel = relative(dirname(fromPenAbsPath), kit);
  if (!rel.startsWith('.') && rel !== '') rel = `./${rel}`;
  return rel.split('\\').join('/');
}

/**
 * @param {object} doc - parsed .pen document
 * @param {string} fromPenAbsPath - absolute path to the .pen being edited
 * @param {string} repoRoot
 * @param {{ alias?: string; stripRootVariables?: boolean }} [opts]
 */
export function applyDesignTokensImport(doc, fromPenAbsPath, repoRoot, opts = {}) {
  const alias = opts.alias ?? 'si';
  const stripRootVariables = opts.stripRootVariables ?? false;
  const rel = importPathToDesignTokens(fromPenAbsPath, repoRoot);
  doc.imports = { ...(doc.imports ?? {}), [alias]: rel };
  if (stripRootVariables) delete doc.variables;
  return doc;
}

export function serializePenDocument(doc) {
  const ordered = {
    version: doc.version,
    ...(doc.imports ? { imports: doc.imports } : {}),
    children: doc.children,
    ...(doc.themes ? { themes: doc.themes } : {}),
    ...(doc.variables ? { variables: doc.variables } : {})
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
