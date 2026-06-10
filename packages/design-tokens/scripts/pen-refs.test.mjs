import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPenEmbedRow,
  buildPenLibraryIndex,
  clonePenEmbedNode,
  resolvePenRef
} from './pen-refs.mjs';

const library = [
  {
    type: 'frame',
    id: 'xBc88',
    name: 'Button/Default',
    reusable: true,
    x: 290,
    y: 112
  },
  {
    type: 'ref',
    id: 'mxrlX',
    ref: 'xBc88',
    name: 'Button/Secondary',
    x: 291,
    y: 188,
    fill: '$si-color-cta-secondary',
    descendants: { FT3cO: { fill: '$si-color-text-primary' } }
  }
];

test('resolvePenRef finds masters and named instances', () => {
  const index = buildPenLibraryIndex(library);
  assert.equal(resolvePenRef({ id: 'xBc88', name: 'Button/Default' }, index)?.id, 'xBc88');
  assert.equal(resolvePenRef({ ref: 'xBc88', name: 'Button/Secondary' }, index)?.id, 'mxrlX');
});

test('clonePenEmbedNode strips placement and preserves ref overrides', () => {
  const index = buildPenLibraryIndex(library);
  const secondary = resolvePenRef({ name: 'Button/Secondary' }, index);
  const embed = clonePenEmbedNode(secondary, 'specSec1');
  assert.equal(embed.id, 'specSec1');
  assert.equal(embed.ref, 'xBc88');
  assert.equal(embed.fill, '$si-color-cta-secondary');
  assert.equal('x' in embed, false);
  assert.deepEqual(embed.descendants, { FT3cO: { fill: '$si-color-text-primary' } });
});

test('clonePenEmbedNode converts masters into refs', () => {
  const index = buildPenLibraryIndex(library);
  const master = resolvePenRef({ name: 'Button/Default' }, index);
  const embed = clonePenEmbedNode(master, 'specDef1');
  assert.deepEqual(embed, {
    type: 'ref',
    id: 'specDef1',
    ref: 'xBc88',
    name: 'Button/Default',
    width: 'fit_content',
    height: 'fit_content'
  });
});

test('clonePenEmbedNode preserves explicit dimensions from masters and refs', () => {
  const index = buildPenLibraryIndex([
    { type: 'frame', id: 'vsaL0', name: 'Dropdown', width: 220 },
    {
      type: 'ref',
      id: 'ZRLup',
      ref: '90yrf',
      name: 'Toast/Success',
      width: 640,
      height: 'fit_content'
    }
  ]);
  const dropdown = clonePenEmbedNode(resolvePenRef({ name: 'Dropdown' }, index), 'specDd');
  assert.equal(dropdown.width, 220);
  const toast = clonePenEmbedNode(resolvePenRef({ name: 'Toast/Success' }, index), 'specToast');
  assert.equal(toast.width, 640);
  assert.equal(toast.height, 'fit_content');
});

test('clonePenEmbedNode preserves rotation on frame masters', () => {
  const index = buildPenLibraryIndex([
    {
      type: 'frame',
      id: 'Q7WW3w',
      name: 'Modal/Task Card',
      rotation: 0.65
    }
  ]);
  const master = resolvePenRef({ name: 'Modal/Task Card' }, index);
  const embed = clonePenEmbedNode(master, 'specCard1');
  assert.equal(embed.ref, 'Q7WW3w');
  assert.equal(embed.rotation, 0.65);
});

test('buildPenEmbedRow emits a horizontal row of pen refs', () => {
  const index = buildPenLibraryIndex(library);
  const row = buildPenEmbedRow(
    [
      { penRef: { name: 'Button/Default' } },
      { penRef: { name: 'Button/Secondary' } }
    ],
    'siReactSpecPulseGrp0r0',
    index
  );
  assert.equal(row.layout, 'horizontal');
  assert.equal(row.children.length, 2);
  assert.equal(row.children[0].ref, 'xBc88');
  assert.equal(row.children[1].ref, 'xBc88');
});
