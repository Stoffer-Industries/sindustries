export function isGeneratedSpecimenFrame(node) {
  if (!node || node.type !== 'frame') return false;
  if (node.id === 'siSpecRoot' || node.id === 'siReactSpecPulse' || node.id === 'zq4EP') return true;
  if (node.id?.startsWith('siReactSpec')) return true;
  if (node.name === 'Design tokens specimen') return true;
  return hasTextContent(node, 'Pencil token specimen') || hasTextContent(node, 'Pulse React specimen');
}

/** @deprecated use isGeneratedSpecimenFrame */
export function isSpecimenFrame(node) {
  return isGeneratedSpecimenFrame(node);
}

export function hasTextContent(node, content) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'text' && node.content === content) return true;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((child) => hasTextContent(child, content))) return true;
    } else if (value && typeof value === 'object' && hasTextContent(value, content)) {
      return true;
    }
  }
  return false;
}

const PEN_SURFACE_TOKEN_PLACEHOLDER = '__SI_SURFACE_TOKEN__';

function migratePenColorTokens(s) {
  return s
    .split('$si-color-bg-canvas-alt').join('$si-color-bg-section-header')
    .split('$si-color-bg-surface-contrast').join(PEN_SURFACE_TOKEN_PLACEHOLDER)
    .split('$si-color-bg-surface').join('$si-color-bg-section')
    .split(PEN_SURFACE_TOKEN_PLACEHOLDER).join('$si-color-bg-surface')
    .split('$si-surface-page').join('$si-color-bg-canvas')
    .split('$si-surface-section').join('$si-color-bg-section')
    .split('$si-surface-group').join('$si-color-bg-surface')
    .split('--si-surface-page').join('--si-color-bg-canvas')
    .split('--si-surface-section').join('--si-color-bg-section')
    .split('--si-surface-group').join('--si-color-bg-surface');
}

function normalizeString(s) {
  if (typeof s !== 'string') return s;
  return migratePenColorTokens(s.split('$si:si-').join('$si-'));
}

function normalizeThemeObject(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return;
  if (Object.prototype.hasOwnProperty.call(theme, 'si:Mode')) {
    theme.Mode = theme['si:Mode'];
    delete theme['si:Mode'];
  }
}

/** Remove empty theme objects instead of assigning a default Mode. */
export function stripEmptyThemes(node) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const item of node) stripEmptyThemes(item);
    return;
  }
  if (typeof node !== 'object') return;

  if (
    node.theme &&
    typeof node.theme === 'object' &&
    !Array.isArray(node.theme) &&
    Object.keys(node.theme).length === 0
  ) {
    delete node.theme;
  }

  for (const key of Object.keys(node)) {
    if (key === 'theme') continue;
    stripEmptyThemes(node[key]);
  }
}

function walkNormalizeStrings(node) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      if (typeof el === 'string') node[i] = normalizeString(el);
      else walkNormalizeStrings(el);
    }
    return;
  }
  if (typeof node !== 'object') return;

  if (node.theme && typeof node.theme === 'object') normalizeThemeObject(node.theme);

  for (const key of Object.keys(node)) {
    if (key === 'theme') continue;
    const value = node[key];
    if (typeof value === 'string') node[key] = normalizeString(value);
    else walkNormalizeStrings(value);
  }
}

function preserveSpecimenLayout(existing, generated) {
  const merged = { ...generated };
  merged.id = generated.id ?? existing.id;
  if (existing.x !== undefined) merged.x = existing.x;
  if (existing.y !== undefined) merged.y = existing.y;
  if (existing.width !== undefined) merged.width = existing.width;
  if (existing.height !== undefined) merged.height = existing.height;
  if (existing.name !== undefined && generated.name === undefined) merged.name = existing.name;
  if (
    existing.theme &&
    typeof existing.theme === 'object' &&
    !Array.isArray(existing.theme) &&
    Object.keys(existing.theme).length > 0
  ) {
    merged.theme = existing.theme;
  }
  return merged;
}

function findFrameIndexById(children, frameId) {
  if (!Array.isArray(children)) return -1;
  return children.findIndex((child) => child?.id === frameId);
}

function removeGeneratedSpecimenFrames(children) {
  if (!Array.isArray(children)) return children;
  return children.filter((child) => !isGeneratedSpecimenFrame(child));
}

/**
 * Merge token variables/themes into design-systems.pen and refresh generated
 * specimen frames in place (tokens + React pack specimens).
 */
export function normalizeDesignSystemsDocument(doc, { pencilVariables, buildSpecimenFrames }) {
  delete doc.imports;

  doc.themes = {
    Mode: ['Light', 'Dark']
  };
  doc.variables = JSON.parse(JSON.stringify(pencilVariables));

  walkNormalizeStrings(doc);
  stripEmptyThemes(doc);

  const generatedFrames = buildSpecimenFrames();
  const generatedIds = new Set(generatedFrames.map((frame) => frame.id));

  if (!Array.isArray(doc.children)) {
    doc.children = [];
  }

  for (const generated of generatedFrames) {
    const topLevelIndex = findFrameIndexById(doc.children, generated.id);
    if (topLevelIndex >= 0) {
      doc.children[topLevelIndex] = preserveSpecimenLayout(doc.children[topLevelIndex], generated);
      continue;
    }

    const legacyIndex = generated.id === 'siSpecRoot'
      ? doc.children.findIndex(isGeneratedSpecimenFrame)
      : -1;
    if (legacyIndex >= 0 && doc.children[legacyIndex]?.id !== generated.id) {
      doc.children[legacyIndex] = preserveSpecimenLayout(doc.children[legacyIndex], generated);
      continue;
    }

    doc.children.push(generated);
  }

  doc.children = doc.children.filter((child) => {
    if (!isGeneratedSpecimenFrame(child)) return true;
    return generatedIds.has(child.id);
  });

  const componentsFrame = doc.children.find((child) => child?.id === 'vtHps');
  if (componentsFrame?.children) {
    componentsFrame.children = removeGeneratedSpecimenFrames(componentsFrame.children);
  }

  const componentsRoot = doc.children.find((child) => child?.id === 'vtHps');
  if (componentsRoot?.type === 'frame') {
    componentsRoot.theme = { Mode: 'Light' };
  }
}
