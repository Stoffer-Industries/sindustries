/** @typedef {{ byId: Map<string, object>, byName: Map<string, object> }} PenLibraryIndex */

const PLACEMENT_KEYS = ['x', 'y', 'rotation', 'flipX', 'flipY'];

/**
 * Index reusable components inside `vtHps` by id and name.
 * @param {object[] | undefined} children
 * @returns {PenLibraryIndex}
 */
export function buildPenLibraryIndex(children) {
  const byId = new Map();
  const byName = new Map();
  for (const child of children ?? []) {
    if (!child || typeof child !== 'object') continue;
    if (child.id) byId.set(child.id, child);
    if (child.name) byName.set(child.name, child);
  }
  return { byId, byName };
}

/**
 * @param {{ id?: string, ref?: string, name?: string } | undefined} penRef
 * @param {PenLibraryIndex} index
 */
export function resolvePenRef(penRef, index) {
  if (!penRef || !index) return null;
  if (penRef.name && index.byName.has(penRef.name)) {
    return index.byName.get(penRef.name);
  }
  if (penRef.id && index.byId.has(penRef.id)) {
    return index.byId.get(penRef.id);
  }
  if (penRef.ref && index.byId.has(penRef.ref)) {
    return index.byId.get(penRef.ref);
  }
  return null;
}

function stripPlacement(node) {
  const copy = { ...node };
  for (const key of PLACEMENT_KEYS) delete copy[key];
  delete copy.reusable;
  return copy;
}

function namespaceEmbeddedIds(value, namespace, isRoot = false) {
  if (Array.isArray(value)) {
    return value.map((item) => namespaceEmbeddedIds(item, namespace));
  }
  if (!value || typeof value !== 'object') return value;

  const copy = {};
  for (const [key, childValue] of Object.entries(value)) {
    copy[key] = namespaceEmbeddedIds(childValue, namespace);
  }
  if (!isRoot && typeof copy.id === 'string') {
    copy.id = `${namespace}_${copy.id}`;
  }
  return copy;
}

/** Preserve explicit widths/heights from pen masters when embedding in specimens. */
function resolveEmbedDimension(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== 'fit_content') return value;
  return 'fit_content';
}

/**
 * Copy a vtHps node into a specimen embed (refs only, no canvas coordinates).
 * @param {object} source
 * @param {string} embedId
 */
export function clonePenEmbedNode(source, embedId) {
  if (!source || typeof source !== 'object') return null;

  if (source.type === 'ref') {
    const embed = stripPlacement(source);
    embed.id = embedId;
    embed.width = resolveEmbedDimension(embed.width);
    embed.height = resolveEmbedDimension(embed.height);
    if (source.rotation !== undefined && embed.rotation === undefined) {
      embed.rotation = source.rotation;
    }
    return namespaceEmbeddedIds(embed, embedId, true);
  }

  if (source.type === 'frame' && source.id) {
    const embed = {
      type: 'ref',
      id: embedId,
      ref: source.id,
      name: source.name,
      width: resolveEmbedDimension(source.width),
      height: resolveEmbedDimension(source.height)
    };
    if (source.rotation !== undefined) embed.rotation = source.rotation;
    return embed;
  }

  return null;
}

/**
 * @param {object[]} demos
 * @param {string} idPrefix
 * @param {PenLibraryIndex} penLibraryIndex
 */
export function buildPenEmbedRow(demos, idPrefix, penLibraryIndex) {
  const children = [];
  for (const [di, demo] of demos.entries()) {
    if (!demo.penRef) continue;
    const source = resolvePenRef(demo.penRef, penLibraryIndex);
    if (!source) {
      console.warn(`penRef not found in vtHps: ${JSON.stringify(demo.penRef)}`);
      continue;
    }
    const embed = clonePenEmbedNode(source, `${idPrefix}p${di}`);
    if (embed) children.push(embed);
  }
  if (!children.length) return null;

  return {
    type: 'frame',
    id: `${idPrefix}`,
    width: 'fill_container',
    layout: 'horizontal',
    gap: 12,
    alignItems: 'center',
    children
  };
}
