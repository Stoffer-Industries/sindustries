import React from 'react';
import { Card } from '@sindustries/ui/react';

export function BookmarksTopicsCard({ topicCountsRows }) {
  const topicMax = Math.max(1, ...topicCountsRows.map((row) => row.count));
  return (
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
  );
}