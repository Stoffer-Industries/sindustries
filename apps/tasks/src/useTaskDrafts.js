import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'tasks-app.task-drafts.v1';

function sanitizeDraftValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeTaskDraft(draft) {
  return {
    title: sanitizeDraftValue(draft?.title),
    description: sanitizeDraftValue(draft?.description),
    status: sanitizeDraftValue(draft?.status, 'open'),
    priority: sanitizeDraftValue(draft?.priority, 'medium'),
    assignee: sanitizeDraftValue(draft?.assignee),
    dueAt: sanitizeDraftValue(draft?.dueAt),
    tagsText: sanitizeDraftValue(draft?.tagsText),
    blocked: Boolean(draft?.blocked)
  };
}

function loadStoredDrafts() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([taskId]) => typeof taskId === 'string' && taskId)
        .map(([taskId, draft]) => [taskId, sanitizeTaskDraft(draft)])
    );
  } catch {
    return {};
  }
}

function shallowDraftEqual(left, right) {
  return left.title === right.title
    && left.description === right.description
    && left.status === right.status
    && left.priority === right.priority
    && left.assignee === right.assignee
    && left.dueAt === right.dueAt
    && left.tagsText === right.tagsText
    && left.blocked === right.blocked;
}

export function useTaskDrafts(buildBaseDraft, liveTasks) {
  const [draftsByTaskId, setDraftsByTaskId] = useState(loadStoredDrafts);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draftsByTaskId));
  }, [draftsByTaskId]);

  const liveTaskMap = useMemo(
    () => new Map(liveTasks.map((task) => [task.id, task])),
    [liveTasks]
  );

  function getDraft(task) {
    return draftsByTaskId[task.id] ?? buildBaseDraft(task);
  }

  function storeDraft(task, nextDraft) {
    const sanitized = sanitizeTaskDraft(nextDraft);
    const baseDraft = buildBaseDraft(task);

    setDraftsByTaskId((current) => {
      if (shallowDraftEqual(sanitized, baseDraft)) {
        if (!(task.id in current)) return current;
        const next = { ...current };
        delete next[task.id];
        return next;
      }

      return { ...current, [task.id]: sanitized };
    });
  }

  function clearDraft(taskId) {
    setDraftsByTaskId((current) => {
      if (!(taskId in current)) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function isTaskDirty(task) {
    return task.id in draftsByTaskId;
  }

  const hasUnsavedDrafts = useMemo(() => {
    return Object.keys(draftsByTaskId).some((taskId) => {
      const liveTask = liveTaskMap.get(taskId);
      if (!liveTask) return true;
      return !shallowDraftEqual(draftsByTaskId[taskId], buildBaseDraft(liveTask));
    });
  }, [buildBaseDraft, draftsByTaskId, liveTaskMap]);

  return {
    getDraft,
    storeDraft,
    clearDraft,
    isTaskDirty,
    hasUnsavedDrafts
  };
}
