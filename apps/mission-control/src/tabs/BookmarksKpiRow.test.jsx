import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BookmarksKpiRow } from './BookmarksKpiRow.jsx';
import { SIGNAL_STATUS, SCHEMA_VERSION, STALE_AFTER_DAYS } from '../compoundingSignal.js';

function makeSignal(percentage, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: '2026-08-17T20:15:00Z',
    generatedAt: new Date().toISOString(),
    asOf: '2026-08-17T20:15:00Z',
    headlinePercentage: percentage,
    currentWindow: {
      start: '2026-08-10T20:15:00Z',
      end: '2026-08-17T20:15:00Z',
      eligibleCount: 8,
      referencedCount: 3,
      percentage,
      dossierPromotionCount: 2
    },
    trend: [
      { offsetWeeks: 0, start: '2026-08-10T20:15:00Z', end: '2026-08-17T20:15:00Z', eligibleCount: 8, referencedCount: 3, percentage },
      { offsetWeeks: 1, start: '2026-08-03T20:15:00Z', end: '2026-08-10T20:15:00Z', eligibleCount: 6, referencedCount: 1, percentage: 16.7 },
      { offsetWeeks: 2, start: '2026-07-27T20:15:00Z', end: '2026-08-03T20:15:00Z', eligibleCount: 5, referencedCount: 1, percentage: 20.0 },
      { offsetWeeks: 3, start: '2026-07-20T20:15:00Z', end: '2026-07-27T20:15:00Z', eligibleCount: 4, referencedCount: 0, percentage: 0.0 }
    ],
    operatorNote: null,
    decisionPolicy: {
      lowPercentageBelow: 25.0,
      corpusEstablishedDocuments: 25,
      minimumFourWeekEligibleItemsForBrokenPath: 10
    },
    inputs: {
      bookmarkState: { path: 'x' },
      corpusIndex: { path: 'y' },
      dossierPromotions: { path: 'z' }
    },
    ...overrides
  };
}

const COMPOUNDING_VALUE = 'pulse-bookmarks-kpi-compounding-value';
const COMPOUNDING_SUBTITLE = 'pulse-bookmarks-kpi-compounding-subtitle';
const COMPOUNDING_NOTE = 'pulse-bookmarks-kpi-compounding-note';

describe('BookmarksKpiRow — Compounding tile', () => {
  it('renders green band at 50.0% (boundary, AC4)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(50.0) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('50.0%');
    expect(value.className).toContain('green');
  });

  it('renders green band at 75.0%', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(75.0) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('75.0%');
    expect(value.className).toContain('green');
  });

  it('renders amber band at 49.9% (just below green threshold)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(49.9) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('49.9%');
    expect(value.className).toContain('amber');
  });

  it('renders amber band at 25.0% (boundary, AC4)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(25.0) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('25.0%');
    expect(value.className).toContain('amber');
  });

  it('renders red band at 24.9% (just below amber threshold)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(24.9) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('24.9%');
    expect(value.className).toContain('red');
  });

  it('renders red band at 0.0%', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(0.0) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('0.0%');
    expect(value.className).toContain('red');
  });

  it('renders em-dash and neutral band when percentage is null', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(null) }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('—');
    expect(value.className).toContain('neutral');
  });

  it('renders the subtitle "<referenced>/<eligible> referenced · <n> dossier promotions"', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal: makeSignal(37.5) }}
      />
    );
    const subtitle = screen.getByTestId(COMPOUNDING_SUBTITLE);
    expect(subtitle.textContent).toBe('3/8 referenced · 2 dossier promotions');
  });

  it('marks the tile stale when generatedAt is older than STALE_AFTER_DAYS days', () => {
    const longAgo = new Date(Date.now() - (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const signal = makeSignal(37.5, { generatedAt: longAgo });
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal }}
      />
    );
    const note = screen.getByTestId(COMPOUNDING_NOTE);
    expect(note.textContent).toBe('stale');
    // Headline is still rendered — previous value stays visible.
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('37.5%');
  });

  it('does not render stale marker for a fresh signal', () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const signal = makeSignal(37.5, { generatedAt: recent });
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.VALID, signal }}
      />
    );
    const note = screen.getByTestId(COMPOUNDING_NOTE);
    expect(note.textContent).not.toBe('stale');
  });

  it('renders the missing placeholder when status is MISSING (no signal yet)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.MISSING, signal: null, error: null }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('—');
    expect(value.className).toContain('neutral');
    const subtitle = screen.getByTestId(COMPOUNDING_SUBTITLE);
    expect(subtitle.textContent).toBe('Signal unavailable');
    const note = screen.getByTestId(COMPOUNDING_NOTE);
    expect(note.textContent).toBe('awaiting first weekly run');
  });

  it('renders the malformed placeholder when status is MALFORMED', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1 }}
        compoundingSignal={{ status: SIGNAL_STATUS.MALFORMED, signal: null, error: 'schemaVersion mismatch' }}
      />
    );
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('—');
    expect(value.className).toContain('neutral');
    const subtitle = screen.getByTestId(COMPOUNDING_SUBTITLE);
    expect(subtitle.textContent).toBe('Signal unavailable');
    const note = screen.getByTestId(COMPOUNDING_NOTE);
    expect(note.textContent).toBe('malformed artifact');
  });

  it('renders the tile first even when there are no other KPIs', () => {
    render(
      <BookmarksKpiRow
        kpis={{}}
        compoundingSignal={{ status: SIGNAL_STATUS.MISSING, signal: null, error: null }}
      />
    );
    const row = screen.getByTestId('pulse-bookmarks-kpi-row');
    const compounding = screen.getByTestId('pulse-bookmarks-kpi-compounding');
    // Compounding tile is the first child of the row; with empty kpis it is
    // the only KPI child. Verify both conditions.
    expect(row.firstChild).toBe(compounding);
    const kpiChildren = Array.from(row.children).filter((c) =>
      c.getAttribute('data-testid')?.startsWith('pulse-bookmarks-kpi-')
    );
    expect(kpiChildren).toHaveLength(1);
  });

  it('treats absent compoundingSignal prop as missing (does not crash)', () => {
    render(<BookmarksKpiRow kpis={{ summarized: 1 }} />);
    const value = screen.getByTestId(COMPOUNDING_VALUE);
    expect(value.textContent).toBe('—');
    const subtitle = screen.getByTestId(COMPOUNDING_SUBTITLE);
    expect(subtitle.textContent).toBe('Signal unavailable');
  });

  it('does not fail the rest of the KPI row when signal is malformed (independent failure semantics, AC5)', () => {
    render(
      <BookmarksKpiRow
        kpis={{ summarized: 1, approved: 2 }}
        compoundingSignal={{ status: SIGNAL_STATUS.MALFORMED, signal: null, error: 'boom' }}
      />
    );
    // Other KPI cards still render.
    expect(screen.getByTestId('pulse-bookmarks-kpi-summarized')).toBeTruthy();
    expect(screen.getByTestId('pulse-bookmarks-kpi-approved')).toBeTruthy();
    // Compounding tile shows the malformed placeholder rather than crashing.
    expect(screen.getByTestId(COMPOUNDING_VALUE).textContent).toBe('—');
  });
});
