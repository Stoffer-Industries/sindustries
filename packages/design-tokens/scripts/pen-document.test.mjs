import assert from 'node:assert/strict';
import test from 'node:test';

import { isGeneratedSpecimenFrame, isSpecimenFrame, normalizeDesignSystemsDocument, stripEmptyThemes } from './pen-document.mjs';

const sampleVariables = {
  'si-color-bg-canvas': { type: 'color', value: '#111111' }
};

function buildSampleSpecimenFrames() {
  return [
    {
      type: 'frame',
      id: 'siSpecRoot',
      name: 'Design tokens specimen',
      width: 960,
      children: [{ type: 'text', content: 'Pencil token specimen' }]
    },
    {
      type: 'frame',
      id: 'siReactSpecPulse',
      name: 'Pulse React specimen',
      width: 960,
      children: [{ type: 'text', content: 'Pulse React specimen' }]
    }
  ];
}

test('isGeneratedSpecimenFrame detects token and react specimen frames', () => {
  assert.equal(isGeneratedSpecimenFrame({ type: 'frame', id: 'zq4EP' }), true);
  assert.equal(isGeneratedSpecimenFrame({ type: 'frame', id: 'siReactSpecPulse' }), true);
  assert.equal(isSpecimenFrame({ type: 'frame', id: 'siReactSpecPulse' }), true);
  assert.equal(isGeneratedSpecimenFrame({ type: 'frame', id: 'vtHps' }), false);
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

test('normalizeDesignSystemsDocument refreshes generated specimen frames in place', () => {
  const doc = {
    version: '2.13',
    children: [
      {
        type: 'frame',
        id: 'vtHps',
        children: [{ type: 'frame', id: 'button', name: 'Button' }]
      },
      {
        type: 'frame',
        id: 'siSpecRoot',
        x: -473,
        y: 22,
        name: 'Design tokens specimen',
        theme: { Mode: 'Dark' },
        children: [{ type: 'text', content: 'old' }]
      }
    ]
  };

  normalizeDesignSystemsDocument(doc, {
    pencilVariables: sampleVariables,
    buildSpecimenFrames: buildSampleSpecimenFrames
  });

  assert.equal(doc.children.length, 3);
  assert.equal(doc.children[1].id, 'siSpecRoot');
  assert.equal(doc.children[1].x, -473);
  assert.equal(doc.children[1].children[0].content, 'Pencil token specimen');

  const reactFrame = doc.children.find((child) => child.id === 'siReactSpecPulse');
  assert.ok(reactFrame);
  assert.equal(reactFrame.children[0].content, 'Pulse React specimen');
});

test('normalizeDesignSystemsDocument migrates legacy specimen slot without keeping stale frame id', () => {
  const doc = {
    version: '2.13',
    children: [
      { type: 'frame', id: 'vtHps', children: [] },
      {
        type: 'frame',
        id: 'siReactSpecPulse',
        x: 1024,
        y: 32,
        name: 'Pulse React specimen',
        children: [{ type: 'text', content: 'old react' }]
      }
    ]
  };

  normalizeDesignSystemsDocument(doc, {
    pencilVariables: sampleVariables,
    buildSpecimenFrames: buildSampleSpecimenFrames
  });

  assert.equal(doc.children.length, 3);
  assert.equal(doc.children[1].id, 'siSpecRoot');
  assert.equal(doc.children[2].id, 'siReactSpecPulse');
  assert.equal(doc.children[2].children[0].content, 'Pulse React specimen');
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
        id: 'siSpecRoot',
        name: 'Design tokens specimen',
        children: [{ type: 'text', content: 'Pencil token specimen' }]
      }
    ]
  };

  normalizeDesignSystemsDocument(doc, {
    pencilVariables: sampleVariables,
    buildSpecimenFrames: buildSampleSpecimenFrames
  });

  assert.equal('theme' in doc.children[0].children[0], false);
});
