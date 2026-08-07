import React from 'react';
import { Card } from '@sindustries/ui/react';
import { STATUS_COLOR_VAR } from '../bookmarkPipeline.js';

export function BookmarksKpiRow({ kpis }) {
  const entries = Object.entries(kpis).filter(([, count]) => count > 0);
  return (
    <div className="bookmarks-tab__kpis" data-testid="pulse-bookmarks-kpi-row">
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
