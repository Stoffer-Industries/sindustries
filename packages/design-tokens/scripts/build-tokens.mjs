import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDesignSystemsDocument } from './pen-document.mjs';
import {
  buildPenSpecimenFrames,
  loadComponentCatalog,
  loadSpecimenLayout
} from './pen-specimens.mjs';
import { writeUiSpecimenArtifacts } from './ui-specimen.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = resolve(packageRoot, 'tokens.json');
const cssPath = resolve(packageRoot, 'styles.css');
const tsPath = resolve(packageRoot, 'src/tokens.ts');
const penTokensJsonPath = resolve(packageRoot, 'pen-tokens.json');
const designSystemsPenPath = resolve(packageRoot, 'design-systems.pen');

const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));

function getPathValue(path) {
  return path.split('.').reduce((value, key) => value?.[key], tokens);
}

function resolveReference(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^}]+)\}/g, (_, path) => String(getPathValue(path)));
}

function resolveTree(value) {
  if (Array.isArray(value)) return value.map(resolveTree);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTree(child)]));
  }
  return resolveReference(value);
}

const resolved = resolveTree(tokens);

// ---------------------------------------------------------------------------
// Auto-derived token inventories
// ---------------------------------------------------------------------------
// Adding a new key to tokens.json should be sufficient — these inventories drive
// CSS variables, Pencil themed variables, and the generated TS `colors` export
// without any further wiring. Curated specimen swatches stay explicit because
// "which tokens to show" is an editorial choice; see swatches/labelSwatches.

const kebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Flat list of core color primitives → CSS/Pencil variable name + value. */
const corePrimitiveColors = [];
for (const [group, variants] of Object.entries(resolved.core.color)) {
  if (variants && typeof variants === 'object') {
    for (const [variant, value] of Object.entries(variants)) {
      corePrimitiveColors.push({
        cssName: `si-color-${group}-${variant}`,
        value
      });
    }
  }
}

function flattenLeaves(value, path = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path, value }];
  }

  return Object.entries(value).flatMap(([key, child]) => flattenLeaves(child, [...path, key]));
}

const budgetColorTokens = flattenLeaves(resolved.budget?.color ?? {}).map(({ path, value }) => ({
  cssName: `si-budget-color-${path.map(kebab).join('-')}`,
  value
}));

const budgetSpaceTokens = flattenLeaves(resolved.budget?.space ?? {}).map(({ path, value }) => ({
  cssName: `si-budget-space-${path.join('-').replaceAll('_', '-')}`,
  value
}));

const budgetRadiusTokens = flattenLeaves(resolved.budget?.radius ?? {}).map(({ path, value }) => ({
  cssName: `si-budget-radius-${path.map(kebab).join('-')}`,
  value
}));

/**
 * Mode-aware semantic colors — every key under `semantic.modes.light` (must
 * match `semantic.modes.dark`) produces an `--si-color-<kebab>` CSS variable
 * and a themed Pencil variable.
 */
const semanticModeKeys = Object.keys(resolved.semantic.modes.light);
const semanticModeColors = semanticModeKeys.map((modeKey) => ({
  modeKey,
  cssName: `si-color-${kebab(modeKey)}`,
  lightValue: resolved.semantic.modes.light[modeKey],
  darkValue: resolved.semantic.modes.dark[modeKey]
}));

const surfaceStackKeys = resolved.semantic.surfaceStack ?? [];

// ---------------------------------------------------------------------------
// Pencil variables
// ---------------------------------------------------------------------------

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(Number(n))));
}

/** Pencil color fields prefer #RRGGBB or #RRGGBBAA (uppercase). */
function colorToPencil(value) {
  if (typeof value !== 'string') return '#000000';
  const v = value.trim();
  const rgba = v.match(
    /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i
  );
  if (rgba) {
    const r = clampByte(rgba[1]);
    const g = clampByte(rgba[2]);
    const b = clampByte(rgba[3]);
    const a = clampByte(Number(rgba[4]) * 255);
    const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${h(a)}`;
  }
  const rgb = v.match(/^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i);
  if (rgb) {
    const r = clampByte(rgb[1]);
    const g = clampByte(rgb[2]);
    const b = clampByte(rgb[3]);
    const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  if (v.startsWith('#')) return v.toUpperCase();
  return v;
}

function themedColorFromModes(lightVal, darkVal) {
  return {
    type: 'color',
    value: [
      { value: colorToPencil(String(lightVal)), theme: { Mode: 'Light' } },
      { value: colorToPencil(String(darkVal)), theme: { Mode: 'Dark' } }
    ]
  };
}

function buildPencilVariables() {
  const v = {};

  for (const { cssName, value } of corePrimitiveColors) {
    v[cssName] = { type: 'color', value: colorToPencil(String(value)) };
  }

  for (const { cssName, value } of budgetColorTokens) {
    v[cssName] = { type: 'color', value: colorToPencil(String(value)) };
  }

  for (const { cssName, lightValue, darkValue } of semanticModeColors) {
    v[cssName] = themedColorFromModes(lightValue, darkValue);
  }

  v['si-font-body'] = { type: 'string', value: String(resolved.semantic.font.body) };
  v['si-font-ui'] = { type: 'string', value: String(resolved.semantic.font.ui) };
  v['si-font-display'] = { type: 'string', value: String(resolved.semantic.font.display) };

  for (const [key, val] of Object.entries(resolved.core.space)) {
    v[`si-space-${key}`] = { type: 'number', value: Number(val) };
  }
  for (const [key, val] of Object.entries(resolved.core.radius)) {
    v[`si-radius-${key}`] = { type: 'number', value: Number(val) };
  }
  for (const { cssName, value } of budgetSpaceTokens) {
    v[cssName] = { type: 'number', value: Number(value) };
  }
  for (const { cssName, value } of budgetRadiusTokens) {
    v[cssName] = { type: 'number', value: Number(value) };
  }

  v['si-shadow-soft'] = { type: 'string', value: String(resolved.semantic.shadow.soft) };
  v['si-shadow-hard'] = { type: 'string', value: String(resolved.semantic.shadow.hard) };

  return v;
}

const pencilVariables = buildPencilVariables();

async function mergeVariablesIntoDesignSystemsPen() {
  let raw;
  try {
    raw = await readFile(designSystemsPenPath, 'utf8');
  } catch {
    return;
  }

  const layout = await loadSpecimenLayout();
  const catalog = await loadComponentCatalog();

  const doc = JSON.parse(raw);
  const penLibraryChildren = doc.children?.find((child) => child?.id === 'vtHps')?.children ?? [];
  normalizeDesignSystemsDocument(doc, {
    pencilVariables,
    buildSpecimenFrames: () => buildPenSpecimenFrames({ resolved, layout, catalog, penLibraryChildren })
  });
  const ordered = {
    version: doc.version,
    children: doc.children,
    themes: doc.themes,
    variables: doc.variables
  };
  await writeFile(designSystemsPenPath, `${JSON.stringify(ordered, null, 2)}\n`);

  await writeUiSpecimenArtifacts({ layout, catalog });
}

const penTokensPayload = {
  description:
    'GENERATED — do not edit this file by hand unless you know what you are doing. Produced from tokens.json via scripts/build-tokens.mjs (run npm run build in this package).',
  variables: pencilVariables
};

// ---------------------------------------------------------------------------
// styles.css
// ---------------------------------------------------------------------------

function cssVar(name, value) {
  return `  --${name}: ${value};`;
}

function pxVar(name, value) {
  return cssVar(name, `${value}px`);
}

const corePrimitiveLines = corePrimitiveColors.map(({ cssName, value }) => cssVar(cssName, value));
const budgetColorLines = budgetColorTokens.map(({ cssName, value }) => cssVar(cssName, value));
const darkSemanticLines = semanticModeColors.map(({ cssName, darkValue }) => cssVar(cssName, darkValue));
const lightSemanticLines = semanticModeColors.map(({ cssName, lightValue }) => cssVar(cssName, lightValue));
const surfaceStackUtilityLines = surfaceStackKeys.map(
  (modeKey) => `[data-si-surface="${modeKey}"] { background: var(--si-color-${kebab(modeKey)}); }`
);

const generatedCssBanner = `/*
 * GENERATED FILE — do not edit by hand unless you know what you are doing.
 * Source of truth: tokens.json → run \`npm run build\` in this package (scripts/build-tokens.mjs).
 */

`;

const css = `${generatedCssBanner}@import url('https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Inter:wght@400;500;600;700;800&family=Work+Sans:wght@400;500;600;700;800;900&display=swap');

:root,
[data-si-theme="dark"] {
  color-scheme: dark;

${[
  ...corePrimitiveLines,
  ...budgetColorLines,
  '',
  ...darkSemanticLines,
  '',
  cssVar('si-font-body', `'${resolved.semantic.font.body}', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`),
  cssVar('si-font-ui', `'${resolved.semantic.font.ui}', 'Work Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`),
  cssVar('si-font-display', `'${resolved.semantic.font.display}', 'Work Sans', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`),
  '',
  ...Object.entries(resolved.core.space).map(([key, value]) => pxVar(`si-space-${key}`, value)),
  '',
  ...Object.entries(resolved.core.radius).map(([key, value]) => pxVar(`si-radius-${key}`, value)),
  '',
  ...budgetSpaceTokens.map(({ cssName, value }) => pxVar(cssName, value)),
  '',
  ...budgetRadiusTokens.map(({ cssName, value }) => pxVar(cssName, value)),
  '',
  cssVar('si-shadow-soft', resolved.semantic.shadow.soft),
  cssVar('si-shadow-hard', resolved.semantic.shadow.hard)
].join('\n')}
}

[data-si-theme="light"] {
  color-scheme: light;

${lightSemanticLines.join('\n')}
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  font-family: var(--si-font-body);
  line-height: 1.5;
  font-weight: 400;
  background: var(--si-color-bg-canvas);
  color: var(--si-color-text-primary);
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background: var(--si-color-bg-canvas);
  color: var(--si-color-text-primary);
}

button,
input,
select,
textarea {
  font: inherit;
}

a {
  color: inherit;
  text-decoration: none;
}

#root {
  min-height: 100vh;
}

${surfaceStackUtilityLines.join('\n')}
`;

// ---------------------------------------------------------------------------
// src/tokens.ts
// ---------------------------------------------------------------------------
//
// `colors` and `colorsLight` auto-expand every semantic-mode key from
// tokens.json, then layer the small set of ergonomic shortcuts (core-color
// aliases, status aliases, nested `labels` object) on top for backward
// compatibility. Adding a new semantic-mode key in tokens.json appears here
// automatically; the explicit extras only need editing if you want a
// renamed/grouped accessor for an existing token.

function renderModeBlock(modeAccessor) {
  const semantic = semanticModeKeys.map((k) => `  ${k}: ${modeAccessor}.${k},`).join('\n');
  return `{
${semantic}
  brand: tokens.core.color.brand[500],
  /** Solid ink for labels/icons on brand yellow (not themed canvas). */
  ink950: tokens.core.color.ink[950],
  sage: tokens.core.color.sage[500],
  accentPink: tokens.core.color.accent[500],
  info: ${modeAccessor}.statusInfo,
  success: ${modeAccessor}.statusSuccess,
  danger: ${modeAccessor}.statusDanger,
  labels: {
    green: ${modeAccessor}.labelGreen,
    blue: ${modeAccessor}.labelBlue,
    orange: ${modeAccessor}.labelOrange,
    purple: ${modeAccessor}.labelPurple,
    gray: ${modeAccessor}.labelGray
  },
  chart: {
    groceries: ${modeAccessor}.labelGreen,
    subscriptions: ${modeAccessor}.labelBlue,
    transport: ${modeAccessor}.labelOrange,
    dining: ${modeAccessor}.labelPurple,
    other: ${modeAccessor}.labelGray
  }
} as const`;
}

function renderSurfaceBlock(modeAccessor) {
  const lines = surfaceStackKeys.map((modeKey) => `  ${modeKey}: ${modeAccessor}.${modeKey},`);
  return `{\n${lines.join('\n')}\n} as const`;
}

const generatedTsBanner = `/**
 * GENERATED FILE — do not edit by hand unless you know what you are doing.
 * Source of truth: tokens.json → run \`npm run build\` in this package (scripts/build-tokens.mjs).
 */

`;

const ts = `${generatedTsBanner}export const tokens = ${JSON.stringify(resolved, null, 2)} as const;

export type SemanticMode = (typeof tokens)['semantic']['modes']['light'];

/** Light and dark appearance (canonical source: tokens.json → semantic.modes). */
export const semanticModes = tokens.semantic.modes;

const dark = tokens.semantic.modes.dark;
const light = tokens.semantic.modes.light;

/** Default export shape matches the previous dark-first API (dark mode). */
export const colors = ${renderModeBlock('dark')};

/** Same keys as \`colors\`, resolved for light mode. */
export const colorsLight = ${renderModeBlock('light')};

export const colorsDark = colors;

export const fonts = tokens.semantic.font;
export const space = tokens.core.space;
export const radius = tokens.core.radius;
export const budget = tokens.budget;
export const platform = tokens.platform;

/** Surface stack color keys (see tokens.semantic.surfaceStack). */
export const surfaceStack = tokens.semantic.surfaceStack;

/** Resolved surface colors for dark mode. */
export const surfaces = ${renderSurfaceBlock('dark')};

/** Resolved surface colors for light mode. */
export const surfacesLight = ${renderSurfaceBlock('light')};
`;

await mkdir(dirname(tsPath), { recursive: true });
await writeFile(cssPath, css);
await writeFile(tsPath, ts);
await writeFile(penTokensJsonPath, `${JSON.stringify(penTokensPayload, null, 2)}\n`);
await mergeVariablesIntoDesignSystemsPen();
