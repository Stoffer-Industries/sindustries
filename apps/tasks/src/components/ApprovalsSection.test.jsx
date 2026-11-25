import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchRequiredApprovalsMock = vi.fn();
const createTaskApprovalMock = vi.fn();
const deleteTaskApprovalMock = vi.fn();
const fetchAuthSessionMock = vi.fn();

vi.mock('../tasksApi.ts', async () => {
  const actual = await vi.importActual('../tasksApi.ts');
  return {
    ...actual,
    fetchRequiredApprovals: (...args) => fetchRequiredApprovalsMock(...args),
    createTaskApproval: (...args) => createTaskApprovalMock(...args),
    deleteTaskApproval: (...args) => deleteTaskApprovalMock(...args),
    fetchAuthSession: (...args) => fetchAuthSessionMock(...args)
  };
});

const { ApprovalsSection } = await import('./ApprovalsSection.jsx');

const required = (types = ['spec', 'tech_design', 'qa_agent', 'accepted']) => ({
  taskType: 'feature', requiredApprovals: types, version: 1, source: 'builtin-default'
});
const approved = {
  id: 'a1', type: 'spec', owner: 'Tom', state: 'approved',
  approvedAt: '2026-08-08T05:00:00.000Z', revokedAt: null, note: null,
  createdAt: '2026-08-08T05:00:00.000Z', updatedAt: '2026-08-08T05:00:00.000Z'
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ApprovalsSection', () => {
  beforeEach(() => {
    fetchRequiredApprovalsMock.mockReset();
    createTaskApprovalMock.mockReset();
    deleteTaskApprovalMock.mockReset();
    fetchAuthSessionMock.mockReset().mockResolvedValue({ actor: 'Tom', approvalTypes: ['spec', 'qa_agent'] });
  });

  afterEach(() => vi.clearAllMocks());

  it('renders interactive rows and preserves approved owner avatar and tooltip', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue(required());
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [approved] }} />);

    expect(await screen.findByRole('checkbox', { name: 'Spec approval' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Tech Design approval' })).toBeDisabled();
    expect(screen.getByLabelText(/Spec approved by Tom/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tom')).toBeInTheDocument();
  });

  it('renders Tom\'s tech_design and qa_agent checkboxes enabled (task 2c3bf69b override)', async () => {
    // Tom's session now includes tech_design + qa_agent as additive override
    // permissions (ACTOR_PERMISSIONS.Tom extended). The component trusts
    // approvalTypes from the server; with all four types returned every
    // required checkbox must render enabled, including tech_design and
    // qa_agent which were previously disabled for Tom.
    fetchAuthSessionMock.mockResolvedValue({ actor: 'Tom', approvalTypes: ['spec', 'accepted', 'tech_design', 'qa_agent'] });
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec', 'tech_design', 'qa_agent', 'accepted']));
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [] }} />);

    expect(await screen.findByRole('checkbox', { name: 'Spec approval' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Tech Design approval' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'QA (Ash) approval' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Accepted approval' })).toBeEnabled();
  });

  it('shows the Clerk actor without rendering password or local logout controls', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec']));
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [] }} />);

    expect(await screen.findByText('Signed in as Tom')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('optimistically approves one row, disables only that row, and refreshes the parent', async () => {
    const mutation = deferred();
    const onTaskRefresh = vi.fn().mockResolvedValue(undefined);
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec', 'qa_agent']));
    createTaskApprovalMock.mockReturnValue(mutation.promise);
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [] }} onTaskRefresh={onTaskRefresh} />);

    const spec = await screen.findByRole('checkbox', { name: 'Spec approval' });
    const qa = screen.getByRole('checkbox', { name: 'QA (Ash) approval' });
    await userEvent.click(spec);

    expect(spec).toBeChecked();
    expect(spec).toBeDisabled();
    expect(qa).toBeEnabled();
    expect(createTaskApprovalMock).toHaveBeenCalledWith('task-1', { type: 'spec' });

    mutation.resolve(approved);
    await waitFor(() => expect(onTaskRefresh).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(spec).toBeEnabled());
  });

  it('optimistically revokes an approved row through DELETE', async () => {
    const mutation = deferred();
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec']));
    deleteTaskApprovalMock.mockReturnValue(mutation.promise);
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [approved] }} />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Spec approval' });
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(deleteTaskApprovalMock).toHaveBeenCalledWith('task-1', 'spec');

    mutation.resolve({ ...approved, state: 'revoked' });
    await waitFor(() => expect(checkbox).toBeEnabled());
  });

  it('rolls back a failed mutation and exposes a row-level accessible error', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec']));
    createTaskApprovalMock.mockRejectedValue(new Error('Not allowed'));
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [] }} />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Spec approval' });
    await userEvent.click(checkbox);

    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(checkbox).toHaveAccessibleDescription('Not allowed');
  });

  it.each([
    [{ archivedAt: '2026-08-09T00:00:00.000Z', status: 'ready' }, 'archived'],
    [{ archivedAt: null, status: 'done' }, 'done']
  ])('keeps %s tasks immutable', async (immutableFields) => {
    fetchRequiredApprovalsMock.mockResolvedValue(required(['spec']));
    render(<ApprovalsSection task={{ id: 'task-1', taskType: 'feature', approvals: [], ...immutableFields }} />);
    expect(await screen.findByRole('checkbox', { name: 'Spec approval' })).toBeDisabled();
  });

  it('shows empty, missing-type, and fetch-error states', async () => {
    fetchRequiredApprovalsMock.mockResolvedValueOnce(required([]));
    const { rerender } = render(<ApprovalsSection task={{ id: '1', taskType: 'feature', approvals: [] }} />);
    expect(await screen.findByText('No approvals required for this task type.')).toBeInTheDocument();

    rerender(<ApprovalsSection task={{ id: '1', taskType: null, approvals: [] }} />);
    expect(screen.getByText('Select a task type to view required approvals.')).toBeInTheDocument();

    fetchRequiredApprovalsMock.mockRejectedValueOnce(new Error('boom'));
    rerender(<ApprovalsSection task={{ id: '1', taskType: 'code', approvals: [] }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
