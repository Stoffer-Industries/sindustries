import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContainer, Field, Select, Textarea } from '@sindustries/ui/react';
import {
  approveItem,
  createItem,
  getTodayStatus,
  listItems,
  publishItem,
  removeItem,
  reorderItems,
  unapproveItem,
  updateItem
} from '../contentSchedulerApi.js';

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

function ItemRow({ item, today, onApprove, onUnapprove, onPublish, onRemove, onSave, onDragStart, onDragOver, onDrop, isDragOver }) {
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

  return (
    <Card
      className="content-scheduler-row"
      data-testid={`content-scheduler-row-${item.id}`}
      draggable={!published}
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragOver={(e) => onDragOver(e, item.id)}
      onDrop={(e) => onDrop(e, item.id)}
      style={isDragOver ? { outline: '2px dashed var(--si-color-brand-500, #b46a00)' } : undefined}
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
          <span>Source: {item.source}</span>
          {item.scheduledFor && <span>Scheduled: {new Date(item.scheduledFor).toLocaleString()}</span>}
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
            {item.status === 'published' && (
              <span className="content-scheduler-row__badge" data-testid={`content-scheduler-published-${item.id}`}>
                Published
              </span>
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
  const [dragOverId, setDragOverId] = useState(null);

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

  const grouped = useMemo(() => {
    const out = { queued: [], approved: [], published: [] };
    for (const item of items ?? []) {
      if (out[item.status]) out[item.status].push(item);
    }
    for (const status of Object.keys(out)) {
      out[status].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    return out;
  }, [items]);

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

  const handleReorder = useCallback(
    async (sourceId, targetId) => {
      if (sourceId === targetId) return;
      const current = (items ?? []).filter((i) => i.status === 'queued');
      const fromIdx = current.findIndex((i) => i.id === sourceId);
      const toIdx = current.findIndex((i) => i.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      const reordered = [...current];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      try {
        await reorderItems(reordered.map((i) => i.id), ACTOR);
        await reload();
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    },
    [items, reload]
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

      {(['queued', 'approved', 'published']).map((status) => (
        <section
          key={status}
          className={`content-scheduler-group content-scheduler-group--${status}`}
          data-testid={`pulse-content-scheduler-group-${status}`}
        >
          <h3>{STATUS_LABELS[status]} ({grouped[status].length})</h3>
          {grouped[status].length === 0 ? (
            <p className="content-scheduler-empty">No {STATUS_LABELS[status].toLowerCase()} items.</p>
          ) : (
            <CardContainer>
              {grouped[status].map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  today={today}
                  onApprove={handleApprove}
                  onUnapprove={handleUnapprove}
                  onPublish={handlePublish}
                  onRemove={handleRemove}
                  onSave={handleSave}
                  onDragStart={(e, id) => e.dataTransfer.setData('text/plain', id)}
                  onDragOver={(e, id) => {
                    e.preventDefault();
                    setDragOverId(id);
                  }}
                  onDrop={async (e, id) => {
                    e.preventDefault();
                    const sourceId = e.dataTransfer.getData('text/plain');
                    setDragOverId(null);
                    await handleReorder(sourceId, id);
                  }}
                  isDragOver={dragOverId === item.id}
                />
              ))}
            </CardContainer>
          )}
        </section>
      ))}

      <div className="content-scheduler-day-strip" data-testid="pulse-content-scheduler-day-strip">
        {dayStatusLabel(today)}
      </div>
    </div>
  );
}