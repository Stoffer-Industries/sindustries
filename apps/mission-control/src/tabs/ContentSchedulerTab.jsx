import React from 'react';
import { Badge, Button, Card, CardContainer, Field, Select, Textarea } from '@sindustries/ui/react';
import { SchedulerItemCard } from './SchedulerItemCard.jsx';
import { SOURCES, dayStatusLabel } from './contentSchedulerConstants.js';
import { useContentScheduler } from './useContentScheduler.js';

// Slim container: composer + 10-day calendar grid + unscheduled strip + day-strip.
// Data, drag/drop, and CRUD handlers live in `useContentScheduler` (extracted
// during the 2026-W30 code-garden refactor; see audit finding 2-A).
export function ContentSchedulerTab() {
  const {
    items,
    today,
    error,
    body,
    source,
    scheduledFor,
    setBody,
    setSource,
    setScheduledFor,
    composerKind,
    setComposerKind,
    threadParts,
    addThreadPart,
    removeThreadPart,
    moveThreadPart,
    setThreadPartBody,
    days,
    grouped,
    reload,
    handleCreate,
    handleApprove,
    handleUnapprove,
    handlePublish,
    handleRemove,
    handleSave,
    handleSaveThread,
    handleDragStart,
    handleDayDragOver,
    handleDayDrop,
    handleUnscheduledDragOver,
    handleUnscheduledDrop,
    dragOverZone,
    dropError
  } = useContentScheduler();

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
        <div className="content-scheduler-composer__kind" role="radiogroup" aria-label="Composer kind">
          <label className="content-scheduler-composer__kind-option">
            <input
              type="radio"
              name="composer-kind"
              value="single"
              checked={composerKind === 'single'}
              onChange={() => setComposerKind('single')}
              data-testid="pulse-content-scheduler-kind-single"
            />
            Single tweet
          </label>
          <label className="content-scheduler-composer__kind-option">
            <input
              type="radio"
              name="composer-kind"
              value="thread"
              checked={composerKind === 'thread'}
              onChange={() => setComposerKind('thread')}
              data-testid="pulse-content-scheduler-kind-thread"
            />
            Thread
          </label>
        </div>
        {composerKind === 'thread' ? (
          <div className="content-scheduler-composer__thread" data-testid="pulse-content-scheduler-thread-composer">
            <p className="content-scheduler-composer__thread-help">
              A thread is one root tweet plus 1–6 reply tweets (2–7 parts total). It publishes as a single ordered chain on X.
            </p>
            {threadParts.map((part, index) => (
              <div
                key={`thread-part-${index}`}
                className="content-scheduler-composer__thread-part"
                data-testid={`pulse-content-scheduler-thread-part-${index}`}
              >
                <div className="content-scheduler-composer__thread-part-header">
                  <span className="content-scheduler-composer__thread-part-label">Part {index + 1}</span>
                  <span className="content-scheduler-composer__thread-part-count" data-testid={`pulse-content-scheduler-thread-part-count-${index}`}>
                    {part.body.length}/280
                  </span>
                </div>
                <Textarea
                  value={part.body}
                  onChange={(e) => setThreadPartBody(index, e.target.value)}
                  maxLength={1000}
                  placeholder={index === 0 ? 'Root tweet (will start the thread)…' : `Reply ${index} (chained to part ${index})…`}
                  data-testid={`pulse-content-scheduler-thread-part-body-${index}`}
                />
                <div className="content-scheduler-composer__thread-part-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => moveThreadPart(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move part ${index + 1} up`}
                    data-testid={`pulse-content-scheduler-thread-part-up-${index}`}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => moveThreadPart(index, 1)}
                    disabled={index === threadParts.length - 1}
                    aria-label={`Move part ${index + 1} down`}
                    data-testid={`pulse-content-scheduler-thread-part-down-${index}`}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => removeThreadPart(index)}
                    disabled={threadParts.length <= 2}
                    aria-label={`Remove part ${index + 1}`}
                    data-testid={`pulse-content-scheduler-thread-part-remove-${index}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={addThreadPart}
              disabled={threadParts.length >= 7}
              data-testid="pulse-content-scheduler-thread-add-part"
            >
              + Add part
            </Button>
          </div>
        ) : (
          <Field label="Tweet body">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={1000}
              placeholder="Draft the tweet text…"
              data-testid="pulse-content-scheduler-body"
            />
          </Field>
        )}
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
        <Button
          variant="primary"
          onClick={handleCreate}
          disabled={composerKind === 'single' ? !body.trim() : threadParts.some((p) => !p.body.trim()) || threadParts.length < 2}
          data-testid="pulse-content-scheduler-add"
        >
          {composerKind === 'thread' ? 'Add thread to queue' : 'Add to queue'}
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
                      onSaveThread={handleSaveThread}
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
                onSaveThread={handleSaveThread}
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