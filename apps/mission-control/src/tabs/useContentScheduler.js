import { useCallback, useEffect, useMemo, useState } from 'react';
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
  groupItemsForCalendar,
  rescheduleIsoForDay
} from './contentSchedulerCalendar.js';
import { ACTOR, DROP_REFUSED_MESSAGE, defaultScheduledFor, fromDatetimeLocal } from './contentSchedulerConstants.js';

// Owns the data, drag/drop, and CRUD layer for ContentSchedulerTab.
// Extracted from ContentSchedulerTab.jsx during the 2026-W30 code-garden refactor
// (audit finding 2-A: extract `useContentScheduler` hook + sub-components).
export function useContentScheduler() {
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

  const captureError = useCallback(async (fn) => {
    try {
      await fn();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!body.trim()) return;
    await captureError(async () => {
      await createItem({
        body: body.trim(),
        source,
        scheduledFor: fromDatetimeLocal(scheduledFor),
        actor: ACTOR
      });
      setBody('');
      setScheduledFor(defaultScheduledFor());
      await reload();
    });
  }, [body, source, scheduledFor, reload, captureError]);

  const handleApprove = useCallback((id) => captureError(async () => {
    await approveItem(id, ACTOR);
    await reload();
  }), [reload, captureError]);

  const handleUnapprove = useCallback((id) => captureError(async () => {
    await unapproveItem(id, ACTOR);
    await reload();
  }), [reload, captureError]);

  const handlePublish = useCallback((id) => captureError(async () => {
    await publishItem(id, ACTOR);
    await reload();
  }), [reload, captureError]);

  const handleRemove = useCallback((id) => captureError(async () => {
    await removeItem(id, ACTOR);
    await reload();
  }), [reload, captureError]);

  const handleSave = useCallback((id, patch) => captureError(async () => {
    await updateItem(id, patch, { actor: ACTOR });
    await reload();
  }), [reload, captureError]);

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

  return {
    items,
    today,
    error,
    body,
    source,
    scheduledFor,
    setBody,
    setSource,
    setScheduledFor,
    days,
    grouped,
    reload,
    handleCreate,
    handleApprove,
    handleUnapprove,
    handlePublish,
    handleRemove,
    handleSave,
    handleDragStart,
    handleDayDragOver,
    handleDayDrop,
    handleUnscheduledDragOver,
    handleUnscheduledDrop,
    dragOverZone,
    dropError
  };
}