import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card } from '@sindustries/ui/react';
import { loadBookmarkState } from '../bookmarkStateSource.js';
import {
  formatRelativeAge,
  curationGroups,
  funnelRows,
  itemList,
  itemByKey,
  kpiCounts,
  pendingApprovals,
  recentTransitions,
  topicCounts,
  availableTopics,
  sankeyNodesAndLinks,
  stateCountsTimeSeries
} from '../bookmarkPipeline.js';
import { BookmarksToolbar } from './BookmarksToolbar.jsx';
import { BookmarksPendingApprovals } from './BookmarksPendingApprovals.jsx';
import { BookmarksKpiRow } from './BookmarksKpiRow.jsx';
import { BookmarksCurationsGrid } from './BookmarksCurationsGrid.jsx';
import { BookmarksSankeyChart } from './BookmarksSankeyChart.jsx';
import { BookmarksFunnelList } from './BookmarksFunnelList.jsx';
import { BookmarksStatesOverTimeChart } from './BookmarksStatesOverTimeChart.jsx';
import { BookmarksRecentTransitions } from './BookmarksRecentTransitions.jsx';

const DEFAULT_WINDOW = '30';

function relativeAge(iso) {
  return formatRelativeAge(iso, new Date());
}

export function BookmarksTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowValue, setWindowValue] = useState(DEFAULT_WINDOW);
  const [topic, setTopic] = useState('all');
  const [loadedAt, setLoadedAt] = useState(null);
  const [sankeyExpanded, setSankeyExpanded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await loadBookmarkState();
      setData({ snapshot: next.snapshot, transitions: next.transitions });
      setLoadedAt(next.loadedAt);
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;
    const load = async () => {
      if (cancelled && !firstLoad) return;
      await reload();
      firstLoad = false;
    };
    load();
    const onFocus = () => {
      // Re-fetch on window focus so operators see updates without hitting
      // the Refresh button (per the tech design's auto-refresh strategy).
      reload();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  const snapshot = data?.snapshot ?? null;
  const transitions = data?.transitions ?? [];
  const items = useMemo(() => itemList(snapshot), [snapshot]);
  const byKey = useMemo(() => itemByKey(snapshot), [snapshot]);
  const topics = useMemo(() => availableTopics(items), [items]);

  const scope = useMemo(() => ({ topic, windowValue }), [topic, windowValue]);

  const kpis = useMemo(() => kpiCounts(items), [items]);
  const curations = useMemo(
    () => curationGroups(items, scope),
    [items, scope]
  );
  const funnel = useMemo(() => funnelRows(items), [items]);
  const topicCountsRows = useMemo(
    () => topicCounts(items, scope),
    [items, scope]
  );
  const recent = useMemo(
    () => recentTransitions(transitions, byKey, { ...scope, limit: 20 }),
    [transitions, byKey, scope]
  );
  const pending = useMemo(() => pendingApprovals(snapshot), [snapshot]);
  const sankey = useMemo(() => sankeyNodesAndLinks(items), [items]);
  const timeSeries = useMemo(
    () => stateCountsTimeSeries(items, transitions, scope),
    [items, transitions, scope]
  );

  if (error) {
    return (
      <section className="bookmarks-tab" data-testid="pulse-bookmarks-error">
        <header className="bookmarks-tab__header">
          <h1 className="bookmarks-tab__title">Bookmarks pipeline</h1>
          <p className="bookmarks-tab__subtitle">
            Bookmark pipeline state, sourced from the workspace
            <code> brain/state/</code> directory.
          </p>
        </header>
        <Card data-testid="pulse-bookmarks-error-card">
          <strong>Could not load bookmark state.</strong>
          <div className="bookmarks-tab__error-detail">{error}</div>
          <Button variant="primary" onClick={reload} data-testid="pulse-bookmarks-retry">
            Retry
          </Button>
        </Card>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="bookmarks-tab" data-testid="pulse-bookmarks-loading">
        <header className="bookmarks-tab__header">
          <h1 className="bookmarks-tab__title">Bookmarks pipeline</h1>
        </header>
        <Card>Loading bookmark state…</Card>
      </section>
    );
  }

  return (
    <section className="bookmarks-tab" data-testid="pulse-bookmarks">
      <header className="bookmarks-tab__header">
        <h1 className="bookmarks-tab__title">Bookmarks pipeline</h1>
        <p className="bookmarks-tab__subtitle">
          Reads <code>brain/state/bookmark-review-state.json</code> +
          <code> bookmark-transitions.jsonl</code>
          {loadedAt ? <> · refreshed {relativeAge(loadedAt)} ago</> : null}
        </p>
      </header>

      <BookmarksToolbar
        windowValue={windowValue}
        onWindowChange={setWindowValue}
        topic={topic}
        topics={topics}
        onTopicChange={setTopic}
        onRefresh={reload}
      />

      <BookmarksPendingApprovals pending={pending} relativeAge={relativeAge} />

      <BookmarksKpiRow kpis={kpis} />

      <BookmarksCurationsGrid curations={curations} relativeAge={relativeAge} />

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
            onClick={() => setSankeyExpanded((prev) => !prev)}
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

      <BookmarksFunnelList funnel={funnel} topicCountsRows={topicCountsRows} />

      <Card data-testid="pulse-bookmarks-state-chart">
        <h2 className="bookmarks-tab__section-title">State counts over time</h2>
        <p className="bookmarks-tab__section-subtitle">
          X: date · Y: bookmark count · one line per state. Historical counts are
          reconstructed from the JSONL transition log.
        </p>
        <BookmarksStatesOverTimeChart timeSeries={timeSeries} />
      </Card>

      <BookmarksRecentTransitions recent={recent} />
    </section>
  );
}
