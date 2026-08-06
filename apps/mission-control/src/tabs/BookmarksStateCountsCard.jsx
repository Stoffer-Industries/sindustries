import React from 'react';
import { Card } from '@sindustries/ui/react';
import { BookmarksStatesOverTimeChart } from './BookmarksStatesOverTimeChart.jsx';

export function BookmarksStateCountsCard({ timeSeries }) {
  return (
    <Card data-testid="pulse-bookmarks-state-chart">
      <h2 className="bookmarks-tab__section-title">State counts over time</h2>
      <p className="bookmarks-tab__section-subtitle">
        X: date · Y: bookmark count · one line per state. Historical counts are
        reconstructed from the JSONL transition log.
      </p>
      <BookmarksStatesOverTimeChart timeSeries={timeSeries} />
    </Card>
  );
}