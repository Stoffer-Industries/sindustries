import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Textarea } from '@sindustries/ui/react';
import { SCHEDULER_TIME_ZONE, getAucklandTimeOfDay } from './contentSchedulerCalendar.js';
import {
  STATUS_BADGE_VARIANT,
  STATUS_LABELS,
  fromDatetimeLocal,
  isPublishDisabled,
  publishTooltip,
  toDatetimeLocal
} from './contentSchedulerConstants.js';

// Combine the parent row's `body` (position 0) with the ordered `parts`
// rows into one normalized parts array. The API returns parts as
// positions 1..n; the UI treats them as a contiguous list with the
// parent body as position 0 so Tom sees them in order without a second
// visual model. Task 1016cbff PR B.
function normalizeThreadParts(item) {
  if (item.kind !== 'thread') return null;
  const sorted = (item.parts ?? []).slice().sort((a, b) => a.position - b.position);
  return [
    { position: 0, id: null, body: item.body },
    ...sorted.map((p) => ({ position: p.position, id: p.id, body: p.body }))
  ];
}

export function SchedulerItemCard({
  item,
  today,
  onApprove,
  onUnapprove,
  onPublish,
  onRemove,
  onSave,
  onSaveThread,
  onDragStart,
  isPublishedInCalendar = false
}) {
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(item.body);
  const [draftSchedule, setDraftSchedule] = useState(toDatetimeLocal(item.scheduledFor));
  // Thread edit state (task 1016cbff PR B). When editing a thread, the
  // operator sees N ordered textareas; saving sends the full list as
  // one aggregate PATCH (`onSaveThread`). The single-edit `onSave` is
  // unchanged for kind=single / kind=manual_reply items.
  const normalizedParts = useMemo(() => normalizeThreadParts(item), [item]);
  const isThread = item.kind === 'thread';
  const [draftParts, setDraftParts] = useState(
    normalizedParts ? normalizedParts.map((p) => ({ body: p.body })) : null
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDraftBody(item.body);
    setDraftSchedule(toDatetimeLocal(item.scheduledFor));
  }, [item.body, item.scheduledFor]);

  useEffect(() => {
    if (normalizedParts) {
      setDraftParts(normalizedParts.map((p) => ({ body: p.body })));
    }
  }, [normalizedParts]);

  useEffect(() => {
    setDraftBody(item.body);
    setDraftSchedule(toDatetimeLocal(item.scheduledFor));
  }, [item.body, item.scheduledFor]);

  const disabled = isPublishDisabled(item, today);
  const tip = publishTooltip(item, today);
  const published = item.status === 'published';
  // Imported CTO Craft items can already have a schedule from before the
  // draft-to-queued transition was deployed. Keep those rows actionable so
  // Tom can approve them without having to move them again.
  const canApprove = item.status === 'queued' || (item.status === 'draft' && item.scheduledFor);
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
        {editing && isThread && draftParts ? (
          <div className="content-scheduler-row__thread-edit" data-testid={`content-scheduler-thread-edit-${item.id}`}>
            <p className="content-scheduler-row__thread-edit-help">
              Editing any part clears the thread's approval; re-approve after saving.
            </p>
            {draftParts.map((part, index) => (
              <div key={`thread-edit-${item.id}-${index}`} className="content-scheduler-row__thread-edit-part">
                <div className="content-scheduler-row__thread-edit-header">
                  <span>Part {index + 1}</span>
                  <span data-testid={`content-scheduler-thread-edit-count-${item.id}-${index}`}>
                    {part.body.length}/280
                  </span>
                </div>
                <Textarea
                  value={part.body}
                  onChange={(e) => setDraftParts((parts) => parts.map((p, i) => (i === index ? { body: e.target.value } : p)))}
                  maxLength={1000}
                  data-testid={`content-scheduler-thread-edit-body-${item.id}-${index}`}
                />
              </div>
            ))}
          </div>
        ) : editing ? (
          <Field label="Body">
            <Textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              maxLength={1000}
              data-testid={`content-scheduler-edit-body-${item.id}`}
            />
          </Field>
        ) : (
          <div data-testid={`content-scheduler-body-${item.id}`}>
            {isThread && normalizedParts ? (
              <div className="content-scheduler-row__thread">
                <div className="content-scheduler-row__thread-head">
                  <Badge variant="info" data-testid={`content-scheduler-thread-badge-${item.id}`}>
                    Thread · {normalizedParts.length} parts
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    data-testid={`content-scheduler-thread-toggle-${item.id}`}
                  >
                    {expanded ? 'Collapse' : 'Expand'}
                  </Button>
                </div>
                <p className="content-scheduler-row__thread-root">{normalizedParts[0].body}</p>
                {expanded && (
                  <ol
                    className="content-scheduler-row__thread-parts"
                    data-testid={`content-scheduler-thread-parts-${item.id}`}
                  >
                    {normalizedParts.slice(1).map((part, idx) => (
                      <li
                        key={`thread-${item.id}-${idx}`}
                        className="content-scheduler-row__thread-part"
                        data-testid={`content-scheduler-thread-part-${item.id}-${idx + 1}`}
                      >
                        <span className="content-scheduler-row__thread-part-label">{idx + 1}.</span>
                        <span className="content-scheduler-row__thread-part-body">{part.body}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <p>{item.body}</p>
            )}
          </div>
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
                if (isThread && draftParts && onSaveThread) {
                  await onSaveThread(item.id, draftParts);
                } else {
                  await onSave(item.id, { body: draftBody, scheduledFor: fromDatetimeLocal(draftSchedule) });
                }
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
            {canApprove && (
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
