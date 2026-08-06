import React from 'react';
import { Button, Card } from '@sindustries/ui/react';
import { BookmarksSankeyChart } from './BookmarksSankeyChart.jsx';

export function BookmarksSankeyCard({ sankey, sankeyExpanded, onToggle }) {
  return (
    <Card data-testid="pulse-bookmarks-sankey">
      <header className="bookmarks-tab__sankey-header">
        <div>
          <h2 className="bookmarks-tab__section-title">Curation Pipeline Flow</h2>
          <p className="bookmarks-tab__section-subtitle">
            From summarization through curator verdict → spec generation → Tom's
            decision. Cumulative pass-through keeps every link visible.
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={onToggle}
          data-testid="pulse-bookmarks-sankey-toggle"
        >
          {sankeyExpanded ? 'Collapse' : 'Expand'}
        </Button>
      </header>
      {sankeyExpanded ? (
        <BookmarksSankeyChart sankey={sankey} />
      ) : (
        <div className="bookmarks-tab__sankey-collapsed">
          Collapsed. Click Expand to render the Sankey diagram.
        </div>
      )}
    </Card>
  );
}