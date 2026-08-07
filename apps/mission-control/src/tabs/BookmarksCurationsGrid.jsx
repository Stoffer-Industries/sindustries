import React from 'react';
import { Card } from '@sindustries/ui/react';

function CurationItemRow({ item, relativeAge }) {
  const c = item.curation;
  const title = item.title || item.key;
  const topic = c?.topic || item.topic || 'general';
  const score = c ? Number(c.score || 0) : null;
  const created = c?.createdAt && relativeAge ? relativeAge(c.createdAt) + ' ago' : '';
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

export function BookmarksCurationsGrid({ curations, relativeAge }) {
  const blocks = [
    {
      key: 'implementBound',
      label: 'Curated: High Signal',
      tone: 'implement-bound',
      hint: `curator said yes (score ≥ ${curations.threshold})`,
      items: curations.implementBound
    },
    {
      key: 'curatedWaiting',
      label: 'Monitoring',
      tone: 'curated-waiting',
      hint: `curator said not now (score < ${curations.threshold})`,
      items: curations.curatedWaiting
    },
    {
      key: 'uncurated',
      label: 'Uncurated',
      tone: 'uncurated',
      hint: 'no verdict yet — heartbeat will curate on next pass',
      items: curations.uncurated
    }
  ];
  return (
    <Card data-testid="pulse-bookmarks-curations">
      <h2 className="bookmarks-tab__section-title">Curations</h2>
      <p className="bookmarks-tab__section-subtitle">
        Verdicts on each summary. The heartbeat keeps these fresh by re-curating
        any summary whose verdict is older than the re-curation window.
      </p>
      <div className="bookmarks-tab__curation-grid">
        {blocks.map((block) => (
          <div key={block.key} className="bookmarks-tab__curation-block">
            <div
              className={`bookmarks-tab__curation-header bookmarks-tab__curation-header--${block.tone}`}
            >
              <span>
                {block.label}
                <span className="bookmarks-tab__curation-hint">{block.hint}</span>
              </span>
              <span className="bookmarks-tab__curation-count">{block.items.length}</span>
            </div>
            <div className="bookmarks-tab__curation-items">
              {block.items.length === 0 ? (
                <div className="bookmarks-tab__empty">No items in this group.</div>
              ) : (
                block.items.slice(0, 30).map((item) => (
                  <CurationItemRow key={item.key} item={item} relativeAge={relativeAge} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
