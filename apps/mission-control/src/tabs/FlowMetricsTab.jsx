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
  const backlogMax = Math.max(1, ...backlog.map((p) => p.backlogCount));
  const p90Values = p90Series.map((p) => p.p90Days).filter((v) => v != null);
  const p90Max = Math.max(1, ...p90Values);

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
        {backlog.every((p) => p.backlogCount === 0) ? (
          <div className="flow-metrics__empty">No backlog data in the last 16 weeks.</div>
        ) : (
          backlog.map((p) => (
            <div key={p.weekStart} className="flow-metrics__bar-row">
              <div>{p.weekStart}</div>
              <div className="flow-metrics__bar-track">
                <div
                  className="flow-metrics__bar-fill"
                  style={{ width: `${(p.backlogCount / backlogMax) * 100}%` }}
                />
              </div>
              <div>{p.backlogCount}</div>
            </div>
          ))
        )}
      </div>

      <div className="flow-metrics__chart" data-testid="flow-metrics-p90">
        <div className="flow-metrics__chart-title">P90 cycle time over time — 4-week rolling (days)</div>
        {p90Values.length === 0 ? (
          <div className="flow-metrics__empty">Not enough completions to compute P90 (need ≥ 3 per 4-week window).</div>
        ) : (
          p90Series.map((p) => (
            <div key={p.weekStart} className="flow-metrics__bar-row">
              <div>{p.weekStart}</div>
              <div className="flow-metrics__bar-track">
                {p.p90Days != null ? (
                  <div
                    className="flow-metrics__bar-fill"
                    style={{ width: `${(p.p90Days / p90Max) * 100}%` }}
                  />
                ) : (
                  <div className="flow-metrics__bar-fill" style={{ width: '0%' }} />
                )}
              </div>
              <div>{p.p90Days != null ? `${p.p90Days}d` : '—'}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
