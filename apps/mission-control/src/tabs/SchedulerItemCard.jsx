import React, { useEffect, useState } from 'react';
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

export function SchedulerItemCard({
  item,
  today,
  onApprove,
  onUnapprove,
  onPublish,
  onRemove,
  onSave,
  onDragStart,
  isPublishedInCalendar = false
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