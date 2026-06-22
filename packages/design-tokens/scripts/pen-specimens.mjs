import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPenEmbedRow, buildPenLibraryIndex } from './pen-refs.mjs';

const designTokensRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = resolve(designTokensRoot, '../ui');

export async function loadSpecimenLayout() {
  const raw = await readFile(resolve(designTokensRoot, 'specimen-layout.json'), 'utf8');
  return JSON.parse(raw);
}

export async function loadComponentCatalog() {
  const raw = await readFile(resolve(uiRoot, 'component-catalog.json'), 'utf8');
  return JSON.parse(raw);
}

export const GENERATED_SPECIMEN_FRAME_IDS = ['siSpecRoot', 'siReactSpecPulse', 'zq4EP'];

const strokeSubtle = {
  stroke: '$si-color-border-subtle',
  strokeWidth: 1,
  strokeAlignment: 'inner'
};

function sectionPanel(id, title, children) {
  return {
    type: 'frame',
    id,
    width: 'fill_container',
    fill: penColorVar('bgSection'),
    cornerRadius: '$si-radius-lg',
    ...strokeSubtle,
    layout: 'vertical',
    gap: 14,
    padding: 18,
    children: [
      {
        type: 'text',
        id: `${id}Title`,
        fill: '$si-color-text-primary',
        content: title,
        fontFamily: 'Inter',
        fontSize: 20,
        fontWeight: '800',
        textGrowth: 'auto'
      },
      ...children
    ]
  };
}

function buildSwatchCards(swatches, idPrefix = 'siSws') {
  return swatches.map(([label, key], i) => ({
    type: 'frame',
    id: `${idPrefix}${i}`,
    width: 104,
    height: 86,
    fill: penColorVar('bgSurface'),
    cornerRadius: '$si-radius-md',
    ...strokeSubtle,
    layout: 'vertical',
    gap: 6,
    padding: 8,
    children: [
      {
        type: 'rectangle',
        id: `${idPrefix}${i}q`,
        width: 'fill_container',
        height: 28,
        cornerRadius: '$si-radius-sm',
        fill: `$${key}`
      },
      {
        type: 'text',
        id: `${idPrefix}${i}t`,
        fill: '$si-color-text-primary',
        content: label,
        fontFamily: 'Inter',
        fontSize: 11,
        fontWeight: '800',
        textGrowth: 'auto'
      }
    ]
  }));
}

const strokeInk = {
  stroke: '$si-color-ink-950',
  strokeWidth: 2,
  strokeAlignment: 'inner'
};

const modeKeyKebab = (modeKey) => modeKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const penColorVar = (modeKey) => `$si-color-${modeKeyKebab(modeKey)}`;
const cssColorRef = (modeKey) => `--si-color-${modeKeyKebab(modeKey)}`;

function surfaceMetaText(id, label, description, modeKey) {
  return {
    type: 'text',
    id,
    fill: '$si-color-brand-500',
    content: `${label.toUpperCase()} · ${description} · ${cssColorRef(modeKey)}`,
    fontFamily: 'Inter',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    textAlign: 'right',
    textGrowth: 'auto'
  };
}

function surfaceHeaderRow(id, titleNode, metaNode) {
  return {
    type: 'frame',
    id,
    width: 'fill_container',
    layout: 'horizontal',
    alignItems: 'center',
    gap: 12,
    justifyContent: 'space_between',
    children: [titleNode, metaNode]
  };
}

function buildSurfaceStackDemo(resolved, layout, idPrefix) {
  const fonts = resolved.semantic.font;
  const stack = layout.surfaceStack ?? [];
  const page = stack.find((entry) => entry.token === 'bgCanvas');
  const sectionRole = stack.find((entry) => entry.token === 'bgSection');
  const group = stack.find((entry) => entry.token === 'bgSurface');
  const fields = stack.find((entry) => entry.token === 'bgField');

  const fieldsFrame = {
    type: 'frame',
    id: `${idPrefix}SurfFields`,
    width: 'fill_container',
    height: 40,
    fill: penColorVar('bgField'),
    cornerRadius: '$si-radius-sm',
    ...strokeSubtle
  };

  const groupFrame = {
    type: 'frame',
    id: `${idPrefix}SurfGroup`,
    width: 'fill_container',
    fill: penColorVar('bgSurface'),
    cornerRadius: 0,
    ...strokeInk,
    layout: 'vertical',
    gap: 10,
    padding: 14,
    children: [
      surfaceHeaderRow(
        `${idPrefix}SurfGroupHdr`,
        {
          type: 'text',
          id: `${idPrefix}SurfGroupTitle`,
          fill: '$si-color-text-primary',
          content: group?.headerSample ?? 'Section Header',
          fontFamily: fonts.display,
          fontSize: 14,
          fontWeight: '700',
          textGrowth: 'fixed-width',
          width: 320,
          lineHeight: 1.35
        },
        surfaceMetaText(
          `${idPrefix}SurfGroupMeta`,
          group?.label ?? 'Group',
          group?.description ?? 'Task card',
          'bgSurface'
        )
      ),
      surfaceHeaderRow(
        `${idPrefix}SurfFieldsHdr`,
        fieldsFrame,
        surfaceMetaText(
          `${idPrefix}SurfFieldsMeta`,
          fields?.label ?? 'Fields',
          fields?.description ?? 'Task fields',
          fields?.token ?? 'bgField'
        )
      )
    ]
  };

  const sectionFrame = {
    type: 'frame',
    id: `${idPrefix}SurfSection`,
    width: 'fill_container',
    fill: penColorVar('bgSection'),
    cornerRadius: 0,
    ...strokeInk,
    layout: 'vertical',
    clip: true,
    children: [
      {
        type: 'frame',
        id: `${idPrefix}SurfSecHdr`,
        width: 'fill_container',
        fill: '$si-color-bg-section-header',
        padding: 12,
        children: [
          surfaceHeaderRow(
            `${idPrefix}SurfSecHdrRow`,
            {
              type: 'text',
              id: `${idPrefix}SurfSecTitle`,
              fill: '$si-color-text-primary',
              content: (sectionRole?.headerSample ?? 'Surface Section Header').toUpperCase(),
              fontFamily: fonts.display,
              fontSize: 13,
              fontWeight: '700',
              letterSpacing: 0.6,
              textGrowth: 'auto'
            },
            surfaceMetaText(
              `${idPrefix}SurfSecMeta`,
              sectionRole?.label ?? 'Section',
              sectionRole?.description ?? 'Kanban column',
              'bgSection'
            )
          )
        ]
      },
      {
        type: 'frame',
        id: `${idPrefix}SurfSecBody`,
        width: 'fill_container',
        fill: penColorVar('bgSection'),
        layout: 'vertical',
        gap: 10,
        padding: 12,
        children: [groupFrame]
      }
    ]
  };

  return {
    type: 'frame',
    id: `${idPrefix}SurfPage`,
    width: 'fill_container',
    layout: 'vertical',
    gap: 14,
    children: [
      surfaceHeaderRow(
        `${idPrefix}SurfPageHdr`,
        {
          type: 'text',
          id: `${idPrefix}SurfPageTitle`,
          fill: '$si-color-text-primary',
          content: page?.headerSample ?? 'Surfaces',
          fontFamily: fonts.display,
          fontSize: 28,
          fontWeight: 'normal',
          textGrowth: 'auto'
        },
        surfaceMetaText(
          `${idPrefix}SurfPageMeta`,
          page?.label ?? 'Page',
          page?.description ?? 'Canvas',
          'bgCanvas'
        )
      ),
      sectionFrame
    ]
  };
}

function buildReactSurfaceStackBlock(resolved, layout, section, page) {
  return buildSurfaceStackDemo(resolved, layout, page.penFrameId);
}

function buildTokenSections(resolved, layout) {
  const fonts = resolved.semantic.font;
  const sp = resolved.core.space;
  const rad = resolved.core.radius;
  const { swatches: swatchConfig } = layout;

  const swatchRowsSource = swatchConfig.colorRows;
  const swatches = swatchRowsSource.flat();
  const swatchCards = buildSwatchCards(swatches);

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

  const labelCards = buildSwatchCards(swatchConfig.labelColors, 'siLbl');

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
    .filter(([k]) => swatchConfig.spaces.includes(k))
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

  const radiusTiles = Object.entries(rad)
    .filter(([k]) => swatchConfig.radii.includes(k))
    .map(([k, r]) => ({
      type: 'frame',
      id: `siRdk${k}`,
      width: 76,
      height: 76,
      fill: penColorVar('bgSurface'),
      cornerRadius: Number(r),
      ...strokeSubtle,
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

  return {
    color: sectionPanel('siSpecColorSec', 'Color', swatchRows),
    colorLabels: sectionPanel('siSpecLabelSec', 'Color labels', [labelRow]),
    typography: sectionPanel('siSpecTypeSec', 'Typography', [
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
    ]),
    space: sectionPanel('siSpecSpaceSec', 'Space', [
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
    ]),
    radius: sectionPanel('siSpecRadSec', 'Radius', [
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
    ])
  };
}

function groupCatalogComponents(group) {
  if (group.catalogComponents?.length) return group.catalogComponents;
  if (group.catalogComponent) return [group.catalogComponent];
  return [];
}

function inlineCatalogComponents(catalog, pack) {
  return new Set(
    catalog.specimenGroups
      .filter((group) => group.pack === pack)
      .flatMap((group) => groupCatalogComponents(group))
  );
}

function catalogRowDataForComponent(name, catalog, pack) {
  const entry = catalog.components[name];
  if (!entry?.packs?.[pack]) return null;
  const packEntry = entry.packs[pack];
  const variantText = [
    ...(packEntry.variants ?? []),
    ...(packEntry.tones?.map((t) => `tone:${t}`) ?? []),
    ...(packEntry.states?.map((s) => `state:${s}`) ?? [])
  ].join(', ') || '—';
  const penText = packEntry.penNames?.length ? packEntry.penNames.join(', ') : '—';
  return {
    name,
    cssPrefix: entry.cssPrefix,
    penComponentId: entry.penComponentId,
    status: packEntry.status,
    variantText,
    penText
  };
}

function catalogRowsForPack(catalog, pack, { exclude = new Set() } = {}) {
  return Object.entries(catalog.components)
    .filter(([name, entry]) => entry.packs?.[pack] && !exclude.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => catalogRowDataForComponent(name, catalog, pack));
}

function buildCatalogRowChildren(row, rowId, catalogMeta, { compact = false } = {}) {
  const statusColor =
    row.status === 'implemented'
      ? '$si-color-status-success'
      : row.status === 'partial'
        ? '$si-color-label-orange'
        : '$si-color-text-muted';

  const textWidth = compact ? 280 : 880;
  const penId = (entry) => `${rowId}${entry}`;

  return [
      {
        type: 'frame',
        id: penId('h'),
        width: 'fill_container',
        layout: 'horizontal',
        gap: 8,
        alignItems: 'center',
        children: [
          {
            type: 'text',
            id: penId('n'),
            fill: '$si-color-text-primary',
            content: row.name,
            fontFamily: 'Inter',
            fontSize: 13,
            fontWeight: '800',
            textGrowth: 'auto'
          },
          {
            type: 'text',
            id: penId('s'),
            fill: statusColor,
            content: row.status.toUpperCase(),
            fontFamily: 'Inter',
            fontSize: 10,
            fontWeight: '800',
            textGrowth: 'auto'
          }
        ]
      },
      {
        type: 'text',
        id: penId('p'),
        fill: '$si-color-text-muted',
        content: `.${row.cssPrefix}  ·  ${catalogMeta.exportPath}${row.penComponentId ? `  ·  pen:${row.penComponentId}` : ''}`,
        fontFamily: 'Inter',
        fontSize: 11,
        fontWeight: '600',
        textGrowth: 'fixed-width',
        width: textWidth
      },
      {
        type: 'text',
        id: penId('v'),
        fill: '$si-color-text-secondary',
        content: `variants: ${row.variantText}`,
        fontFamily: 'Inter',
        fontSize: 10,
        fontWeight: 'normal',
        textGrowth: 'fixed-width',
        width: textWidth
      },
      {
        type: 'text',
        id: penId('f'),
        fill: '$si-color-text-secondary',
        content: catalogMeta.sourcePath,
        fontFamily: 'Inter',
        fontSize: 10,
        fontWeight: 'normal',
        textGrowth: 'fixed-width',
        width: textWidth
      },
      {
        type: 'text',
        id: penId('pen'),
        fill: '$si-color-text-tertiary',
        content: `pen: ${row.penText}`,
        fontFamily: 'Inter',
        fontSize: 10,
        fontWeight: 'normal',
        textGrowth: 'fixed-width',
        width: textWidth
      }
  ];
}

function buildCatalogRow(row, rowId, catalogMeta, { compact = false } = {}) {
  return {
    type: 'frame',
    id: rowId,
    width: compact ? 300 : 'fill_container',
    layout: 'vertical',
    gap: 4,
    padding: compact ? 0 : [8, 0],
    children: buildCatalogRowChildren(row, rowId, catalogMeta, { compact })
  };
}

function buildGroupNoteText(group) {
  if (group.kind) return `kind: ${group.kind} · live demo on /design-system`;
  return group.note ?? 'See /design-system for live demos.';
}

function buildInlineCatalogPanel(group, index, page, catalog) {
  const names = groupCatalogComponents(group);
  if (!names.length) return null;

  const catalogChildren = [];
  for (const [ri, name] of names.entries()) {
    const row = catalogRowDataForComponent(name, catalog, page.pack);
    if (!row) continue;
    if (catalogChildren.length) {
      catalogChildren.push({
        type: 'frame',
        id: `${page.penFrameId}Grp${index}catSep${ri}`,
        width: 'fill_container',
        height: 1,
        fill: '$si-color-border-subtle'
      });
    }
    catalogChildren.push(...buildCatalogRowChildren(row, `${page.penFrameId}Grp${index}cat${ri}`, catalog));
  }
  if (!catalogChildren.length) return null;

  return {
    type: 'frame',
    id: `${page.penFrameId}Grp${index}cat`,
    width: 'fill_container',
    fill: penColorVar('bgField'),
    cornerRadius: '$si-radius-md',
    layout: 'vertical',
    gap: 8,
    padding: 12,
    children: [
      {
        type: 'text',
        id: `${page.penFrameId}Grp${index}catLbl`,
        fill: '$si-color-brand-500',
        content: 'CODE',
        fontFamily: 'Inter',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 1.2,
        textGrowth: 'auto'
      },
      ...catalogChildren
    ]
  };
}

function buildComponentGroupCard(group, index, page, penLibraryIndex, catalog) {
  const demoChildren = [];
  const hasPenRows = group.rows?.some((row) => row.demos?.some((demo) => demo.penRef));
  if (hasPenRows) {
    for (const [ri, row] of group.rows.entries()) {
      const penRow = buildPenEmbedRow(row.demos, `${page.penFrameId}Grp${index}r${ri}`, penLibraryIndex);
      if (penRow) demoChildren.push(penRow);
    }
  }
  if (group.penEmbeds?.length) {
    const penRow = buildPenEmbedRow(
      group.penEmbeds.map((penRef) => ({ penRef })),
      `${page.penFrameId}Grp${index}pen`,
      penLibraryIndex
    );
    if (penRow) demoChildren.unshift(penRow);
  }

  demoChildren.push({
    type: 'text',
    id: `${page.penFrameId}Grp${index}n`,
    fill: '$si-color-text-muted',
    content: buildGroupNoteText(group),
    fontFamily: 'Inter',
    fontSize: 11,
    fontWeight: 'normal',
    textGrowth: 'fixed-width',
    width: 840
  });

  const bodyChildren = [
    {
      type: 'frame',
      id: `${page.penFrameId}Grp${index}demo`,
      width: 'fill_container',
      layout: 'vertical',
      gap: 8,
      children: demoChildren
    }
  ];

  const catalogPanel = groupCatalogComponents(group).length ? buildInlineCatalogPanel(group, index, page, catalog) : null;
  if (catalogPanel) bodyChildren.push(catalogPanel);

  return {
    type: 'frame',
    id: `${page.penFrameId}Grp${index}`,
    width: 'fill_container',
    fill: penColorVar('bgSurface'),
    cornerRadius: '$si-radius-md',
    ...strokeSubtle,
    layout: 'vertical',
    gap: 8,
    padding: 14,
    children: [
      {
        type: 'text',
        id: `${page.penFrameId}Grp${index}t`,
        fill: '$si-color-text-primary',
        content: group.title,
        fontFamily: 'Inter',
        fontSize: 14,
        fontWeight: '800',
        textGrowth: 'auto'
      },
      {
        type: 'frame',
        id: `${page.penFrameId}Grp${index}body`,
        width: 'fill_container',
        layout: 'vertical',
        gap: 12,
        children: bodyChildren
      }
    ]
  };
}

function buildPageFrame(page, sectionNodes, catalog, penLibraryIndex, resolved, layout) {
  const header = {
    type: 'frame',
    id: `${page.penFrameId}Hdr`,
    width: 'fill_container',
    fill: penColorVar('bgSection'),
    cornerRadius: '$si-radius-lg',
    ...strokeSubtle,
    layout: 'vertical',
    gap: 10,
    padding: 22,
    children: [
      {
        type: 'text',
        id: `${page.penFrameId}Eyebrow`,
        fill: '$si-color-brand-500',
        content: page.eyebrow,
        fontFamily: 'Inter',
        fontSize: 12,
        fontWeight: '800',
        letterSpacing: 1.4,
        textGrowth: 'auto'
      },
      {
        type: 'text',
        id: `${page.penFrameId}Title`,
        fill: '$si-color-text-primary',
        content: page.penTitle,
        fontFamily: 'Inter',
        fontSize: 32,
        fontWeight: '800',
        textGrowth: 'auto'
      },
      {
        type: 'text',
        id: `${page.penFrameId}Desc`,
        fill: '$si-color-text-secondary',
        textGrowth: 'fixed-width',
        width: 860,
        lineHeight: 1.3,
        fontFamily: 'Work Sans',
        fontSize: 15,
        fontWeight: 'normal',
        content: page.intro
      }
    ]
  };

  const componentGroupCards = [];

  const inlineCatalog = page.pack && catalog ? inlineCatalogComponents(catalog, page.pack) : new Set();

  if (page.pack && catalog) {
    for (const [i, group] of catalog.specimenGroups.filter((g) => g.pack === page.pack).entries()) {
      componentGroupCards.push(buildComponentGroupCard(group, i, page, penLibraryIndex, catalog));
    }
  }

  const remainingCatalogRows = page.pack && catalog
    ? catalogRowsForPack(catalog, page.pack, { exclude: inlineCatalog })
    : [];
  const catalogSection =
    remainingCatalogRows.length > 0
      ? sectionPanel(
          `${page.penFrameId}Catalog`,
          'Code catalog',
          remainingCatalogRows.map((row, i) => buildCatalogRow(row, `siCatRow${i}`, catalog))
        )
      : null;

  const children = [header];
  for (const section of page.sections) {
    if (section.type === 'surfaceStack') {
      children.push(buildReactSurfaceStackBlock(resolved, layout, section, page));
    } else if (section.type === 'componentGroups') {
      if (componentGroupCards.length) {
        children.push(sectionPanel(`${page.penFrameId}Components`, section.title, componentGroupCards));
      }
    } else if (section.type === 'codeCatalog') {
      if (catalogSection) children.push(catalogSection);
    } else if (sectionNodes[section.id]) {
      children.push(sectionNodes[section.id]);
    }
  }

  const sectionCount = children.length;
  const penRowBonus =
    page.pack && catalog
      ? catalog.specimenGroups
          .filter((g) => g.pack === page.pack)
          .reduce((sum, group) => sum + (group.rows?.length ?? 0), 0) * 48
      : 0;
  const surfaceStackBonus = page.sections.some((section) => section.type === 'surfaceStack') ? 380 : 0;
  const height = page.pack
    ? 320 + sectionCount * 220 + penRowBonus + surfaceStackBonus
    : 320 + sectionCount * 180;

  return {
    type: 'frame',
    id: page.penFrameId,
    name: page.penFrameId === 'siSpecRoot' ? 'Design tokens specimen' : page.penTitle,
    theme: { Mode: 'Dark' },
    x: page.layout.x,
    y: page.layout.y,
    width: page.layout.width,
    height,
    fill: penColorVar('bgCanvas'),
    cornerRadius: '$si-radius-xl',
    layout: 'vertical',
    gap: 18,
    padding: 24,
    children
  };
}

export function buildPenSpecimenFrames({ resolved, layout, catalog, penLibraryChildren = [] }) {
  const tokenSections = buildTokenSections(resolved, layout);
  const penLibraryIndex = buildPenLibraryIndex(penLibraryChildren);
  return layout.pages.map((page) => {
    if (page.id === 'tokens') {
      return buildPageFrame(page, tokenSections, null, penLibraryIndex, resolved, layout);
    }
    return buildPageFrame(page, {}, catalog, penLibraryIndex, resolved, layout);
  });
}
