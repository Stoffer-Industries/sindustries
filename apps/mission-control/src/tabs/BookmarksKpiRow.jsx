import React from 'react';
import { Card } from '@sindustries/ui/react';
import { STATUS_COLOR_VAR } from '../bookmarkPipeline.js';
import {
  bandFor,
  formatHeadline,
  isStale,
  SIGNAL_STATUS,
  subtitleFor
} from '../compoundingSignal.js';

const COMPOUNDING_TILE_TESTID = 'pulse-bookmarks-kpi-compounding';

function CompoundingTile({ compoundingSignal }) {
  // The Bookmarks tab always renders the compound tile first so it answers
  // the operator's first question — "are we compounding yet?" — before
  // they count states. Missing or malformed signals fall back to a
  // placeholder rather than hiding the tile.
  const status = compoundingSignal?.status ?? SIGNAL_STATUS.MISSING;
  const signal = status === SIGNAL_STATUS.VALID ? compoundingSignal.signal : null;
  const headline = signal ? formatHeadline(signal.headlinePercentage) : '—';
  const band = signal ? bandFor(signal.headlinePercentage) : 'neutral';
  const stale = signal ? isStale(signal) : false;
  const subtitle = signal ? subtitleFor(signal) : 'Signal unavailable';

  const bandClass = `bookmarks-tab__kpi-value bookmarks-tab__kpi-value--${band}`;
  const note = stale ? 'previous run · stale' : (status === SIGNAL_STATUS.MISSING ? 'awaiting first weekly run' : (status === SIGNAL_STATUS.MALFORMED ? 'malformed artifact' : '7d window'));

  return (
    <Card data-testid={COMPOUNDING_TILE_TESTID}>
      <div className="bookmarks-tab__kpi-label">Compounding % (7d)</div>
      <div className={bandClass} data-testid={`${COMPOUNDING_TILE_TESTID}-value`}>
        {headline}
      </div>
      <div className="bookmarks-tab__kpi-note" data-testid={`${COMPOUNDING_TILE_TESTID}-subtitle`}>
        {subtitle}
      </div>
      <div
        className="bookmarks-tab__kpi-meta"
        data-testid={`${COMPOUNDING_TILE_TESTID}-note`}
      >
        {stale ? 'stale' : note}
      </div>
    </Card>
  );
}

export function BookmarksKpiRow({ kpis, compoundingSignal }) {
  const entries = Object.entries(kpis).filter(([, count]) => count > 0);
  return (
    <div className="bookmarks-tab__kpis" data-testid="pulse-bookmarks-kpi-row">
      <CompoundingTile compoundingSignal={compoundingSignal} />
      {entries.map(([status, count]) => (
        <Card key={status} data-testid={`pulse-bookmarks-kpi-${status}`}>
          <div className="bookmarks-tab__kpi-label">{status}</div>
          <div
            className="bookmarks-tab__kpi-value"
            style={{ color: STATUS_COLOR_VAR[status] ?? 'var(--si-color-text, #111)' }}
          >
            {count}
          </div>
          <div className="bookmarks-tab__kpi-note">
            {status === 'pending' ? 'watch this' : 'current'}
          </div>
        </Card>
      ))}
    </div>
  );
}
