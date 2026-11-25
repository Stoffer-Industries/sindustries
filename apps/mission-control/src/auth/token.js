let tokenGetter = null;

export function setTokenGetter(getter) {
  tokenGetter = getter;
}

export function clearTokenGetter(getter) {
  if (!getter || tokenGetter === getter) tokenGetter = null;
}

export async function getAccessToken() {
  if (!tokenGetter) throw new Error('Authentication is not ready');
  const token = await tokenGetter();
  if (!token) throw new Error('Authentication is required');
  return token;
}
