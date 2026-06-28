// Pagination cursor encoding/decoding helpers extracted from tasks.ts.
// The cursor format is `(createdAt iso)::(id)` base64url encoded.

export function encodeCursor(createdAt, id) {
  return Buffer.from(`${createdAt.toISOString()}::${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAtRaw, id] = decoded.split('::');
    const createdAt = new Date(createdAtRaw);

    if (!id || Number.isNaN(createdAt.valueOf())) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}
