import React, { useEffect, useRef, useState } from 'react';
import { STATUS_COLOR_VAR } from '../bookmarkPipeline.js';

export function BookmarksStatesOverTimeChart({ timeSeries }) {
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
