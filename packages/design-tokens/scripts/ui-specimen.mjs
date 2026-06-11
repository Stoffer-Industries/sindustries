import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui');
const generatedDir = resolve(uiRoot, 'src/specimen/generated');

const generatedBanner = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: specimen-layout.json + component-catalog.json → npm run build in @sindustries/design-tokens
 */
`;

export async function writeUiSpecimenArtifacts({ layout, catalog }) {
  await mkdir(generatedDir, { recursive: true });

  const colorRows = layout.swatches.colorRows.map((row) =>
    row.map(([label, token]) => [label, `var(--${token})`])
  );

  const labelColors = layout.swatches.labelColors.map(([label, token]) => [label, `var(--${token})`]);

  const manifestJs = `${generatedBanner}
export const SPECIMEN_COLOR_ROWS = ${JSON.stringify(colorRows, null, 2)};

export const SPECIMEN_LABEL_COLORS = ${JSON.stringify(labelColors, null, 2)};

export const SPECIMEN_SPACES = ${JSON.stringify(layout.swatches.spaces, null, 2)};

export const SPECIMEN_RADII = ${JSON.stringify(layout.swatches.radii, null, 2)};

export const SPECIMEN_SURFACE_STACK = ${JSON.stringify(layout.surfaceStack ?? [], null, 2)};
`;

  const pagesJs = `${generatedBanner}
export const SPECIMEN_PAGES = ${JSON.stringify(layout.pages, null, 2)};
`;

  const catalogJs = `${generatedBanner}
export const COMPONENT_CATALOG = ${JSON.stringify(catalog, null, 2)};
`;

  await writeFile(resolve(generatedDir, 'manifest.js'), manifestJs);
  await writeFile(resolve(generatedDir, 'pages.js'), pagesJs);
  await writeFile(resolve(generatedDir, 'catalog.js'), catalogJs);
}
