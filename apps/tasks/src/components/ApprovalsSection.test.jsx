import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchRequiredApprovalsMock = vi.fn();

vi.mock('../tasksApi.ts', async () => {
  const actual = await vi.importActual('../tasksApi.ts');
  return {
    ...actual,
    fetchRequiredApprovals: (...args) => fetchRequiredApprovalsMock(...args)
  };
});

const { ApprovalsSection } = await import('./ApprovalsSection.jsx');

describe('ApprovalsSection', () => {
  beforeEach(() => {
    fetchRequiredApprovalsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per required approval type', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue({
      taskType: 'feature',
      requiredApprovals: ['spec', 'tech_design', 'qa'],
      version: 1,
      source: 'builtin-default'
    });

    render(<ApprovalsSection task={{ taskType: 'feature', approvals: [] }} />);

    await waitFor(() => {
      expect(screen.getByText('Spec')).toBeInTheDocument();
      expect(screen.getByText('Tech Design')).toBeInTheDocument();
      expect(screen.getByText('QA')).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    checkboxes.forEach((checkbox) => {
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
    });
  });

  it('marks a row as approved when an approved row exists for the type', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue({
      taskType: 'feature',
      requiredApprovals: ['spec', 'tech_design', 'qa'],
      version: 1,
      source: 'builtin-default'
    });

    render(
      <ApprovalsSection
        task={{
          taskType: 'feature',
          approvals: [
            {
              id: 'a1',
              type: 'spec',
              owner: 'Tom',
              state: 'approved',
              approvedAt: '2026-08-08T05:00:00.000Z',
              revokedAt: null,
              note: null,
              createdAt: '2026-08-08T05:00:00.000Z',
              updatedAt: '2026-08-08T05:00:00.000Z'
            }
          ]
        }}
      />
    );

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[1]).not.toBeChecked();
      expect(checkboxes[2]).not.toBeChecked();
    });
  });

  it('shows a friendly empty state when no approvals are required', async () => {
    fetchRequiredApprovalsMock.mockResolvedValue({
      taskType: 'research',
      requiredApprovals: [],
      version: 1,
      source: 'builtin-default'
    });

    render(<ApprovalsSection task={{ taskType: 'research', approvals: [] }} />);

    await waitFor(() => {
      expect(
        screen.getByText('No approvals required for this task type.')
      ).toBeInTheDocument();
    });
  });

  it('shows a placeholder when task type is missing', async () => {
    render(<ApprovalsSection task={{ taskType: null, approvals: [] }} />);

    expect(
      screen.getByText('Select a task type to view required approvals.')
    ).toBeInTheDocument();
    expect(fetchRequiredApprovalsMock).not.toHaveBeenCalled();
  });

  it('surfaces an error message when the required-approvals fetch fails', async () => {
    fetchRequiredApprovalsMock.mockRejectedValue(new Error('boom'));

    render(<ApprovalsSection task={{ taskType: 'feature', approvals: [] }} />);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });
});
