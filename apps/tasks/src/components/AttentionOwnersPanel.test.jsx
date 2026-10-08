import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchAuthSessionMock = vi.fn();
const resolveOwnAttentionOwnerMock = vi.fn();
const deleteAttentionOwnerMock = vi.fn();

vi.mock('../tasksApi.ts', async () => {
  const actual = await vi.importActual('../tasksApi.ts');
  return {
    ...actual,
    fetchAuthSession: (...args) => fetchAuthSessionMock(...args),
    resolveOwnAttentionOwner: (...args) => resolveOwnAttentionOwnerMock(...args),
    deleteAttentionOwner: (...args) => deleteAttentionOwnerMock(...args)
  };
});

const { AttentionOwnersPanel } = await import('./AttentionOwnersPanel.jsx');

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const row = {
  id: 'attention-row-1',
  owner: 'Quinn',
  position: 0,
  addedBy: 'Tom',
  note: 'Needs review',
  createdAt: '2026-10-08T00:00:00.000Z'
};

function task(overrides = {}) {
  return {
    id: TASK_ID,
    attentionOwnerDetails: [row],
    ...overrides
  };
}

describe('AttentionOwnersPanel', () => {
  beforeEach(() => {
    fetchAuthSessionMock.mockReset().mockResolvedValue({ actor: 'Quinn' });
    resolveOwnAttentionOwnerMock.mockReset().mockResolvedValue({ nextTopOwner: null });
    deleteAttentionOwnerMock.mockReset().mockResolvedValue({});
  });

  it('passes the full task UUID when refreshing after resolving a blocker', async () => {
    const onTaskRefresh = vi.fn().mockResolvedValue(undefined);
    render(<AttentionOwnersPanel task={task()} onTaskRefresh={onTaskRefresh} />);

    await userEvent.click(await screen.findByTestId('resolve-blocker'));

    await waitFor(() => expect(resolveOwnAttentionOwnerMock).toHaveBeenCalledWith(TASK_ID));
    await waitFor(() => expect(onTaskRefresh).toHaveBeenCalledWith(TASK_ID));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes the full task UUID when refreshing after removing a row', async () => {
    const onTaskRefresh = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue('');
    render(<AttentionOwnersPanel task={task()} onTaskRefresh={onTaskRefresh} />);

    await userEvent.click(await screen.findByTestId(`remove-${row.id}`));

    await waitFor(() => expect(deleteAttentionOwnerMock).toHaveBeenCalledWith(TASK_ID, row.id, undefined));
    await waitFor(() => expect(onTaskRefresh).toHaveBeenCalledWith(TASK_ID));
    vi.restoreAllMocks();
  });
});
