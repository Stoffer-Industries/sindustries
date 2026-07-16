import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card } from '@sindustries/ui/react';
import { sankey as d3Sankey, sankeyLinkHorizontal, sankeyLeft } from 'd3-sankey';
import { loadBookmarkState } from '../bookmarkStateSource.js';
import {
  DEFAULT_TIME_WINDOWS,
  STATUS_COLOR_VAR,
  curationGroups,
  formatRelativeAge,
  formatTimeSeriesDate,
  funnelRows,
  itemList,
  kpiCounts,
  pendingApprovals,
  recentTransitions,
  topicCounts,
  availableTopics,
  itemByKey,
  sankeyNodesAndLinks,
  stateCountsTimeSeries
} from '../bookmarkPipeline.js';

const ALL_TOPICS = 'all';
const DEFAULT_WINDOW = '30';
const SANKEY_HEIGHT = 300;
const SANKEY_PADDING = { top: 20, right: 168, bottom: 20, left: 10 };

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

      <div
        className="bookmarks-tab__kpis"
        data-testid="pulse-bookmarks-kpi-row"
      >
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
      </div>

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
          <SankeySection sankey={sankey} />
        ) : (
          <div className="bookmarks-tab__sankey-collapsed">
            Collapsed. Click Expand to render the Sankey diagram.
          </div>
        )}
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

      <Card data-testid="pulse-bookmarks-state-chart">
        <h2 className="bookmarks-tab__section-title">State counts over time</h2>
        <p className="bookmarks-tab__section-subtitle">
          X: date · Y: bookmark count · one line per state. Historical counts are
          reconstructed from the JSONL transition log.
        </p>
        <StateCountsChart timeSeries={timeSeries} />
      </Card>

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

function SankeySection({ sankey }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth || 800;
      setWidth(Math.max(360, w));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener('resize', measure);
      return () => {
        ro.disconnect();
        window.removeEventListener('resize', measure);
      };
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  if (!sankey || !sankey.nodes.length) {
    return (
      <div
        ref={containerRef}
        className="bookmarks-tab__sankey-wrap"
        data-testid="pulse-bookmarks-sankey-empty"
      >
        Not enough data to render.
      </div>
    );
  }

  const innerWidth = Math.max(1, width - SANKEY_PADDING.left - SANKEY_PADDING.right);
  const innerHeight = SANKEY_HEIGHT - SANKEY_PADDING.top - SANKEY_PADDING.bottom;
  const layout = d3Sankey()
    .nodeWidth(18)
    .nodePadding(22)
    .extent([
      [SANKEY_PADDING.left, SANKEY_PADDING.top],
      [SANKEY_PADDING.left + innerWidth, SANKEY_PADDING.top + innerHeight]
    ])
    .nodeAlign(sankeyLeft);

  // d3-sankey mutates its input nodes, so we deep-clone before layout
  // to keep the data source stable for subsequent renders.
  const inputNodes = sankey.nodes.map((n) => ({ ...n }));
  const inputLinks = sankey.links.map((l) => ({ ...l }));
  const { nodes, links } = layout({
    nodes: inputNodes,
    links: inputLinks.map((l, i) => ({
      ...l,
      source: typeof l.source === 'object' ? sankey.nodes.indexOf(l.source) : i,
      target: typeof l.target === 'object' ? sankey.nodes.indexOf(l.target) : i
    }))
  });

  return (
    <div
      ref={containerRef}
      className="bookmarks-tab__sankey-wrap"
      data-testid="pulse-bookmarks-sankey-chart"
    >
      <svg
        role="presentation"
        aria-hidden="true"
        viewBox={`0 0 ${width} ${SANKEY_HEIGHT}`}
        width={width}
        height={SANKEY_HEIGHT}
      >
        <defs>
          {links.map((link, i) => (
            <linearGradient
              key={i}
              id={`sankey-grad-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={link.source.x1}
              x2={link.target.x0}
            >
              <stop offset="0%" stopColor={link.source.color} />
              <stop offset="100%" stopColor={link.target.color} />
            </linearGradient>
          ))}
        </defs>
        <g>
          {links.map((link, i) => (
            <path
              key={i}
              d={sankeyLinkHorizontal()(link)}
              fill="none"
              stroke={`url(#sankey-grad-${i})`}
              strokeOpacity={0.25}
              strokeWidth={Math.max(1, link.width)}
              data-testid={`pulse-bookmarks-sankey-link-${link.source.name}-${link.target.name}`}
            >
              <title>{`${link.source.name} → ${link.target.name}: ${link.value}`}</title>
            </path>
          ))}
        </g>
        <g>
          {nodes.map((node) => (
            <g key={node.name}>
              <rect
                x={node.x0}
                y={node.y0}
                width={node.x1 - node.x0}
                height={Math.max(1, node.y1 - node.y0)}
                fill={node.color}
                rx={3}
                data-testid={`pulse-bookmarks-sankey-node-${node.name}`}
              />
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 - 10}
                dy="0.35em"
                textAnchor="start"
                fontSize={12}
                fontWeight={700}
                fill="var(--si-color-text, #111)"
              >
                {node.name}
              </text>
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 + 2}
                dy="0.35em"
                textAnchor="start"
                fontSize={10}
                fill="var(--si-color-text-muted, #6f819b)"
              >
                {`${node.count} items`}
              </text>
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 + 14}
                dy="0.35em"
                textAnchor="start"
                fontSize={10}
                fill="var(--si-color-text-muted, #9aaabb)"
              >
                {(() => {
                  const inFlow = node.targetLinks.reduce((s, l) => s + l.value, 0);
                  const outFlow = node.sourceLinks.reduce((s, l) => s + l.value, 0);
                  if (!inFlow) return `out: ${outFlow}`;
                  if (!outFlow) return `in: ${inFlow}`;
                  return `in: ${inFlow}  out: ${outFlow}`;
                })()}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function StateCountsChart({ timeSeries }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth || 800;
      setWidth(Math.max(360, w));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener('resize', measure);
      return () => {
        ro.disconnect();
        window.removeEventListener('resize', measure);
      };
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  if (!timeSeries || timeSeries.points.length === 0 || timeSeries.statuses.length === 0) {
    return (
      <div
        ref={containerRef}
        className="bookmarks-tab__state-chart-wrap"
        data-testid="pulse-bookmarks-state-chart-empty"
      >
        No data.
      </div>
    );
  }

  const { statuses, points } = timeSeries;
  const height = 240;
  const pad = { left: 42, right: 18, top: 16, bottom: 34 };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = Math.max(1, height - pad.top - pad.bottom);
  const maxY = Math.max(
    1,
    ...points.flatMap((p) => statuses.map((s) => p.counts[s] || 0))
  );
  const xScale = (i) =>
    points.length === 1 ? pad.left : pad.left + (i * innerW) / (points.length - 1);
  const yScale = (v) => pad.top + innerH - (v / maxY) * innerH;

  const step = Math.max(1, Math.floor(points.length / 4));

  const handleMove = (event) => {
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const ratio = innerW === 0 ? 0 : (mx - pad.left) / innerW;
    const idx = Math.max(
      0,
      Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))
    );
    setHovered({ idx, x: event.clientX, y: event.clientY });
  };
  const handleLeave = () => setHovered(null);

  return (
    <div
      ref={containerRef}
      className="bookmarks-tab__state-chart-wrap"
      data-testid="pulse-bookmarks-state-chart-svg"
    >
      <svg
        role="presentation"
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        {/* Axes */}
        <line
          x1={pad.left}
          y1={height - pad.bottom}
          x2={width - pad.right}
          y2={height - pad.bottom}
          stroke="var(--si-color-border, #cbd6e5)"
        />
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={height - pad.bottom}
          stroke="var(--si-color-border, #cbd6e5)"
        />
        {[0, Math.ceil(maxY / 2), maxY].map((tick, i) => (
          <text
            key={`y-${i}-${tick}`}
            x={pad.left - 6}
            y={yScale(tick) + 4}
            textAnchor="end"
            fontSize={11}
            fill="var(--si-color-text-muted, #6f819b)"
          >
            {tick}
          </text>
        ))}
        {points.map((p, i) => {
          if (i % step !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={p.date}
              x={xScale(i)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : 'middle'}
              fontSize={11}
              fill="var(--si-color-text-muted, #6f819b)"
            >
              {p.date.slice(5)}
            </text>
          );
        })}
        {/* Lines (one per status) */}
        {statuses.map((status) => {
          const d = points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(p.counts[status] || 0)}`)
            .join(' ');
          return (
            <path
              key={status}
              d={d}
              fill="none"
              stroke={STATUS_COLOR_VAR[status] ?? 'var(--si-color-text, #111)'}
              strokeWidth={2.5}
              data-testid={`pulse-bookmarks-state-chart-line-${status}`}
            >
              <title>{status}</title>
            </path>
          );
        })}
        {/* Crosshair */}
        {hovered ? (
          <line
            x1={xScale(hovered.idx)}
            x2={xScale(hovered.idx)}
            y1={pad.top}
            y2={height - pad.bottom}
            stroke="var(--si-color-border, #cbd6e5)"
            strokeDasharray="4,3"
          />
        ) : null}
        {/* Hit area for mouse events */}
        <rect
          x={pad.left}
          y={pad.top}
          width={innerW + pad.right}
          height={innerH}
          fill="transparent"
          pointerEvents="all"
        />
      </svg>
      <div className="bookmarks-tab__state-chart-legend" data-testid="pulse-bookmarks-state-chart-legend">
        {statuses.map((status) => (
          <span key={status} className="bookmarks-tab__state-chart-legend-item">
            <i
              className="bookmarks-tab__state-chart-swatch"
              style={{ background: STATUS_COLOR_VAR[status] ?? 'var(--si-color-text, #111)' }}
            />
            {status}
          </span>
        ))}
      </div>
      {hovered ? (
        <div
          className="bookmarks-tab__state-chart-tooltip"
          style={{
            left:
              hovered.x + 220 > (typeof window !== 'undefined' ? window.innerWidth : 1000)
                ? Math.max(8, hovered.x - 200)
                : hovered.x + 14,
            top: hovered.y - 10
          }}
          data-testid="pulse-bookmarks-state-chart-tooltip"
        >
          <div className="bookmarks-tab__state-chart-tooltip-date">
            {points[hovered.idx]?.date}
          </div>
          {statuses
            .filter((s) => points[hovered.idx]?.counts[s])
            .sort((a, b) => (points[hovered.idx].counts[b] || 0) - (points[hovered.idx].counts[a] || 0))
            .map((s) => (
              <div key={s} className="bookmarks-tab__state-chart-tooltip-row">
                <span>
                  <i
                    className="bookmarks-tab__state-chart-swatch"
                    style={{ background: STATUS_COLOR_VAR[s] ?? 'var(--si-color-text, #111)' }}
                  />
                  {s}
                </span>
                <span className="bookmarks-tab__state-chart-tooltip-val">
                  {points[hovered.idx].counts[s]}
                </span>
              </div>
            ))}
        </div>
      ) : null}
    </div>
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

function Field({ label, children, ...props }) {
  return (
    <label className="bookmarks-tab__field" {...props}>
      <span className="bookmarks-tab__field-label">{label}</span>
      {children}
    </label>
  );
}

function Select(props) {
  return <select {...props} className={`bookmarks-tab__select ${props.className ?? ''}`} />;
}