import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CardContainer, Field, Select, Textarea } from '@sindustries/ui/react';
import {
  approveItem,
  createItem,
  getTodayStatus,
  listItems,
  publishItem,
  removeItem,
  unapproveItem,
  updateItem
} from '../contentSchedulerApi.js';
import {
  SCHEDULER_TIME_ZONE,
  buildCalendarDays,
  dayDropBlocked,
  getAucklandDayKey,
  getAucklandTimeOfDay,
  groupItemsForCalendar,
  rescheduleIsoForDay
} from './contentSchedulerCalendar.js';

const ACTOR = 'Tom';

const SOURCES = [
  { value: 'ops_notes', label: 'Ops notes' },
  { value: 'cto_craft', label: 'CTO Craft' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Other' }
];

const STATUS_LABELS = {
  queued: 'Queued',
  approved: 'Approved',
  published: 'Published'
};

const STATUS_BADGE_VARIANT = {
  queued: 'neutral',
  approved: 'info',
  published: 'success'
};

const DROP_REFUSED_MESSAGE = 'Already has a published post — choose another day.';

function defaultScheduledFor() {
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  // Snap to nearest 5 minutes.
  const minutes = d.getMinutes();
  d.setMinutes(minutes - (minutes % 5));
  // datetime-local needs YYYY-MM-DDTHH:mm in local time.
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocal(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return '';
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

function dayStatusLabel(today) {
  if (!today) return '';
  if (today.publishedCount >= today.cap) {
    return `✓ ${today.publishedCount} / ${today.cap} posts published today (max reached)`;
  }
  return `✓ ${today.publishedCount} / ${today.cap} posts published today`;
}

function isPublishDisabled(item, today) {
  if (!item.approvedAt) return true;
  if (!today) return false;
  if (today.publishedCount >= today.cap && today.publishedItemId !== item.id) return true;
  return false;
}

function publishTooltip(item, today) {
  if (!item.approvedAt) return 'Approve before publishing (AC6).';
  if (today?.publishedCount >= today?.cap && today?.publishedItemId !== item.id) {
    return 'Max one X post per day — already published today.';
  }
  return '';
}

function SchedulerItemCard({
  item,
  today,
  onApprove,
  onUnapprove,
  onPublish,
  onRemove,
  onSave,
  onDragStart,
  isPublishedInCalendar
}) {
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(item.body);
  const [draftSchedule, setDraftSchedule] = useState(toDatetimeLocal(item.scheduledFor));

  useEffect(() => {
    setDraftBody(item.body);
    setDraftSchedule(toDatetimeLocal(item.scheduledFor));
  }, [item.body, item.scheduledFor]);

  const disabled = isPublishDisabled(item, today);
  const tip = publishTooltip(item, today);
  const published = item.status === 'published';
  const cardClass = `content-scheduler-row${published ? ' content-scheduler-row--published' : ''}`;

  return (
    <Card
      className={cardClass}
      data-testid={`content-scheduler-row-${item.id}`}
      data-item-id={item.id}
      data-status={item.status}
      draggable={!published}
      onDragStart={(e) => {
        if (published) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        onDragStart(item.id);
      }}
    >
      <div className="content-scheduler-row__body">
        {editing ? (
          <Field label="Body">
            <Textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              maxLength={1000}
              data-testid={`content-scheduler-edit-body-${item.id}`}
            />
          </Field>
        ) : (
          <p data-testid={`content-scheduler-body-${item.id}`}>{item.body}</p>
        )}
        <div className="content-scheduler-row__meta">
          <Badge
            variant={STATUS_BADGE_VARIANT[item.status] ?? 'neutral'}
            data-testid={`content-scheduler-status-${item.id}`}
          >
            {STATUS_LABELS[item.status] ?? item.status}
          </Badge>
          <span>Source: {item.source}</span>
          {item.scheduledFor && (
            <span data-testid={`content-scheduler-schedule-display-${item.id}`}>
              Scheduled: {getAucklandTimeOfDay(item.scheduledFor, SCHEDULER_TIME_ZONE)} {SCHEDULER_TIME_ZONE}
            </span>
          )}
          {item.approvedAt && <span>Approved by {item.approvedBy ?? 'unknown'} at {new Date(item.approvedAt).toLocaleString()}</span>}
          {item.publishedAt && (
            <span>
              Published at {new Date(item.publishedAt).toLocaleString()}
              {item.publishedUrl && (
                <>
                  {' '}
                  —{' '}
                  <a href={item.publishedUrl} target="_blank" rel="noreferrer">
                    view
                  </a>
                </>
              )}
            </span>
          )}
          {item.publishError && <span style={{ color: 'var(--si-color-danger-500, #a3312b)' }}>Publish error: {item.publishError}</span>}
          {isPublishedInCalendar && !published && (
            <span className="content-scheduler-row__published-day-hint">
              Published today — drop another day
            </span>
          )}
        </div>
        {editing && (
          <Field label="Scheduled for">
            <input
              type="datetime-local"
              value={draftSchedule}
              onChange={(e) => setDraftSchedule(e.target.value)}
              data-testid={`content-scheduler-edit-schedule-${item.id}`}
              className="si-input"
            />
          </Field>
        )}
      </div>
      <div className="content-scheduler-row__actions">
        {editing ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                await onSave(item.id, { body: draftBody, scheduledFor: fromDatetimeLocal(draftSchedule) });
                setEditing(false);
              }}
              data-testid={`content-scheduler-save-${item.id}`}
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {!published && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} data-testid={`content-scheduler-edit-${item.id}`}>
                Edit
              </Button>
            )}
            {item.status === 'queued' && (
              <Button variant="primary" size="sm" onClick={() => onApprove(item.id)} data-testid={`content-scheduler-approve-${item.id}`}>
                Approve
              </Button>
            )}
            {item.status === 'approved' && (
              <Button variant="ghost" size="sm" onClick={() => onUnapprove(item.id)} data-testid={`content-scheduler-unapprove-${item.id}`}>
                Unapprove
              </Button>
            )}
            {item.status !== 'published' && item.status !== 'removed' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onPublish(item.id)}
                disabled={disabled}
                title={tip}
                data-testid={`content-scheduler-publish-${item.id}`}
              >
                Publish
              </Button>
            )}
            {item.status !== 'published' && item.status !== 'removed' && (
              <Button variant="danger" size="sm" onClick={() => onRemove(item.id)} data-testid={`content-scheduler-remove-${item.id}`}>
                Remove
              </Button>
            )}
            {published && (
              <Badge variant="success" data-testid={`content-scheduler-published-${item.id}`}>
                Published
              </Badge>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function ContentSchedulerTab() {
  const [items, setItems] = useState(null);
  const [today, setToday] = useState(null);
  const [error, setError] = useState(null);
  const [body, setBody] = useState('');
  const [source, setSource] = useState('manual');
  const [scheduledFor, setScheduledFor] = useState(defaultScheduledFor());
  const [draggingItemId, setDraggingItemId] = useState(null);
  const [dragOverZone, setDragOverZone] = useState(null);
  const [dropError, setDropError] = useState(null); // { dayKey, message } | null

  const reload = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([listItems(), getTodayStatus()]);
      setItems(list ?? []);
      setToday(status);
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // AC6: refresh the queue + today-status every 10s while the tab is
  // mounted so auto-posted items (driven by the worker's delayed job)
  // show up in the UI within one refresh cycle. The interval is UI-only;
  // it does not drive publishing.
  useEffect(() => {
    const intervalId = setInterval(() => {
      reload();
    }, 10_000);
    return () => clearInterval(intervalId);
  }, [reload]);

  const days = useMemo(() => buildCalendarDays(new Date(), SCHEDULER_TIME_ZONE), [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const grouped = useMemo(() => groupItemsForCalendar(items, days, SCHEDULER_TIME_ZONE), [items, days]);

  const handleCreate = useCallback(async () => {
    if (!body.trim()) return;
    try {
      await createItem({
        body: body.trim(),
        source,
        scheduledFor: fromDatetimeLocal(scheduledFor),
        actor: ACTOR
      });
      setBody('');
      setScheduledFor(defaultScheduledFor());
      await reload();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, [body, source, scheduledFor, reload]);

  const handleApprove = useCallback(
    async (id) => {
      try {
        await approveItem(id, ACTOR);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [reload]
  );

  const handleUnapprove = useCallback(
    async (id) => {
      try {
        await unapproveItem(id, ACTOR);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [reload]
  );

  const handlePublish = useCallback(
    async (id) => {
      try {
        await publishItem(id, ACTOR);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [reload]
  );

  const handleRemove = useCallback(
    async (id) => {
      try {
        await removeItem(id, ACTOR);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [reload]
  );

  const handleSave = useCallback(
    async (id, patch) => {
      try {
        await updateItem(id, patch, { actor: ACTOR });
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [reload]
  );

  const handleDragStart = useCallback((id) => {
    setDraggingItemId(id);
    setDropError(null);
  }, []);

  const handleDayDragOver = useCallback(
    (e, dayKey) => {
      if (!draggingItemId) return;
      const item = (items ?? []).find((i) => i.id === draggingItemId);
      if (!item || item.status === 'published') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverZone(`day:${dayKey}`);
      const { blocked } = dayDropBlocked(grouped.publishedByDayKey, dayKey, draggingItemId);
      if (blocked) {
        setDropError({ dayKey, message: DROP_REFUSED_MESSAGE });
      } else if (dropError?.dayKey === dayKey) {
        setDropError(null);
      }
    },
    [draggingItemId, items, grouped.publishedByDayKey, dropError]
  );

  const handleDayDrop = useCallback(
    async (e, dayKey) => {
      e.preventDefault();
      setDragOverZone(null);
      const sourceId = e.dataTransfer.getData('text/plain') || draggingItemId;
      setDraggingItemId(null);
      if (!sourceId) return;
      const item = (items ?? []).find((i) => i.id === sourceId);
      if (!item || item.status === 'published') {
        setDropError(null);
        return;
      }
      const { blocked } = dayDropBlocked(grouped.publishedByDayKey, dayKey, sourceId);
      if (blocked) {
        setDropError({ dayKey, message: DROP_REFUSED_MESSAGE });
        return;
      }
      const currentDayKey = getAucklandDayKey(item.scheduledFor, SCHEDULER_TIME_ZONE);
      if (currentDayKey === dayKey) {
        // No-op drop on the same day; clear any stale error.
        setDropError(null);
        return;
      }
      const nextIso = rescheduleIsoForDay(item, dayKey, SCHEDULER_TIME_ZONE);
      if (!nextIso) {
        setError('Failed to compute new scheduled time.');
        return;
      }
      try {
        await updateItem(sourceId, { scheduledFor: nextIso }, { actor: ACTOR });
        setDropError(null);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [draggingItemId, items, grouped.publishedByDayKey, reload]
  );

  const handleUnscheduledDragOver = useCallback((e) => {
    if (!draggingItemId) return;
    const item = (items ?? []).find((i) => i.id === draggingItemId);
    if (!item || item.status === 'published') return;
    e.preventDefault();
    setDragOverZone('unscheduled');
  }, [draggingItemId, items]);

  const handleUnscheduledDrop = useCallback(
    async (e) => {
      e.preventDefault();
      setDragOverZone(null);
      const sourceId = e.dataTransfer.getData('text/plain') || draggingItemId;
      setDraggingItemId(null);
      if (!sourceId) return;
      const item = (items ?? []).find((i) => i.id === sourceId);
      if (!item || item.status === 'published') return;
      if (!item.scheduledFor) {
        // Already unscheduled — no-op.
        return;
      }
      try {
        await updateItem(sourceId, { scheduledFor: null }, { actor: ACTOR });
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [draggingItemId, items, reload]
  );

  if (error && !items) {
    return (
      <div className="pulse-tab" data-testid="pulse-content-scheduler-error">
        <h2>Content Scheduler</h2>
        <p>Failed to load: {error}</p>
        <Button onClick={reload} data-testid="pulse-content-scheduler-retry">Retry</Button>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="pulse-tab" data-testid="pulse-content-scheduler-loading">
        <h2>Content Scheduler</h2>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="pulse-tab content-scheduler-tab" data-testid="pulse-content-scheduler">
      <h2>Content Scheduler</h2>
      <Card className="content-scheduler-composer" data-testid="pulse-content-scheduler-composer">
        <Field label="Tweet body">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            placeholder="Draft the tweet text…"
            data-testid="pulse-content-scheduler-body"
          />
        </Field>
        <div className="content-scheduler-composer__meta">
          <Field label="Source">
            <Select
              aria-label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              data-testid="pulse-content-scheduler-source"
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </Field>
          <Field
            label="Scheduled for"
          >
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              data-testid="pulse-content-scheduler-schedule"
              className="si-input"
            />
          </Field>
        </div>
        <Button variant="primary" onClick={handleCreate} disabled={!body.trim()} data-testid="pulse-content-scheduler-add">
          Add to queue
        </Button>
        {error && <p className="content-scheduler-error" data-testid="pulse-content-scheduler-error">{error}</p>}
      </Card>

      <section
        className="content-scheduler-calendar"
        data-testid="pulse-content-scheduler-calendar"
        aria-label="10-day publishing calendar (Pacific/Auckland)"
      >
        {days.map((day) => {
          const dayItems = grouped.byDayKey[day.key] ?? [];
          const publishedItem = grouped.publishedByDayKey[day.key] ?? null;
          const isOver = dragOverZone === `day:${day.key}`;
          const dayError = dropError?.dayKey === day.key ? dropError.message : null;
          const headerClasses = ['content-scheduler-day-column__header'];
          if (publishedItem) headerClasses.push('content-scheduler-day-column__header--published');
          const columnClasses = ['content-scheduler-day-column'];
          if (isOver) columnClasses.push('content-scheduler-day-column--drag-over');
          if (dayError) columnClasses.push('content-scheduler-day-column--drop-error');
          return (
            <div
              key={day.key}
              className={columnClasses.join(' ')}
              data-testid={`pulse-content-scheduler-day-${day.key}`}
              data-day-key={day.key}
              onDragOver={(e) => handleDayDragOver(e, day.key)}
              onDrop={(e) => handleDayDrop(e, day.key)}
            >
              <header className={headerClasses.join(' ')} data-testid={`pulse-content-scheduler-day-header-${day.key}`}>
                <span className="content-scheduler-day-column__label">{day.label}</span>
                {publishedItem && (
                  <Badge variant="success" data-testid={`pulse-content-scheduler-day-published-${day.key}`}>
                    Published
                  </Badge>
                )}
                <span className="content-scheduler-day-column__count" data-testid={`pulse-content-scheduler-day-count-${day.key}`}>
                  {dayItems.length}
                </span>
              </header>
              {dayError && (
                <p
                  className="content-scheduler-day-column__drop-error"
                  data-testid={`pulse-content-scheduler-day-drop-error-${day.key}`}
                  role="alert"
                >
                  {dayError}
                </p>
              )}
              <CardContainer className="content-scheduler-day-column__cards">
                {dayItems.length === 0 ? (
                  <p className="content-scheduler-empty">No items.</p>
                ) : (
                  dayItems.map((item) => (
                    <SchedulerItemCard
                      key={item.id}
                      item={item}
                      today={today}
                      onApprove={handleApprove}
                      onUnapprove={handleUnapprove}
                      onPublish={handlePublish}
                      onRemove={handleRemove}
                      onSave={handleSave}
                      onDragStart={handleDragStart}
                      isPublishedInCalendar={Boolean(publishedItem) && item.id !== publishedItem.id}
                    />
                  ))
                )}
              </CardContainer>
            </div>
          );
        })}
      </section>

      <section
        className={`content-scheduler-unscheduled${dragOverZone === 'unscheduled' ? ' content-scheduler-unscheduled--drag-over' : ''}`}
        data-testid="pulse-content-scheduler-unscheduled"
        onDragOver={handleUnscheduledDragOver}
        onDrop={handleUnscheduledDrop}
      >
        <header className="content-scheduler-unscheduled__header">
          <h3>Unscheduled</h3>
          <span data-testid="pulse-content-scheduler-unscheduled-count">{grouped.unscheduled.length}</span>
        </header>
        {grouped.unscheduled.length === 0 ? (
          <p className="content-scheduler-empty">No unscheduled items.</p>
        ) : (
          <CardContainer>
            {grouped.unscheduled.map((item) => (
              <SchedulerItemCard
                key={item.id}
                item={item}
                today={today}
                onApprove={handleApprove}
                onUnapprove={handleUnapprove}
                onPublish={handlePublish}
                onRemove={handleRemove}
                onSave={handleSave}
                onDragStart={handleDragStart}
              />
            ))}
          </CardContainer>
        )}
      </section>

      <div className="content-scheduler-day-strip" data-testid="pulse-content-scheduler-day-strip">
        {dayStatusLabel(today)}
      </div>
    </div>
  );
}