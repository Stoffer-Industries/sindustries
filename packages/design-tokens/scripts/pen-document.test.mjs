import assert from 'node:assert/strict';
import test from 'node:test';

import { isSpecimenFrame, normalizeDesignSystemsDocument, stripEmptyThemes } from './pen-document.mjs';

const sampleVariables = {
  'si-color-bg-canvas': { type: 'color', value: '#111111' }
};

function buildSampleSpecimen() {
  return [
    {
      type: 'frame',
      id: 'siSpecRoot',
      name: 'Design tokens specimen',
      width: 960,
      children: [
        {
          type: 'text',
          content: 'Pencil token specimen'
        }
      ]
    }
  ];
}

test('isSpecimenFrame detects top-level specimen by id and title text', () => {
  assert.equal(isSpecimenFrame({ type: 'frame', id: 'zq4EP' }), true);
  assert.equal(
    isSpecimenFrame({
      type: 'frame',
      children: [{ type: 'text', content: 'Pencil token specimen' }]
    }),
    true
  );
  assert.equal(isSpecimenFrame({ type: 'frame', id: 'vtHps' }), false);
});

test('stripEmptyThemes removes empty theme objects without assigning Mode', () => {
  const node = {
    type: 'ref',
    theme: {},
    descendants: {
      child: { theme: {} }
    }
  };

  stripEmptyThemes(node);

  assert.equal('theme' in node, false);
  assert.equal('theme' in node.descendants.child, false);
});

test('normalizeDesignSystemsDocument refreshes the existing top-level specimen in place', () => {
  const doc = {
    version: '2.13',
    children: [
      {
        type: 'frame',
        id: 'vtHps',
        children: [
          { type: 'frame', id: 'siSpecRoot', name: 'Design tokens specimen', children: [] },
          { type: 'frame', id: 'button', name: 'Button' }
        ]
      },
      {
        type: 'frame',
        id: 'zq4EP',
        x: -473,
        y: 22,
        name: 'Design tokens specimen',
        theme: { Mode: 'Dark' },
        children: [{ type: 'text', content: 'Pencil token specimen' }]
      }
    ]
  };

  normalizeDesignSystemsDocument(doc, {
    pencilVariables: sampleVariables,
    buildSpecimen: buildSampleSpecimen
  });

  assert.equal(doc.children.length, 2);
  assert.equal(doc.children[1].id, 'zq4EP');
  assert.equal(doc.children[1].x, -473);
  assert.equal(doc.children[1].theme.Mode, 'Dark');
  assert.equal(doc.children[1].children[0].content, 'Pencil token specimen');

  const nestedSpecimens = doc.children[0].children.filter(isSpecimenFrame);
  assert.equal(nestedSpecimens.length, 0);
});

test('normalizeDesignSystemsDocument does not inject themes into components with empty theme', () => {
  const doc = {
    version: '2.13',
    children: [
      {
        type: 'frame',
        id: 'vtHps',
        children: [{ type: 'ref', id: 'abc12', theme: {}, name: 'Button/Primary' }]
      },
      {
        type: 'frame',
        id: 'zq4EP',
        name: 'Design tokens specimen',
        children: [{ type: 'text', content: 'Pencil token specimen' }]
      }
    ]
  };

  normalizeDesignSystemsDocument(doc, {
    pencilVariables: sampleVariables,
    buildSpecimen: buildSampleSpecimen
  });

  assert.equal('theme' in doc.children[0].children[0], false);
});
