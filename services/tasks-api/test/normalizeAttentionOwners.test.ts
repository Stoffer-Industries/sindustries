import { describe, expect, it } from 'vitest';
import { normalizeAttentionOwners } from '../src/routes/tasks/_validation.ts';

/**
 * AC1 — case-insensitive duplicate normalization.
 *
 * Contract (per the task `91864257` tech design):
 *   - First occurrence wins; later case-equivalent entries are dropped
 *     while preserving the position of the kept entry.
 *   - `collapsed` exposes the dropped names so the caller can emit one
 *     audit comment per dropped entry.
 *   - The full-replacement PATCH contract is preserved (no 400 on
 *     duplicates; the response carries the canonical set).
 */
describe('normalizeAttentionOwners', () => {
  it('returns null when the body is not an array', () => {
    expect(normalizeAttentionOwners(null)).toBeNull();
    expect(normalizeAttentionOwners('Quinn')).toBeNull();
    expect(normalizeAttentionOwners({ owner: 'Quinn' })).toBeNull();
  });

  it('returns null when any entry is not a string', () => {
    expect(normalizeAttentionOwners(['Quinn', 1, 'Rowan'])).toBeNull();
    expect(normalizeAttentionOwners(['Quinn', null])).toBeNull();
    expect(normalizeAttentionOwners([undefined, 'Rowan'])).toBeNull();
  });

  it('returns null when an entry is empty or whitespace', () => {
    expect(normalizeAttentionOwners(['Quinn', ''])).toBeNull();
    expect(normalizeAttentionOwners(['Quinn', '   '])).toBeNull();
  });

  it('returns null when an entry exceeds the length cap', () => {
    expect(normalizeAttentionOwners(['x'.repeat(65)])).toBeNull();
  });

  it('returns null when the array exceeds the size cap', () => {
    const names = Array.from({ length: 17 }, (_, i) => `Person-${i}`);
    expect(normalizeAttentionOwners(names)).toBeNull();
  });

  it('trims whitespace on every entry', () => {
    const out = normalizeAttentionOwners(['  Quinn  ', 'Rowan', '\tTom\t']);
    expect(out).not.toBeNull();
    expect(out!.owners).toEqual(['Quinn', 'Rowan', 'Tom']);
    expect(out!.collapsed).toEqual([]);
  });

  it('preserves the first occurrence position when later entries are case-equivalent', () => {
    const out = normalizeAttentionOwners(['Quinn', 'quinn', 'Rowan']);
    expect(out).not.toBeNull();
    expect(out!.owners).toEqual(['Quinn', 'Rowan']);
    expect(out!.collapsed).toEqual(['quinn']);
  });

  it('collapses duplicates regardless of case order', () => {
    expect(normalizeAttentionOwners(['quinn', 'Quinn', 'QUINN'])!.owners).toEqual(['quinn']);
    expect(normalizeAttentionOwners(['quinn', 'Quinn', 'QUINN'])!.collapsed).toEqual(['Quinn', 'QUINN']);
  });

  it('preserves the first occurrence position across multiple duplicates', () => {
    const out = normalizeAttentionOwners(['Tom', 'Quinn', 'TOM', 'Rowan', 'tom']);
    expect(out!.owners).toEqual(['Tom', 'Quinn', 'Rowan']);
    expect(out!.collapsed).toEqual(['TOM', 'tom']);
  });

  it('keeps repeats within the size cap (16) and dedupes only the tail', () => {
    const names = Array.from({ length: 8 }, (_, i) => `Person-${i}`);
    names.push('Person-3', 'Person-5');
    const out = normalizeAttentionOwners(names)!;
    expect(out.owners).toHaveLength(8);
    expect(out.collapsed).toEqual(['Person-3', 'Person-5']);
  });

  it('returns collapsed=[] for an array with no duplicates', () => {
    const out = normalizeAttentionOwners(['Quinn', 'Rowan', 'Tom']);
    expect(out!.owners).toEqual(['Quinn', 'Rowan', 'Tom']);
    expect(out!.collapsed).toEqual([]);
  });

  it('treats names that differ only in trim/case as duplicates', () => {
    const out = normalizeAttentionOwners(['  Quinn  ', 'quinn']);
    expect(out!.owners).toEqual(['Quinn']);
    expect(out!.collapsed).toEqual(['quinn']);
  });
});