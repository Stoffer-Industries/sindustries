export const SUPPORTED_SCOPES = [
  'workouts:write',
  'history:read',
  'progression:read'
];

export const DEFAULT_SCOPE = SUPPORTED_SCOPES.join(' ');

export function normalizeScope(scope = DEFAULT_SCOPE) {
  const parts = String(scope)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const unique = [...new Set(parts)];
  if (unique.length === 0) return { scope: DEFAULT_SCOPE, scopes: [...SUPPORTED_SCOPES] };

  const invalid = unique.filter((value) => !SUPPORTED_SCOPES.includes(value));
  if (invalid.length > 0) {
    return { error: `Unsupported scope: ${invalid.join(', ')}` };
  }

  return { scope: unique.join(' '), scopes: unique };
}

export function scopeAllows(scope, required) {
  const granted = new Set(String(scope).split(/\s+/).filter(Boolean));
  return granted.has(required);
}
