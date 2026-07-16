import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../bookmarkStateSource.js', () => ({
  loadBookmarkState: vi.fn()
}));

import { loadBookmarkState } from '../bookmarkStateSource.js';
import { BookmarksTab } from './BookmarksTab.jsx';

const NOW_ISO = '2026-07-04T12:00:00.000Z';

function fakeState() {
  return {
    snapshot: {
      version: 1,
      items: {
        a: {
          title: 'Bookmark A',
          reviewStatus: 'summarized',
          topic: 'brain',
          lastUpdatedAt: NOW_ISO,
          curation: { score: 9, topic: 'brain', createdAt: NOW_ISO }
        },
        b: {
          title: 'Bookmark B',
          reviewStatus: 'pending',
          topic: 'infra',
          lastUpdatedAt: NOW_ISO
        },
        c: {
          title: 'Bookmark C',
          reviewStatus: 'approved',
          topic: 'brain',
          lastUpdatedAt: NOW_ISO
        }
      },
      approvalLocks: {
        brain: { items: ['c'], requestedAt: NOW_ISO }
      }
    },
    transitions: [
      { key: 'a', at: NOW_ISO, from: 'pending', to: 'summarized', reason: 'heartbeat pass' }
    ],
    loadedAt: NOW_ISO
  };
}

describe('BookmarksTab', () => {
  beforeEach(() => {
    loadBookmarkState.mockResolvedValue(fakeState());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state on first render and data after fetch resolves', async () => {
    render(<BookmarksTab />);
    expect(screen.getByTestId('pulse-bookmarks-loading')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks')).toBeTruthy()
    );
    expect(screen.getByTestId('pulse-bookmarks-toolbar')).toBeTruthy();
  });

  it('renders all major sections when data is loaded', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks')).toBeTruthy()
    );
    expect(screen.getByTestId('pulse-bookmarks-pending')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-kpi-row')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-curations')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-sankey')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-funnel')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-topics')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-state-chart')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-transitions')).toBeTruthy();
  });

  it('shows an error state with a retry button when fetch fails', async () => {
    loadBookmarkState.mockRejectedValueOnce(new Error('boom'));
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks-error')).toBeTruthy()
    );
    expect(screen.getByText(/boom/)).toBeTruthy();
    const retry = screen.getByTestId('pulse-bookmarks-retry');
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks')).toBeTruthy()
    );
  });

  it('refetches data when the refresh button is clicked', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks')).toBeTruthy()
    );
    const callsBefore = loadBookmarkState.mock.calls.length;
    fireEvent.click(screen.getByTestId('pulse-bookmarks-refresh'));
    await waitFor(() =>
      expect(loadBookmarkState.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });

  it('filters KPIs and funnel by the selected topic', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks')).toBeTruthy()
    );
    // Initial: brain + infra + general in topics
    const topicSelect = screen.getByLabelText('Topic');
    fireEvent.change(topicSelect, { target: { value: 'brain' } });
    // Funnel should now show only brain items (a + c), not infra (b)
    await waitFor(() => {
      const funnel = screen.getByTestId('pulse-bookmarks-funnel');
      // b was reviewStatus pending + topic infra; a was summarized + brain; c was approved + brain.
      // Selecting brain keeps a + c only.
      expect(funnel.textContent).toContain('approved');
      expect(funnel.textContent).toContain('summarized');
    });
  });

  it('keeps every KPI card inside a single DOM row (AC8)', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks-kpi-row')).toBeTruthy()
    );
    const row = screen.getByTestId('pulse-bookmarks-kpi-row');
    // The container carries the bookmarks-tab__kpis class so the CSS
    // grid row + single-row rules apply. The test ensures callers can
    // find a single wrapper that owns every KPI.
    expect(row.className).toContain('bookmarks-tab__kpis');
    // Pending approvals sit ABOVE the KPI row (sibling, not child).
    const pending = screen.getByTestId('pulse-bookmarks-pending');
    expect(row.parentElement.contains(pending)).toBe(true);
    expect(row.contains(pending)).toBe(false);
  });

  it('renders the Sankey section in collapsed form by default with a toggle', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks-sankey')).toBeTruthy()
    );
    // No chart on first render — Sankey is collapsed.
    expect(screen.queryByTestId('pulse-bookmarks-sankey-chart')).toBeNull();
    const toggle = screen.getByTestId('pulse-bookmarks-sankey-toggle');
    fireEvent.click(toggle);
    // After click the chart + nodes are rendered.
    expect(await screen.findByTestId('pulse-bookmarks-sankey-chart')).toBeTruthy();
    // Sankey produces nodes for the canonical 10-stage pipeline.
    expect(screen.getByTestId('pulse-bookmarks-sankey-node-Ingested')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-sankey-node-Approved')).toBeTruthy();
    fireEvent.click(toggle);
    // Toggle off collapses again.
    await waitFor(() =>
      expect(screen.queryByTestId('pulse-bookmarks-sankey-chart')).toBeNull()
    );
  });

  it('renders the states-over-time line chart with one path per status (AC9)', async () => {
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks-state-chart')).toBeTruthy()
    );
    // The wrapper carries the svg testid we asserted in the tech design.
    const svg = screen.getByTestId('pulse-bookmarks-state-chart-svg');
    expect(svg).toBeTruthy();
    // At least one path per visible status, including the curation buckets.
    expect(screen.getByTestId('pulse-bookmarks-state-chart-line-summarized')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-state-chart-line-pending')).toBeTruthy();
    // Legend renders one row per status.
    const legend = screen.getByTestId('pulse-bookmarks-state-chart-legend');
    expect(legend).toBeTruthy();
    expect(legend.textContent).toContain('summarized');
    expect(legend.textContent).toContain('pending');
  });

  it('renders an empty state for the states-over-time chart when there is no data', async () => {
    loadBookmarkState.mockResolvedValue({
      snapshot: { version: 1, items: {}, approvalLocks: {} },
      transitions: [],
      loadedAt: NOW_ISO
    });
    render(<BookmarksTab />);
    await waitFor(() =>
      expect(screen.getByTestId('pulse-bookmarks-state-chart-empty')).toBeTruthy()
    );
  });
});