import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

import { listItems, updateItem, getTodayStatus } from '../contentSchedulerApi.js';
import { ContentSchedulerTab } from './ContentSchedulerTab.jsx';

const SINGLE_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';

function singleItem(body, id = SINGLE_ID) {
  return {
    id,
    kind: 'single',
    body,
    source: 'manual',
    sourceRef: null,
    status: 'queued',
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
  };
}

function threadItem(rootBody, partBody) {
  return {
    ...singleItem(rootBody, THREAD_ID),
    kind: 'thread',
    parts: [{ id: 'p1', position: 1, body: partBody }]
  };
}

// Mount the tab with fake timers installed. The 10s background poll is the
// real one from useContentScheduler, so advancing the clock genuinely
// exercises the poll -> new item objects -> card prop path.
async function boot() {
  render(<ContentSchedulerTab />);
  await vi.waitFor(() => expect(screen.getByTestId('pulse-content-scheduler')).toBeTruthy());
}

async function advancePastPoll() {
  await vi.advanceTimersByTimeAsync(11_000);
  await vi.advanceTimersByTimeAsync(50);
}

describe('ContentSchedulerTab — an open edit draft survives the 10s refresh (task 8352c722)', () => {
  beforeEach(() => {
    // Pin "now" so the 10-day calendar window is deterministic. The fake
    // timers are installed per-test (after setSystemTime) so the async
    // reload() promise chain still flushes via advanceTimersByTimeAsync.
    vi.setSystemTime(new Date('2026-07-18T15:00:00.000Z'));
    getTodayStatus.mockImplementation(async () => ({ publishedToday: 0, dailyCap: 99, ok: true }));
    updateItem.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // AC1 — single edit, server copy unchanged across the poll.
  it('keeps a single-item draft when the poll returns an unchanged server copy', async () => {
    listItems.mockImplementation(async () => [singleItem('SERVER v1')]);
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${SINGLE_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`));
    fireEvent.change(box, { target: { value: 'TYPED EDIT' } });

    await advancePastPoll();

    expect(screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`).value).toBe('TYPED EDIT');
  });

  // AC1 — single edit, server copy changed across the poll. This is the
  // user-reported symptom: the typed text reverts to the original content.
  it('keeps a single-item draft when the poll returns a changed server copy', async () => {
    let call = 0;
    listItems.mockImplementation(async () => {
      call += 1;
      return [singleItem(call === 1 ? 'SERVER v1' : 'SERVER v2')];
    });
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${SINGLE_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`));
    fireEvent.change(box, { target: { value: 'TYPED EDIT' } });

    await advancePastPoll();

    expect(screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`).value).toBe('TYPED EDIT');
  });

  // AC1 — thread edit, server copy unchanged across the poll. The thread
  // path regressed even when the server copy was byte-for-byte identical,
  // because the poll allocates a new item object and the draft-sync effect
  // depended on that object identity.
  it('keeps a thread part draft when the poll returns an unchanged server copy', async () => {
    listItems.mockImplementation(async () => [threadItem('ROOT v1', 'PART v1')]);
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${THREAD_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-thread-edit-body-${THREAD_ID}-0`));
    fireEvent.change(box, { target: { value: 'TYPED PART EDIT' } });

    await advancePastPoll();

    expect(screen.getByTestId(`content-scheduler-thread-edit-body-${THREAD_ID}-0`).value).toBe('TYPED PART EDIT');
  });

  // AC1 — thread edit, server copy changed across the poll.
  it('keeps a thread part draft when the poll returns a changed server copy', async () => {
    let call = 0;
    listItems.mockImplementation(async () => {
      call += 1;
      return [
        threadItem(call === 1 ? 'ROOT v1' : 'ROOT v2', call === 1 ? 'PART v1' : 'PART v2')
      ];
    });
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${THREAD_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-thread-edit-body-${THREAD_ID}-0`));
    fireEvent.change(box, { target: { value: 'TYPED PART EDIT' } });

    await advancePastPoll();

    expect(screen.getByTestId(`content-scheduler-thread-edit-body-${THREAD_ID}-0`).value).toBe('TYPED PART EDIT');
  });

  // AC2 — the 10s auto-post-visibility refresh must still update rows that
  // are NOT being edited while another row has an open draft.
  it('still refreshes a non-edited row while another row is being edited', async () => {
    let call = 0;
    listItems.mockImplementation(async () => {
      call += 1;
      return [
        singleItem('SERVER v1', SINGLE_ID),
        singleItem(call === 1 ? 'OTHER v1' : 'OTHER v2', OTHER_ID)
      ];
    });
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${SINGLE_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`));
    fireEvent.change(box, { target: { value: 'TYPED EDIT' } });

    await advancePastPoll();

    // The edited row keeps the operator's draft...
    expect(screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`).value).toBe('TYPED EDIT');
    // ...while the untouched row picked up the new server value.
    expect(screen.getByTestId(`content-scheduler-body-${OTHER_ID}`).textContent).toBe('OTHER v2');
  });

  // The save contract must send the operator's local draft, not the copy
  // that the poll brought back from the server.
  it('saves the local draft rather than the polled server copy', async () => {
    let call = 0;
    listItems.mockImplementation(async () => {
      call += 1;
      return [singleItem(call === 1 ? 'SERVER v1' : 'SERVER v2')];
    });
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${SINGLE_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`));
    fireEvent.change(box, { target: { value: 'TYPED EDIT' } });

    await advancePastPoll();

    fireEvent.click(screen.getByTestId(`content-scheduler-save-${SINGLE_ID}`));
    await vi.waitFor(() => expect(updateItem).toHaveBeenCalled());

    const [id, patch] = updateItem.mock.calls[updateItem.mock.calls.length - 1];
    expect(id).toBe(SINGLE_ID);
    expect(patch.body).toBe('TYPED EDIT');
  });

  // Cancel discards the local draft and the card falls back to the latest
  // server copy.
  it('discards the local draft on cancel and shows the latest server copy', async () => {
    let call = 0;
    listItems.mockImplementation(async () => {
      call += 1;
      return [singleItem(call === 1 ? 'SERVER v1' : 'SERVER v2')];
    });
    vi.useFakeTimers();
    await boot();

    fireEvent.click(screen.getByTestId(`content-scheduler-edit-${SINGLE_ID}`));
    const box = await vi.waitFor(() => screen.getByTestId(`content-scheduler-edit-body-${SINGLE_ID}`));
    fireEvent.change(box, { target: { value: 'TYPED EDIT' } });

    await advancePastPoll();

    fireEvent.click(screen.getByTestId(`content-scheduler-cancel-${SINGLE_ID}`));
    await vi.waitFor(() => expect(screen.getByTestId(`content-scheduler-body-${SINGLE_ID}`)).toBeTruthy());

    // The typed text is gone and the latest server copy is shown.
    expect(screen.getByTestId(`content-scheduler-body-${SINGLE_ID}`).textContent).toBe('SERVER v2');
    expect(updateItem).not.toHaveBeenCalled();
  });
});
