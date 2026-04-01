import { API_BASE_URL } from '../config';
import type { Session } from '../state/SessionContext';

export type ApiError = {
  code: string;
  message: string;
};

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { session?: Session | null }
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.session?.token ? { Authorization: `Bearer ${init.session.token}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const apiError =
      (json as any)?.error ??
      ({
        code: 'HTTP_ERROR',
        message: `Request failed: ${res.status}`
      } satisfies ApiError);
    throw new Error(apiError.message);
  }

  return json as T;
}

