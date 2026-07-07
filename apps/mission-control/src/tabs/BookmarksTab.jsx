import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContainer, Field, Select } from '@sindustries/ui/react';
import { loadBookmarkState } from '../bookmarkStateSource.js';
import {
  DEFAULT_TIME_WINDOWS,
  curationGroups,
  formatRelativeAge,
  funnelRows,
  itemList,
  kpiCounts,
  pendingApprovals,
  recentTransitions,
  topicCounts,
  availableTopics,
  itemByKey
} from '../bookmarkPipeline.js';

// Status color tokens. The standalone dashboard uses raw hex values for
// some legacy statuses that don't have a matching design-system token
// (Q6 in the tech design). We centralise them here so the tab inherits
// the design tokens where they exist and only deviates for legacy states.
const STATUS_COLOR_VAR = {
  pending: 'var(--si-color-graphite-500, #8aa0bd)',
  ingested: 'var(--si-color-graphite-500, #8aa0bd)',
  summarized: 'var(--si-color-graphite-700, #5a6b83)',
  monitoring: 'var(--si-color-brand-700, #b46a00)',
  curated_implement: 'var(--si-color-info-500, #2f75d6)',
  spec_requested: 'var(--si-color-accent-500, #5e3f8a)',
  spec_created: 'var(--si-color-accent-500, #bd1e66)',
  revision_staged: '#7254bd',
  approval_pending: 'var(--si-color-accent-500, #d9257a)',
  tasked: 'var(--si-color-success-500, #148f46)',
  approved: 'var(--si-color-success-500, #0f9b59)',
  declined: 'var(--si-color-danger-500, #a3312b)',
  reviewed: 'var(--si-color-neutral-200, #c8d0db)',
  summarised: 'var(--si-color-neutral-200, #c8d0db)',
  queued_for_spec: 'var(--si-color-neutral-200, #c8d0db)'
};

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

  const funnelMax = Math.max(1, ...funnel.map((row) => row.count));
  const topicMax = Math.max(1, ...topicCountsRows.map((row) => row.count));

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

      <div className="bookmarks-tab__toolbar" data-testid="pulse-bookmarks-toolbar">
        <Field label="Time window">
          <Select
            aria-label="Time window"
            value={windowValue}
            onChange={(e) => setWindowValue(e.target.value)}
          >
            {DEFAULT_TIME_WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Topic">
          <Select
            aria-label="Topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          >
            <option value={ALL_TOPICS}>All</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="primary"
          onClick={reload}
          data-testid="pulse-bookmarks-refresh"
        >
          Refresh
        </Button>
      </div>

      {pending.length > 0 ? (
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
      ) : null}

      <CardContainer data-testid="pulse-bookmarks-kpis">
        {Object.entries(kpis)
          .filter(([, count]) => count > 0)
          .map(([status, count]) => (
            <Card key={status} data-testid={`pulse-bookmarks-kpi-${status}`}>
              <div className="bookmarks-tab__kpi-label">{status}</div>
              <div
                className="bookmarks-tab__kpi-value"
                style={{ color: STATUS_COLOR_VAR[status] ?? 'var(--si-color-text, #111)' }}
              >
                {count}
              </div>
              <div className="bookmarks-tab__kpi-note">
                {status === 'pending' ? 'watch this' : 'current'}
              </div>
            </Card>
          ))}
      </CardContainer>

      <Card data-testid="pulse-bookmarks-curations">
        <h2 className="bookmarks-tab__section-title">Curations</h2>
        <p className="bookmarks-tab__section-subtitle">
          Verdicts on each summary. The heartbeat keeps these fresh by re-curating
          any summary whose verdict is older than the re-curation window.
        </p>
        <div className="bookmarks-tab__curation-grid">
          {[
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
          ].map((block) => (
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
                    <CurationItemRow key={item.key} item={item} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="bookmarks-tab__two-col" data-testid="pulse-bookmarks-funnel-topics">
        <Card data-testid="pulse-bookmarks-funnel">
          <h2 className="bookmarks-tab__section-title">Pipeline funnel</h2>
          <p className="bookmarks-tab__section-subtitle">
            How far each bookmark gets. Counts in the selected time window.
          </p>
          <div className="bookmarks-tab__funnel">
            {funnel.length === 0 ? (
              <div className="bookmarks-tab__empty">No items match the current filters.</div>
            ) : (
              funnel.map((row) => (
                <div key={row.status} className="bookmarks-tab__funnel-row">
                  <div className="bookmarks-tab__funnel-label">{row.status}</div>
                  <div className="bookmarks-tab__funnel-track">
                    <div
                      className="bookmarks-tab__funnel-bar"
                      style={{
                        width: `${(row.count / funnelMax) * 100}%`,
                        background: STATUS_COLOR_VAR[row.status] ?? 'var(--si-color-text, #111)'
                      }}
                    />
                  </div>
                  <div className="bookmarks-tab__funnel-count">{row.count}</div>
                </div>
              ))
            )}
          </div>
        </Card>

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
      </div>

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
    </section>
  );
}

function CurationItemRow({ item }) {
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