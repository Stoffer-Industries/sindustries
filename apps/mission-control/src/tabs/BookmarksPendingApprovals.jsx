import React from 'react';
import { Card } from '@sindustries/ui/react';

export function BookmarksPendingApprovals({ pending, relativeAge }) {
  if (!pending || pending.length === 0) return null;
  return (
    <Card
      variant="default"
      className="bookmarks-tab__pending"
      data-testid="pulse-bookmarks-pending"
    >
      <strong>Pending approvals — waiting on you</strong>
      <ul className="bookmarks-tab__pending-list">
        {pending.map((row) => (
          <li key={row.topic} className="bookmarks-tab__pending-item">
            <span className="bookmarks-tab__pending-topic">{row.topic}</span>
            <span className="bookmarks-tab__pending-meta">
              {row.itemCount} item{row.itemCount === 1 ? '' : 's'} ·{' '}
              {row.requestedAt ? relativeAge(row.requestedAt) + ' ago' : 'awaiting'}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}