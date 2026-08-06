import React from 'react';
import { Card } from '@sindustries/ui/react';
import { BookmarksCurationItemRow } from './BookmarksCurationItemRow.jsx';

export function BookmarksCurationsCard({ curations, relativeAge }) {
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
                  <BookmarksCurationItemRow
                    key={item.key}
                    item={item}
                    relativeAge={relativeAge}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}