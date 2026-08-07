import React from 'react';
import { Card } from '@sindustries/ui/react';

export function BookmarksRecentTransitions({ recent }) {
  return (
    <Card data-testid="pulse-bookmarks-transitions">
      <h2 className="bookmarks-tab__section-title">Recent transitions</h2>
      <div className="bookmarks-tab__recent">
        {recent.length === 0 ? (
          <div className="bookmarks-tab__empty">
            No transition log entries match the current filters.
          </div>
        ) : (
          recent.map((event, i) => (
            <div key={i} className="bookmarks-tab__recent-row">
              <span className="bookmarks-tab__recent-time">{event.at ?? ''}</span>
              <span className="bookmarks-tab__recent-key">{event.key ?? ''}</span>
              <span className="bookmarks-tab__recent-transition">
                {event.from && event.to
                  ? `${event.from} → ${event.to}`
                  : event.to
                    ? `→ ${event.to}`
                    : event.from
                      ? `${event.from} →`
                      : (event.reason ?? '(no change)')}
              </span>
              {event.reason && (event.from || event.to) ? (
                <span className="bookmarks-tab__recent-reason">{event.reason}</span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
