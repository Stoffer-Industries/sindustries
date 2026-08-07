import React from 'react';
import { Card } from '@sindustries/ui/react';
import { STATUS_COLOR_VAR } from '../bookmarkPipeline.js';

export function BookmarksFunnelList({ funnel, topicCountsRows }) {
  const funnelMax = Math.max(1, ...funnel.map((row) => row.count));
  const topicMax = Math.max(1, ...topicCountsRows.map((row) => row.count));
  return (
    <div className="bookmarks-tab__two-col" data-testid="pulse-bookmarks-funnel-topics">
      <Card data-testid="pulse-bookmarks-funnel">
        <h2 className="bookmarks-tab__section-title">Pipeline funnel</h2>
        <p className="bookmarks-tab__section-subtitle">
          How far each bookmark gets. Counts in the selected time window.
        </p>
        <div className="bookmarks-tab__funnel">
          {funnel.length === 0 ? (
            <div className="bookmarks-tab__empty">No items match the current filters.</div>
          ) : (
            funnel.map((row) => (
              <div key={row.status} className="bookmarks-tab__funnel-row">
                <div className="bookmarks-tab__funnel-label">{row.status}</div>
                <div className="bookmarks-tab__funnel-track">
                  <div
                    className="bookmarks-tab__funnel-bar"
                    style={{
                      width: `${(row.count / funnelMax) * 100}%`,
                      background: STATUS_COLOR_VAR[row.status] ?? 'var(--si-color-text, #111)'
                    }}
                  />
                </div>
                <div className="bookmarks-tab__funnel-count">{row.count}</div>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card data-testid="pulse-bookmarks-topics">
        <h2 className="bookmarks-tab__section-title">By topic</h2>
        <div className="bookmarks-tab__topics">
          {topicCountsRows.length === 0 ? (
            <div className="bookmarks-tab__empty">No topic data.</div>
          ) : (
            topicCountsRows.slice(0, 8).map((row) => (
              <div key={row.topic} className="bookmarks-tab__topic-row">
                <div className="bookmarks-tab__topic-name">{row.topic}</div>
                <div className="bookmarks-tab__topic-track">
                  <div
                    className="bookmarks-tab__topic-bar"
                    style={{ width: `${(row.count / topicMax) * 100}%` }}
                  />
                </div>
                <div className="bookmarks-tab__topic-count">{row.count}</div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
