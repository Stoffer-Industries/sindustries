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

export function isSpecimenFrame(node) {
  if (!node || node.type !== 'frame') return false;
  if (node.id === 'siSpecRoot' || node.id === 'zq4EP') return true;
  if (node.name === 'Design tokens specimen') return true;
  return hasTextContent(node, 'Pencil token specimen');
}

function normalizeString(s) {
  if (typeof s !== 'string') return s;
  return s.split('$si:si-').join('$si-');
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
  merged.id = existing.id ?? generated.id;
  if (existing.x !== undefined) merged.x = existing.x;
  if (existing.y !== undefined) merged.y = existing.y;
  if (existing.width !== undefined) merged.width = existing.width;
  if (existing.height !== undefined) merged.height = existing.height;
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

function findSpecimenIndex(children) {
  if (!Array.isArray(children)) return -1;
  return children.findIndex(isSpecimenFrame);
}

function removeSpecimenFrames(children) {
  if (!Array.isArray(children)) return children;
  return children.filter((child) => !isSpecimenFrame(child));
}

/**
 * Merge token variables/themes into design-systems.pen and refresh the token
 * specimen in place. The specimen lives as a top-level sibling frame (id zq4EP),
 * not inside the components artboard (vtHps).
 */
export function normalizeDesignSystemsDocument(doc, { pencilVariables, buildSpecimen }) {
  delete doc.imports;

  doc.themes = {
    Mode: ['Light', 'Dark']
  };
  doc.variables = JSON.parse(JSON.stringify(pencilVariables));

  walkNormalizeStrings(doc);
  stripEmptyThemes(doc);

  const generated = buildSpecimen()[0];
  const topLevelIndex = findSpecimenIndex(doc.children);

  if (topLevelIndex >= 0) {
    doc.children[topLevelIndex] = preserveSpecimenLayout(doc.children[topLevelIndex], generated);
  } else {
    const componentsFrame = doc.children?.find((child) => child?.id === 'vtHps');
    const nestedIndex = findSpecimenIndex(componentsFrame?.children);
    if (nestedIndex >= 0) {
      componentsFrame.children[nestedIndex] = preserveSpecimenLayout(
        componentsFrame.children[nestedIndex],
        generated
      );
    } else if (Array.isArray(doc.children)) {
      doc.children.push(generated);
    }
  }

  // Drop stray generated copies that were previously pushed into vtHps.
  const componentsFrame = doc.children?.find((child) => child?.id === 'vtHps');
  if (componentsFrame?.children) {
    componentsFrame.children = removeSpecimenFrames(componentsFrame.children);
  }

  // Keep a single top-level specimen if duplicates exist.
  if (Array.isArray(doc.children)) {
    let kept = false;
    doc.children = doc.children.filter((child) => {
      if (!isSpecimenFrame(child)) return true;
      if (kept) return false;
      kept = true;
      return true;
    });
  }

  const componentsRoot = doc.children?.find((child) => child?.id === 'vtHps');
  if (componentsRoot?.type === 'frame') {
    componentsRoot.theme = { Mode: 'Light' };
  }
}
