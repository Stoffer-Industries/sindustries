import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card } from '@sindustries/ui/react';
import { loadBookmarkState } from '../bookmarkStateSource.js';
import {
  curationGroups,
  formatRelativeAge,
  funnelRows,
  itemList,
  itemByKey,
  kpiCounts,
  availableTopics,
  pendingApprovals,
  recentTransitions,
  sankeyNodesAndLinks,
  stateCountsTimeSeries,
  topicCounts
} from '../bookmarkPipeline.js';
import { BookmarksPendingApprovals } from './BookmarksPendingApprovals.jsx';
import { BookmarksFunnelList } from './BookmarksFunnelList.jsx';
import { BookmarksCurationsCard } from './BookmarksCurationsCard.jsx';
import { BookmarksTopicsCard } from './BookmarksTopicsCard.jsx';
import { BookmarksTransitionsCard } from './BookmarksTransitionsCard.jsx';
import { BookmarksKpiRow } from './BookmarksKpiRow.jsx';
import { BookmarksSankeyCard } from './BookmarksSankeyCard.jsx';
import { BookmarksStateCountsCard } from './BookmarksStateCountsCard.jsx';
import { BookmarksToolbar } from './BookmarksToolbar.jsx';

const ALL_TOPICS = 'all';
const DEFAULT_WINDOW = '30';

function relativeAge(iso) {
  return formatRelativeAge(iso, new Date());
}

export function BookmarksTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowValue, setWindowValue] = useState(DEFAULT_WINDOW);
  const [topic, setTopic] = useState(ALL_TOPICS);
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
  const curations = useMemo(() => curationGroups(items, scope), [items, scope]);
  const funnel = useMemo(() => funnelRows(items), [items]);
  const topicCountsRows = useMemo(() => topicCounts(items, scope), [items, scope]);
  const recent = useMemo(
    () => recentTransitions(transitions, byKey, { ...scope, limit: 20 }),
    [transitions, byKey, scope]
  );
  const pending = useMemo(() => pendingApprovals(snapshot), [snapshot]);
  const sankey = useMemo(() => sankeyNodesAndLinks(items), [items]);
  const timeSeries = useMemo(
    () => stateCountsTimeSeries(items, transitions, { topic, windowValue }),
    [items, transitions, topic, windowValue]
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
        onTopicChange={setTopic}
        topics={topics}
        onRefresh={reload}
      />

      <BookmarksPendingApprovals pending={pending} relativeAge={relativeAge} />
      <BookmarksKpiRow kpis={kpis} />
      <BookmarksCurationsCard curations={curations} relativeAge={relativeAge} />
      <BookmarksSankeyCard
        sankey={sankey}
        sankeyExpanded={sankeyExpanded}
        onToggle={() => setSankeyExpanded((prev) => !prev)}
      />

      <div className="bookmarks-tab__two-col" data-testid="pulse-bookmarks-funnel-topics">
        <BookmarksFunnelList funnel={funnel} />
        <BookmarksTopicsCard topicCountsRows={topicCountsRows} />
      </div>

      <BookmarksStateCountsCard timeSeries={timeSeries} />
      <BookmarksTransitionsCard recent={recent} />
    </section>
  );
}