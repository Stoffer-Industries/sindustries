import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../contentSchedulerApi.js', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  approveItem: vi.fn(),
  unapproveItem: vi.fn(),
  publishItem: vi.fn(),
  removeItem: vi.fn(),
  reorderItems: vi.fn(),
  getTodayStatus: vi.fn()
}));

import {
  listItems,
  createItem,
  approveItem,
  publishItem,
  removeItem,
  reorderItems,
  getTodayStatus
} from '../contentSchedulerApi.js';
import { ContentSchedulerTab } from './ContentSchedulerTab.jsx';

const QUEUED_ID = '11111111-1111-1111-1111-111111111111';
const APPROVED_ID = '22222222-2222-2222-2222-222222222222';
const PUBLISHED_ID = '33333333-3333-3333-3333-333333333333';

function fixture() {
  return [
    {
      id: QUEUED_ID,
      body: 'Queued tweet body',
      source: 'manual',
      sourceRef: null,
      status: 'queued',
      scheduledFor: null,
      position: 0,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      removedAt: null
    },
    {
      id: APPROVED_ID,
      body: 'Approved tweet body',
      source: 'ops_notes',
      sourceRef: null,
      status: 'approved',
      scheduledFor: null,
      position: 0,
      approvedAt: '2026-07-10T01:00:00.000Z',
      approvedBy: 'Tom',
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T01:00:00.000Z',
      removedAt: null
    },
    {
      id: PUBLISHED_ID,
      body: 'Published tweet body',
      source: 'cto_craft',
      sourceRef: null,
      status: 'published',
      scheduledFor: null,
      position: 0,
      approvedAt: '2026-07-09T22:00:00.000Z',
      approvedBy: 'Tom',
      publishedAt: '2026-07-10T03:00:00.000Z',
      publishedUrl: 'https://x.com/sindustries/status/abc',
      publishError: null,
      createdAt: '2026-07-09T20:00:00.000Z',
      updatedAt: '2026-07-10T03:00:00.000Z',
      removedAt: null
    }
  ];
}

const TODAY_OK = { date: '2026-07-10', publishedCount: 0, publishedItemId: null, cap: 1 };
const TODAY_FULL = { date: '2026-07-10', publishedCount: 1, publishedItemId: PUBLISHED_ID, cap: 1 };

describe('ContentSchedulerTab', () => {
  beforeEach(() => {
    listItems.mockResolvedValue(fixture());
    getTodayStatus.mockResolvedValue(TODAY_OK);
    createItem.mockResolvedValue({ id: 'new-id', body: 'New tweet', status: 'queued', source: 'manual', position: 1 });
    approveItem.mockResolvedValue({});
    publishItem.mockResolvedValue({});
    removeItem.mockResolvedValue({});
    reorderItems.mockResolvedValue({ ok: true, count: 3 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state then the full tab on mount', async () => {
    render(<ContentSchedulerTab />);
    expect(screen.getByTestId('pulse-content-scheduler-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    expect(screen.getByTestId('pulse-content-scheduler-composer')).toBeTruthy();
    expect(screen.getByTestId('pulse-content-scheduler-group-queued')).toBeTruthy();
    expect(screen.getByTestId('pulse-content-scheduler-group-approved')).toBeTruthy();
    expect(screen.getByTestId('pulse-content-scheduler-group-published')).toBeTruthy();
    expect(screen.getByTestId('pulse-content-scheduler-day-strip').textContent).toContain('0 / 1');
  });

  it('shows an error state when fetch fails and recovers on retry', async () => {
    listItems.mockRejectedValueOnce(new Error('boom'));
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler-error')).toBeTruthy());
    expect(screen.getByText(/boom/)).toBeTruthy();
    listItems.mockResolvedValue(fixture());
    fireEvent.click(screen.getByTestId('pulse-content-scheduler-retry'));
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
  });

  it('disables the publish button until approval is recorded', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const queuedPublish = screen.getByTestId(`content-scheduler-publish-${QUEUED_ID}`);
    expect(queuedPublish.hasAttribute('disabled')).toBe(true);
    const approvedPublish = screen.getByTestId(`content-scheduler-publish-${APPROVED_ID}`);
    expect(approvedPublish.hasAttribute('disabled')).toBe(false);
  });

  it('disables publish on approved items when day cap is reached', async () => {
    getTodayStatus.mockResolvedValue(TODAY_FULL);
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const approvedPublish = screen.getByTestId(`content-scheduler-publish-${APPROVED_ID}`);
    expect(approvedPublish.hasAttribute('disabled')).toBe(true);
    expect(approvedPublish.getAttribute('title')).toMatch(/max one/i);
  });

  it('approve button calls the approve endpoint and refreshes', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const callsBefore = approveItem.mock.calls.length;
    fireEvent.click(screen.getByTestId(`content-scheduler-approve-${QUEUED_ID}`));
    await waitFor(() => expect(approveItem.mock.calls.length).toBe(callsBefore + 1));
    expect(approveItem).toHaveBeenCalledWith(QUEUED_ID, 'Tom');
  });

  it('publish button on an approved item calls the publish endpoint', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    fireEvent.click(screen.getByTestId(`content-scheduler-publish-${APPROVED_ID}`));
    await waitFor(() => expect(publishItem).toHaveBeenCalledWith(APPROVED_ID, 'Tom'));
  });

  it('remove button calls the remove endpoint', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    fireEvent.click(screen.getByTestId(`content-scheduler-remove-${QUEUED_ID}`));
    await waitFor(() => expect(removeItem).toHaveBeenCalledWith(QUEUED_ID, 'Tom'));
  });

  it('add-to-queue calls createItem with the trimmed body', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const textarea = screen.getByTestId('pulse-content-scheduler-body');
    fireEvent.change(textarea, { target: { value: '   New draft tweet   ' } });
    fireEvent.click(screen.getByTestId('pulse-content-scheduler-add'));
    await waitFor(() => expect(createItem).toHaveBeenCalled());
    const call = createItem.mock.calls[createItem.mock.calls.length - 1][0];
    expect(call.body).toBe('New draft tweet');
  });

  // AC6 — the mounted tab must refresh every 10 seconds so auto-posted
  // items (driven by the worker's delayed job) appear in the UI within one
  // cycle.
  it('refreshes the queue and today-status every 10 seconds while mounted', async () => {
    vi.useFakeTimers();
    try {
      const initialCallCount = listItems.mock.calls.length;
      render(<ContentSchedulerTab />);
      await vi.waitFor(() => expect(listItems.mock.calls.length).toBeGreaterThan(initialCallCount));
      const beforeAdvance = listItems.mock.calls.length;
      const beforeAdvanceToday = getTodayStatus.mock.calls.length;
      // Advance just under one interval — no refresh yet.
      vi.advanceTimersByTime(9_000);
      expect(listItems.mock.calls.length).toBe(beforeAdvance);
      // Advance past one interval — one refresh.
      vi.advanceTimersByTime(2_000);
      expect(listItems.mock.calls.length).toBe(beforeAdvance + 1);
      expect(getTodayStatus.mock.calls.length).toBe(beforeAdvanceToday + 1);
      // Advance past another interval — second refresh.
      vi.advanceTimersByTime(10_000);
      expect(listItems.mock.calls.length).toBe(beforeAdvance + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});