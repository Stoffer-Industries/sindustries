import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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
  updateItem,
  approveItem,
  publishItem,
  removeItem,
  getTodayStatus
} from '../contentSchedulerApi.js';
import { ContentSchedulerTab } from './ContentSchedulerTab.jsx';

const QUEUED_ID = '11111111-1111-1111-1111-111111111111';
const APPROVED_ID = '22222222-2222-2222-2222-222222222222';
const PUBLISHED_ID = '33333333-3333-3333-3333-333333333333';

function fixture({ now = '2026-07-18T15:00:00.000Z' } = {}) {
  // Default fixture uses scheduledFor values that resolve to the same
  // Pacific/Auckland day, regardless of the runtime clock.
  // The frozen clock in beforeEach pins "now" to 2026-07-18T15:00:00Z,
  // which is 2026-07-19 03:00 NZST, so the 10-day window starts at
  // 2026-07-19 (Sun) and runs through 2026-07-28.
  return [
    {
      id: QUEUED_ID,
      body: 'Queued tweet body',
      source: 'manual',
      sourceRef: null,
      status: 'queued',
      // 2026-07-18T19:00:00Z = 2026-07-19 07:00 NZST → today (2026-07-19)
      scheduledFor: '2026-07-18T19:00:00.000Z',
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
      // 2026-07-19T20:00:00Z = 2026-07-20 08:00 NZST → tomorrow (2026-07-20)
      scheduledFor: '2026-07-19T20:00:00.000Z',
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
      // 2026-07-20T21:00:00Z = 2026-07-21 09:00 NZST → today+2 (2026-07-21)
      // Inside the 10-day window so the calendar shows it as a published day.
      scheduledFor: '2026-07-20T21:00:00.000Z',
      position: 0,
      approvedAt: '2026-07-09T22:00:00.000Z',
      approvedBy: 'Tom',
      publishedAt: '2026-07-21T01:00:00.000Z',
      publishedUrl: 'https://x.com/sindustries/status/abc',
      publishError: null,
      createdAt: '2026-07-09T20:00:00.000Z',
      updatedAt: '2026-07-21T02:00:00.000Z',
      removedAt: null
    }
  ];
}

const TODAY_OK = { date: '2026-07-19', publishedCount: 0, publishedItemId: null, cap: 1 };
const TODAY_FULL = { date: '2026-07-19', publishedCount: 1, publishedItemId: PUBLISHED_ID, cap: 1 };

function dispatchDragStart(cardEl) {
  const dt = {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn(),
    getData: vi.fn().mockReturnValue(cardEl.getAttribute('data-item-id') ?? '')
  };
  fireEvent.dragStart(cardEl, { dataTransfer: dt });
  return dt;
}

describe('ContentSchedulerTab', () => {
  beforeEach(() => {
    // Freeze the runtime clock to 2026-07-19 03:00 NZST (= 2026-07-18T15:00:00Z)
    // so the 10-day window is deterministic. We do NOT call useFakeTimers
    // here because faking setInterval/setTimeout globally breaks the async
    // reload() promise chain that the component relies on to populate
    // items. The dedicated 10s-refresh test installs fake timers locally.
    vi.setSystemTime(new Date('2026-07-18T15:00:00.000Z'));
    listItems.mockResolvedValue(fixture());
    getTodayStatus.mockResolvedValue(TODAY_OK);
    createItem.mockResolvedValue({ id: 'new-id', body: 'New tweet', status: 'queued', source: 'manual', position: 1 });
    updateItem.mockResolvedValue({});
    approveItem.mockResolvedValue({});
    publishItem.mockResolvedValue({});
    removeItem.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders loading state then the calendar + unscheduled on mount', async () => {
    render(<ContentSchedulerTab />);
    expect(screen.getByTestId('pulse-content-scheduler-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    // AC1: 10 day columns exist.
    const dayColumns = screen.getAllByTestId(/^pulse-content-scheduler-day-\d{4}-\d{2}-\d{2}$/);
    expect(dayColumns).toHaveLength(10);
    // Unscheduled overflow is present.
    expect(screen.getByTestId('pulse-content-scheduler-unscheduled')).toBeTruthy();
    // Day-strip footer still shows today-status.
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

  // AC2 — in-window items appear in the correct Pacific/Auckland day column
  // with status badges.
  it('renders in-window items in the correct Pacific/Auckland day columns with status badges', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    // Published item sits in 2026-07-18 (yesterday in NZ), queued in 2026-07-19 (today), approved in 2026-07-20 (tomorrow).
    expect(within(screen.getByTestId('pulse-content-scheduler-day-2026-07-21')).getByTestId(`content-scheduler-row-${PUBLISHED_ID}`)).toBeTruthy();
    expect(within(screen.getByTestId('pulse-content-scheduler-day-2026-07-19')).getByTestId(`content-scheduler-row-${QUEUED_ID}`)).toBeTruthy();
    expect(within(screen.getByTestId('pulse-content-scheduler-day-2026-07-20')).getByTestId(`content-scheduler-row-${APPROVED_ID}`)).toBeTruthy();
    // Status badges surface on every card.
    expect(screen.getByTestId(`content-scheduler-status-${QUEUED_ID}`).textContent).toBe('Queued');
    expect(screen.getByTestId(`content-scheduler-status-${APPROVED_ID}`).textContent).toBe('Approved');
    expect(screen.getByTestId(`content-scheduler-status-${PUBLISHED_ID}`).textContent).toBe('Published');
  });

  // AC3 — items outside the 10-day window land in Unscheduled.
  it('routes items with no scheduledFor or out-of-window dates to Unscheduled', async () => {
    const items = fixture();
    items.push({
      id: 'unsched-1',
      body: 'No schedule',
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
    });
    items.push({
      id: 'unsched-2',
      body: 'Far future',
      source: 'manual',
      sourceRef: null,
      status: 'queued',
      // 2027-01-01 → way outside the 10-day window starting 2026-07-19.
      scheduledFor: '2027-01-01T00:00:00.000Z',
      position: 0,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      removedAt: null
    });
    listItems.mockResolvedValue(items);
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const overflow = screen.getByTestId('pulse-content-scheduler-unscheduled');
    expect(within(overflow).getByTestId('content-scheduler-row-unsched-1')).toBeTruthy();
    expect(within(overflow).getByTestId('content-scheduler-row-unsched-2')).toBeTruthy();
    // Neither overflow item appears inside any day column.
    const dayColumns = screen.getAllByTestId(/^pulse-content-scheduler-day-\d{4}-\d{2}-\d{2}$/);
    for (const col of dayColumns) {
      expect(within(col).queryByTestId('content-scheduler-row-unsched-1')).toBeNull();
      expect(within(col).queryByTestId('content-scheduler-row-unsched-2')).toBeNull();
    }
  });

  // AC4 — drag from one day column to another calls updateItem with an ISO on
  // the target date preserving HH:MM.
  it('drag-drop to another day updates scheduledFor preserving HH:MM', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const card = screen.getByTestId(`content-scheduler-row-${QUEUED_ID}`);
    const targetColumn = screen.getByTestId('pulse-content-scheduler-day-2026-07-22');
    const dt = dispatchDragStart(card);
    fireEvent.dragOver(targetColumn, { dataTransfer: dt });
    fireEvent.drop(targetColumn, { dataTransfer: dt });
    await waitFor(() => expect(updateItem).toHaveBeenCalled());
    const call = updateItem.mock.calls[updateItem.mock.calls.length - 1];
    expect(call[0]).toBe(QUEUED_ID);
    // Queued item is at 07:00 NZST. Target day is 2026-07-22, so the new
    // UTC instant is 2026-07-22 07:00 NZST = 2026-07-21 19:00 UTC.
    expect(call[1].scheduledFor).toBe('2026-07-21T19:00:00.000Z');
    expect(call[2]).toEqual({ actor: 'Tom' });
  });

  // AC4 — drag an item with no time defaults to 09:00.
  it('drag-drop with no source time defaults scheduledFor to 09:00 local', async () => {
    listItems.mockResolvedValue([
      {
        ...fixture()[0],
        id: 'no-time',
        scheduledFor: null
      }
    ]);
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const card = screen.getByTestId('content-scheduler-row-no-time');
    const target = screen.getByTestId('pulse-content-scheduler-day-2026-07-25');
    const dt = dispatchDragStart(card);
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await waitFor(() => expect(updateItem).toHaveBeenCalled());
    const call = updateItem.mock.calls[updateItem.mock.calls.length - 1];
    expect(call[1].scheduledFor).toBe('2026-07-24T21:00:00.000Z'); // 09:00 NZST
  });

  // AC5 — published cards are read-only with a published badge and no drag.
  it('published cards render with the Published badge and cannot be dragged', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    const publishedCard = screen.getByTestId(`content-scheduler-row-${PUBLISHED_ID}`);
    expect(publishedCard.getAttribute('draggable')).toBe('false');
    expect(within(publishedCard).getByTestId(`content-scheduler-published-${PUBLISHED_ID}`)).toBeTruthy();
    // No edit, approve, unapprove, publish, remove buttons on a published card.
    expect(within(publishedCard).queryByTestId(`content-scheduler-edit-${PUBLISHED_ID}`)).toBeNull();
    expect(within(publishedCard).queryByTestId(`content-scheduler-approve-${PUBLISHED_ID}`)).toBeNull();
    expect(within(publishedCard).queryByTestId(`content-scheduler-publish-${PUBLISHED_ID}`)).toBeNull();
    expect(within(publishedCard).queryByTestId(`content-scheduler-remove-${PUBLISHED_ID}`)).toBeNull();
    // Drag should be a no-op (no updateItem call).
    const dt = { setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(publishedCard, { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('pulse-content-scheduler-day-2026-07-25'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('pulse-content-scheduler-day-2026-07-25'), { dataTransfer: dt });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateItem).not.toHaveBeenCalled();
  });

  // AC6 — drag-drop onto a day with a published item is refused and shows an
  // inline error.
  it('refuses to drop onto a day with an existing published item and shows an inline error', async () => {
    render(<ContentSchedulerTab />);
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
    // The published item sits in 2026-07-21 (today+2 in NZ). Drag the queued
    // card onto that day.
    const queuedCard = screen.getByTestId(`content-scheduler-row-${QUEUED_ID}`);
    const publishedDay = screen.getByTestId('pulse-content-scheduler-day-2026-07-21');
    const dt = dispatchDragStart(queuedCard);
    fireEvent.dragOver(publishedDay, { dataTransfer: dt });
    fireEvent.drop(publishedDay, { dataTransfer: dt });
    await waitFor(() => expect(screen.getByTestId('pulse-content-scheduler-day-drop-error-2026-07-21')).toBeTruthy());
    expect(screen.getByTestId('pulse-content-scheduler-day-drop-error-2026-07-21').textContent).toMatch(/already has a published/i);
    expect(updateItem).not.toHaveBeenCalled();
  });
});