import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCurrentUser } from './useCurrentUser.js';

vi.mock('../tasksApi.ts', () => ({
  fetchAuthSession: vi.fn()
}));

import { fetchAuthSession } from '../tasksApi.ts';

describe('useCurrentUser', () => {
  it('exposes actor from displayName when authenticated', async () => {
    fetchAuthSession.mockResolvedValueOnce({
      actor: 'rowan',
      displayName: 'Rowan',
      approvalTypes: ['spec', 'tech_design', 'qa']
    });

    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.status).toBe('loading');
    expect(result.current.actor).toBe(null);

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.actor).toBe('Rowan');
  });

  it('falls back to actor when displayName is missing', async () => {
    fetchAuthSession.mockResolvedValueOnce({
      actor: 'Tom',
      approvalTypes: ['spec', 'qa']
    });

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.actor).toBe('Tom');
  });

  it('treats failed auth as anonymous', async () => {
    fetchAuthSession.mockRejectedValueOnce(new Error('Unauthenticated'));

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(result.current.actor).toBe(null);
  });
});