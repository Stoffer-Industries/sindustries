import React from 'react';

export function BookmarksCurationItemRow({ item, relativeAge }) {
  const c = item.curation;
  const title = item.title || item.key;
  const topic = c?.topic || item.topic || 'general';
  const score = c ? Number(c.score || 0) : null;
  const created = c?.createdAt ? relativeAge(c.createdAt) + ' ago' : '';
  const status = item.reviewStatus || '';
  const scoreClass = score != null && score >= 7 ? 'high' : 'low';
  return (
    <div className="bookmarks-tab__curation-item">
      <div className="bookmarks-tab__curation-item-body">
        <div className="bookmarks-tab__curation-item-title" title={item.key}>
          {title}
        </div>
        <div className="bookmarks-tab__curation-item-meta">
          {topic}
          {created ? ` · ${created}` : ''}
          {status ? ` · ${status}` : ''}
        </div>
      </div>
      {score != null ? (
        <span className={`bookmarks-tab__score-pill bookmarks-tab__score-pill--${scoreClass}`}>
          {score.toFixed(1)}
        </span>
      ) : null}
    </div>
  );
}