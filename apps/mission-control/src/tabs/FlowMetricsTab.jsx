import React, { useEffect, useMemo, useState } from 'react';
import {
  Card,
  CardContainer,
  Field,
  Select
} from '@sindustries/ui/react';
import { fetchAllTasks } from '../tasksApi.js';
import {
  cycleTimeSummary,
  weeklyThroughput,
  weeklyBacklogSize,
  weeklyRollingP90,
  wipByStatus,
  availableAssignees,
  availableTags,
  filterTasks
} from '../flowMetrics.js';

const CHART_W = 600;
const CHART_H = 160;
const PAD = { top: 16, right: 16, bottom: 32, left: 44 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

/**
 * Inline SVG area/line chart for time-series data. Handles null values
 * in the series by drawing separate line+area segments across the gaps.
 *
 * Props:
 *   points     — array of data objects
 *   getValue   — (point) => number | null
 *   getLabel   — (point) => string  (x-axis label)
 *   yUnit      — optional string appended to y-axis tick values (e.g. "d")
 *   emptyText  — shown when all values are null
 */
function AreaChart({
  points,
  getValue,
  getLabel,
  yUnit,
  emptyText,
  gradientId = 'si-area-gradient'
}) {
  const values = points.map(getValue).filter((v) => v != null);
  if (values.length === 0) {
    return (
      <div className="flow-metrics__empty">{emptyText}</div>
    );
  }

  const max = Math.max(1, ...values);
  const n = points.length;
  const plotBottom = PAD.top + PLOT_H;

  const coords = points.map((p, i) => {
    const v = getValue(p);
    return {
      x: PAD.left + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W),
      y: v == null ? null : PAD.top + (1 - v / max) * PLOT_H,
      value: v,
      label: getLabel(p),
    };
  });

  // Split into continuous segments (gap at each null)
  const segments = [];
  let current = [];
  for (const pt of coords) {
    if (pt.y == null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(pt);
    }
  }
  if (current.length > 0) segments.push(current);

  // Y-axis grid lines at 0 %, 50 %, 100 %
  const gridLines = [0, 0.5, 1].map((frac) => ({
    y: PAD.top + (1 - frac) * PLOT_H,
    label: yUnit
      ? `${Math.round(max * frac * 10) / 10}${yUnit}`
      : String(Math.round(max * frac)),
  }));

  // X-axis: label every other point so they don't crowd (show MM-DD)
  const xLabels = coords.filter((_, i) => i % 2 === 0 || i === n - 1);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      aria-hidden="true"
    >
      {/* Gradient definition for the area fill — top fades to transparent at baseline */}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--si-color-accent, #4c8bf5)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--si-color-accent, #4c8bf5)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Baseline (x-axis) so the area is visibly anchored */}
      <line
        x1={PAD.left}
        y1={plotBottom}
        x2={PAD.left + PLOT_W}
        y2={plotBottom}
        stroke="var(--si-color-text-muted, #666)"
        strokeWidth="1"
      />

      {/* Y-axis grid lines + labels */}
      {gridLines.map((gl) => (
        <g key={gl.label}>
          <line
            x1={PAD.left}
            y1={gl.y}
            x2={PAD.left + PLOT_W}
            y2={gl.y}
            stroke="var(--si-color-border, #e5e5e5)"
            strokeWidth="1"
          />
          <text
            x={PAD.left - 6}
            y={gl.y}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="10"
            fill="var(--si-color-text-muted, #666)"
          >
            {gl.label}
          </text>
        </g>
      ))}

      {/* Area fills */}
      {segments.map((seg, si) => {
        if (seg.length < 2) return null;
        const areaD = [
          `M ${seg[0].x},${seg[0].y}`,
          ...seg.slice(1).map((pt) => `L ${pt.x},${pt.y}`),
          `L ${seg[seg.length - 1].x},${plotBottom}`,
          `L ${seg[0].x},${plotBottom}`,
          'Z',
        ].join(' ');
        return (
          <path
            key={si}
            d={areaD}
            fill={`url(#${gradientId})`}
          />
        );
      })}

      {/* Lines */}
      {segments.map((seg, si) => {
        if (seg.length < 2) return null;
        const lineD = [
          `M ${seg[0].x},${seg[0].y}`,
          ...seg.slice(1).map((pt) => `L ${pt.x},${pt.y}`),
        ].join(' ');
        return (
          <path
            key={si}
            d={lineD}
            fill="none"
            stroke="var(--si-color-accent, #4c8bf5)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}

      {/* Data point dots */}
      {coords
        .filter((pt) => pt.y != null)
        .map((pt) => (
          <circle
            key={pt.label}
            cx={pt.x}
            cy={pt.y}
            r="3"
            fill="var(--si-color-accent, #4c8bf5)"
          />
        ))}

      {/* X-axis labels (MM-DD only) */}
      {xLabels.map((pt) => (
        <text
          key={pt.label}
          x={pt.x}
          y={plotBottom + 18}
          textAnchor="middle"
          fontSize="9"
          fill="var(--si-color-text-muted, #666)"
        >
          {pt.label.slice(5)}
        </text>
      ))}
    </svg>
  );
}

export function FlowMetricsTab() {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [assignee, setAssignee] = useState('All assignees');
  const [tag, setTag] = useState('All tags');

  useEffect(() => {
    let cancelled = false;
    fetchAllTasks()
      .then((data) => {
        if (cancelled) return;
        setTasks(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const now = useMemo(() => new Date(), []);

  const filtered = useMemo(() => {
    if (!tasks) return [];
    return filterTasks(tasks, { assignee, tag });
  }, [tasks, assignee, tag]);

  const cycle = useMemo(
    () => (tasks ? cycleTimeSummary(filtered, now) : null),
    [tasks, filtered, now]
  );

  const throughput = useMemo(
    () => (tasks ? weeklyThroughput(filtered, now, 16) : []),
    [tasks, filtered, now]
  );

  const wip = useMemo(
    () => (tasks ? wipByStatus(filtered) : null),
    [tasks, filtered]
  );

  const backlog = useMemo(
    () => (tasks ? weeklyBacklogSize(filtered, now, 16) : []),
    [tasks, filtered, now]
  );

  const p90Series = useMemo(
    () => (tasks ? weeklyRollingP90(filtered, now, 16) : []),
    [tasks, filtered, now]
  );

  const assignees = useMemo(() => (tasks ? availableAssignees(tasks) : []), [tasks]);
  const tags = useMemo(() => (tasks ? availableTags(tasks) : []), [tasks]);

  if (error) {
    return (
      <section className="flow-metrics" data-testid="flow-metrics-error">
        <header className="flow-metrics__header">
          <h1 className="flow-metrics__title">Flow metrics</h1>
          <p className="flow-metrics__subtitle">
            Engineering flow metrics, sourced from the existing Tasks API.
          </p>
        </header>
        <div className="flow-metrics__error" role="alert">
          Could not load tasks: {error}
        </div>
      </section>
    );
  }

  if (!tasks) {
    return (
      <section className="flow-metrics" data-testid="flow-metrics-loading">
        <p>Loading flow metrics…</p>
      </section>
    );
  }

  const throughputMax = Math.max(1, ...throughput.map((w) => w.doneCount));
  const wipValues = wip ? Object.values(wip) : [0];
  const wipMax = Math.max(1, ...wipValues);

  return (
    <section className="flow-metrics" data-testid="flow-metrics">
      <header className="flow-metrics__header">
        <h1 className="flow-metrics__title">Flow metrics</h1>
        <p className="flow-metrics__subtitle">
          Engineering flow metrics, sourced from the existing Tasks API. No new
          backend service or database.
        </p>
      </header>

      <div className="flow-metrics__filters" data-testid="flow-metrics-filters">
        <Field label="Assignee">
          <Select
            aria-label="Filter by assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="All assignees">All assignees</option>
            {assignees.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tag">
          <Select
            aria-label="Filter by tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="All tags">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <CardContainer data-testid="flow-metrics-cards">
        <Card>
          <div className="flow-metrics__card-label">Median cycle time</div>
          <div className="flow-metrics__card-value" data-testid="metric-cycle-median">
            {cycle?.medianDays == null ? '—' : `${cycle.medianDays} d`}
          </div>
        </Card>
        <Card>
          <div className="flow-metrics__card-label">P90 cycle time</div>
          <div className="flow-metrics__card-value" data-testid="metric-cycle-p90">
            {cycle?.p90Days == null ? '—' : `${cycle.p90Days} d`}
          </div>
        </Card>
        <Card>
          <div className="flow-metrics__card-label">Tasks counted (30d)</div>
          <div className="flow-metrics__card-value" data-testid="metric-cycle-count">
            {cycle?.count ?? 0}
          </div>
        </Card>
      </CardContainer>

      <div className="flow-metrics__chart" data-testid="flow-metrics-throughput">
        <div className="flow-metrics__chart-title">Weekly throughput (16 weeks)</div>
        {throughput.every((w) => w.doneCount === 0) ? (
          <div className="flow-metrics__empty">No tasks completed in the last 16 weeks.</div>
        ) : (
          throughput.map((w) => (
            <div key={w.weekStart} className="flow-metrics__bar-row">
              <div>{w.weekStart}</div>
              <div className="flow-metrics__bar-track">
                <div
                  className="flow-metrics__bar-fill"
                  style={{ width: `${(w.doneCount / throughputMax) * 100}%` }}
                />
              </div>
              <div>{w.doneCount}</div>
            </div>
          ))
        )}
      </div>

      <div className="flow-metrics__chart" data-testid="flow-metrics-wip">
        <div className="flow-metrics__chart-title">WIP by status</div>
        {wip &&
          ['open', 'ready', 'doing', 'acceptance'].map((s) => (
            <div key={s} className="flow-metrics__bar-row">
              <div>{s}</div>
              <div className="flow-metrics__bar-track">
                <div
                  className="flow-metrics__bar-fill"
                  style={{ width: `${(wip[s] / wipMax) * 100}%` }}
                />
              </div>
              <div>{wip[s]}</div>
            </div>
          ))}
      </div>

      <div className="flow-metrics__chart" data-testid="flow-metrics-backlog">
        <div className="flow-metrics__chart-title">Backlog size over time (16 weeks)</div>
        <AreaChart
          points={backlog}
          getValue={(p) => p.backlogCount}
          getLabel={(p) => p.weekStart}
          emptyText="No backlog data in the last 16 weeks."
        />
      </div>

      <div className="flow-metrics__chart" data-testid="flow-metrics-p90">
        <div className="flow-metrics__chart-title">P90 cycle time over time — 4-week rolling (days)</div>
        <AreaChart
          points={p90Series}
          getValue={(p) => p.p90Days}
          getLabel={(p) => p.weekStart}
          yUnit="d"
          emptyText="Not enough completions to compute P90 (need ≥ 3 per 4-week window)."
        />
      </div>
    </section>
  );
}
