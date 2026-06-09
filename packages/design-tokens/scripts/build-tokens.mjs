import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDesignSystemsDocument } from './pen-document.mjs';

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
  const doc = JSON.parse(raw);
  normalizeDesignSystemsDocument(doc, {
    pencilVariables,
    buildSpecimen: () =>
      buildPencilSpecimenDocumentChildren({
        introContent:
          'Generated in design-systems.pen from tokens.json. Import this document in product .pen files for variables + components; compare with web /tokens and the React Native Token Specimen screen.'
      })
  });
  const ordered = {
    version: doc.version,
    children: doc.children,
    themes: doc.themes,
    variables: doc.variables
  };
  await writeFile(designSystemsPenPath, `${JSON.stringify(ordered, null, 2)}\n`);
}

const penTokensPayload = {
  description:
    'GENERATED — do not edit this file by hand unless you know what you are doing. Produced from tokens.json via scripts/build-tokens.mjs (run npm run build in this package).',
  variables: pencilVariables
};

// ---------------------------------------------------------------------------
// Pencil specimen document
// ---------------------------------------------------------------------------

const strokeSubtle = {
  align: 'inside',
  thickness: 1,
  fill: '$si-color-border-subtle'
};

/**
 * Full token specimen (colors, type, space, radius, UI sample) generated from `resolved`.
 * Product .pen files import this document for variables; open this file to review tokens in Pencil.
 */
function buildPencilSpecimenDocumentChildren({
  introContent = 'Generated in design-systems.pen from tokens.json. Import design-systems.pen (library) in product UI for variables + components; compare with web /tokens and the React Native Token Specimen screen.'
} = {}) {
  const fonts = resolved.semantic.font;
  const sp = resolved.core.space;
  const rad = resolved.core.radius;

  // Curated swatch lists: which tokens to spotlight in the specimen is an
  // editorial choice, so this stays hand-maintained. The build script does not
  // require any of these entries to exist — missing names are skipped.
  const swatchRowsSource = [
    [
      ['Canvas', 'si-color-bg-canvas'],
      ['Surface', 'si-color-bg-surface'],
      ['Surface alt', 'si-color-bg-surface-alt'],
      ['Surface contrast', 'si-color-bg-surface-contrast'],
      ['Primary text', 'si-color-text-primary'],
      ['Muted text', 'si-color-text-muted']
    ],
    [
      ['Brand', 'si-color-brand-500'],
      ['Accent Pink', 'si-color-accent-500'],
      ['Sage', 'si-color-sage-500']
    ],
    [
      ['Success', 'si-color-success-500'],
      ['Danger', 'si-color-danger-500']
    ]
  ];
  const swatches = swatchRowsSource.flat();

  const labelSwatches = [
    ['Green', 'si-color-label-green'],
    ['Blue', 'si-color-label-blue'],
    ['Orange', 'si-color-label-orange'],
    ['Purple', 'si-color-label-purple'],
    ['Gray', 'si-color-label-gray']
  ];

  const swatchCards = swatches.map(([label, key], i) => ({
    type: 'frame',
    id: `siSws${i}`,
    width: 104,
    height: 86,
    fill: '$si-color-bg-canvas-alt',
    cornerRadius: '$si-radius-md',
    stroke: strokeSubtle,
    layout: 'vertical',
    gap: 6,
    padding: 8,
    children: [
      {
        type: 'rectangle',
        id: `siSws${i}q`,
        width: 'fill_container',
        height: 28,
        cornerRadius: '$si-radius-sm',
        fill: `$${key}`
      },
      {
        type: 'text',
        id: `siSws${i}t`,
        fill: '$si-color-text-primary',
        content: label,
        fontFamily: 'Inter',
        fontSize: 11,
        fontWeight: '800',
        textGrowth: 'auto'
      }
    ]
  }));

  const swatchRows = swatchRowsSource.map((rowSource, ri) => ({
    type: 'frame',
    id: `siSwRow${ri}`,
    width: 'fill_container',
    height: 94,
    layout: 'horizontal',
    gap: 12,
    alignItems: 'center',
    children: rowSource.map(([, key]) => swatchCards[swatches.findIndex(([, swatchKey]) => swatchKey === key)])
  }));

  const labelCards = labelSwatches.map(([label, key], i) => ({
    type: 'frame',
    id: `siLbl${i}`,
    width: 104,
    height: 86,
    fill: '$si-color-bg-canvas-alt',
    cornerRadius: '$si-radius-md',
    stroke: strokeSubtle,
    layout: 'vertical',
    gap: 6,
    padding: 8,
    children: [
      {
        type: 'rectangle',
        id: `siLbl${i}q`,
        width: 'fill_container',
        height: 28,
        cornerRadius: '$si-radius-sm',
        fill: `$${key}`
      },
      {
        type: 'text',
        id: `siLbl${i}t`,
        fill: '$si-color-text-primary',
        content: label,
        fontFamily: 'Inter',
        fontSize: 11,
        fontWeight: '800',
        textGrowth: 'auto'
      }
    ]
  }));

  const labelRow = {
    type: 'frame',
    id: 'siLblRow',
    width: 'fill_container',
    height: 94,
    layout: 'horizontal',
    gap: 12,
    alignItems: 'center',
    children: labelCards
  };

  const spaceBars = Object.entries(sp)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, w]) => ({
      type: 'frame',
      id: `siSpk${k}`,
      layout: 'vertical',
      gap: 4,
      width: Math.max(Number(w), 20),
      height: 58,
      alignItems: 'center',
      children: [
        {
          type: 'frame',
          id: `siSpb${k}`,
          width: Number(w),
          height: 36,
          fill: '$si-color-brand-500',
          cornerRadius: '$si-radius-sm'
        },
        {
          type: 'text',
          id: `siSpl${k}`,
          fill: '$si-color-text-muted',
          content: String(k),
          fontFamily: 'Inter',
          fontSize: 10,
          fontWeight: '600',
          textGrowth: 'auto'
        }
      ]
    }));

  const radiusTiles = Object.entries(rad).map(([k, r]) => ({
    type: 'frame',
    id: `siRdk${k}`,
    width: 76,
    height: 76,
    fill: '$si-color-bg-canvas-alt',
    cornerRadius: Number(r),
    stroke: strokeSubtle,
    layout: 'vertical',
    justifyContent: 'center',
    alignItems: 'center',
    children: [
      {
        type: 'text',
        id: `siRdl${k}`,
        fill: '$si-color-text-primary',
        content: k,
        fontFamily: 'Inter',
        fontSize: 11,
        fontWeight: '700',
        textGrowth: 'auto'
      }
    ]
  }));

  return [
    {
      type: 'frame',
      id: 'siSpecRoot',
      name: 'Design tokens specimen',
      theme: { Mode: 'Dark' },
      x: 32,
      y: 32,
      width: 960,
      height: 1370,
      fill: '$si-color-bg-canvas',
      cornerRadius: '$si-radius-xl',
      layout: 'vertical',
      gap: 18,
      padding: 24,
      children: [
        {
          type: 'frame',
          id: 'siSpecHdr',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 10,
          padding: 22,
          children: [
            {
              type: 'text',
              id: 'siSpecEyebrow',
              fill: '$si-color-brand-500',
              content: 'DESIGN TOKENS',
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: '800',
              letterSpacing: 1.4,
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecTitle',
              fill: '$si-color-text-primary',
              content: 'Pencil token specimen',
              fontFamily: 'Inter',
              fontSize: 32,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecDesc',
              fill: '$si-color-text-secondary',
              textGrowth: 'fixed-width',
              width: 860,
              lineHeight: 1.3,
              fontFamily: 'Work Sans',
              fontSize: 15,
              fontWeight: 'normal',
              content: introContent
            }
          ]
        },
        {
          type: 'frame',
          id: 'siSpecColorSec',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 14,
          padding: 18,
          children: [
            {
              type: 'text',
              id: 'siSpecColorTitle',
              fill: '$si-color-text-primary',
              content: 'Color',
              fontFamily: 'Inter',
              fontSize: 20,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            ...swatchRows
          ]
        },
        {
          type: 'frame',
          id: 'siSpecLabelSec',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 14,
          padding: 18,
          children: [
            {
              type: 'text',
              id: 'siSpecLabelTitle',
              fill: '$si-color-text-primary',
              content: 'Color Labels',
              fontFamily: 'Inter',
              fontSize: 20,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            labelRow
          ]
        },
        {
          type: 'frame',
          id: 'siSpecTypeSec',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 12,
          padding: 18,
          children: [
            {
              type: 'text',
              id: 'siSpecTypeTitle',
              fill: '$si-color-text-primary',
              content: 'Typography',
              fontFamily: 'Inter',
              fontSize: 20,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecDisplay',
              fill: '$si-color-text-primary',
              content: 'Display face',
              fontFamily: fonts.display,
              fontSize: 30,
              fontWeight: 'normal',
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecUi',
              fill: '$si-color-brand-500',
              content: 'UI LABEL AND CONTROLS',
              fontFamily: fonts.ui,
              fontSize: 13,
              fontWeight: '800',
              letterSpacing: 1.2,
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecTertiary',
              fill: '$si-color-text-tertiary',
              content: 'Tertiary headers',
              fontFamily: fonts.display,
              fontSize: 15,
              fontWeight: 'normal',
              letterSpacing: 1.2,
              textGrowth: 'auto'
            },
            {
              type: 'text',
              id: 'siSpecBody',
              fill: '$si-color-text-secondary',
              content: 'Body copy with text.secondary for longer readable text.',
              fontFamily: fonts.body,
              fontSize: 15,
              fontWeight: 'normal',
              textGrowth: 'fixed-width',
              width: 860,
              lineHeight: 1.35
            }
          ]
        },
        {
          type: 'frame',
          id: 'siSpecSpaceSec',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 12,
          padding: 18,
          children: [
            {
              type: 'text',
              id: 'siSpecSpaceTitle',
              fill: '$si-color-text-primary',
              content: 'Space',
              fontFamily: 'Inter',
              fontSize: 20,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            {
              type: 'frame',
              id: 'siSpecSpaceRow',
              width: 'fill_container',
              height: 68,
              layout: 'horizontal',
              gap: 12,
              alignItems: 'end',
              children: spaceBars
            }
          ]
        },
        {
          type: 'frame',
          id: 'siSpecRadSec',
          width: 'fill_container',
          fill: '$si-color-bg-surface',
          cornerRadius: '$si-radius-lg',
          stroke: strokeSubtle,
          layout: 'vertical',
          gap: 12,
          padding: 18,
          children: [
            {
              type: 'text',
              id: 'siSpecRadTitle',
              fill: '$si-color-text-primary',
              content: 'Radius',
              fontFamily: 'Inter',
              fontSize: 20,
              fontWeight: '800',
              textGrowth: 'auto'
            },
            {
              type: 'frame',
              id: 'siSpecRadRow',
              width: 'fill_container',
              height: 88,
              layout: 'horizontal',
              gap: 12,
              alignItems: 'center',
              children: radiusTiles
            }
          ]
        }
      ]
    }
  ];
}

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
const darkSemanticLines = semanticModeColors.map(({ cssName, darkValue }) => cssVar(cssName, darkValue));
const lightSemanticLines = semanticModeColors.map(({ cssName, lightValue }) => cssVar(cssName, lightValue));

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
  }
} as const`;
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
export const platform = tokens.platform;
`;

await mkdir(dirname(tsPath), { recursive: true });
await writeFile(cssPath, css);
await writeFile(tsPath, ts);
await writeFile(penTokensJsonPath, `${JSON.stringify(penTokensPayload, null, 2)}\n`);
await mergeVariablesIntoDesignSystemsPen();
