import { useCallback, useEffect, useRef, useState } from 'react';
import { archiveTask as archiveTaskRequest, createTask as createTaskRequest, createTaskComment as createTaskCommentRequest, fetchTask as fetchTaskRequest, fetchTasks, updateTask as updateTaskRequest } from './tasksApi';

const DEFAULT_REFRESH_INTERVAL_MS = 3000;

export function useTasks(filters, options = {}) {
  const {
    autoRefresh = true,
    pauseAutoRefresh = false,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS
  } = options;

  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const latestRequestRef = useRef(0);

  const reloadTasks = useCallback(async ({ suppressErrors = false } = {}) => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setIsLoading(true);

    try {
      const nextTasks = await fetchTasks(filters);
      if (latestRequestRef.current !== requestId) return nextTasks;
      setTasks(nextTasks);
      setError('');
      setIsLoading(false);
      return nextTasks;
    } catch (e) {
      if (latestRequestRef.current !== requestId) throw e;
      if (!suppressErrors) setError(e.message);
      setIsLoading(false);
      throw e;
    }
  }, [filters]);

  const runMutation = useCallback(async (request) => {
    setError('');
    try {
      const result = await request();
      await reloadTasks({ suppressErrors: true });
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [reloadTasks]);

  useEffect(() => {
    reloadTasks().catch(() => {});
  }, [reloadTasks]);

  useEffect(() => {
    if (!autoRefresh || pauseAutoRefresh) return undefined;

    function refreshVisibleTasks() {
      if (document.visibilityState === 'hidden') return;
      reloadTasks({ suppressErrors: true }).catch(() => {});
    }

    const intervalId = window.setInterval(refreshVisibleTasks, refreshIntervalMs);
    window.addEventListener('focus', refreshVisibleTasks);
    document.addEventListener('visibilitychange', refreshVisibleTasks);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshVisibleTasks);
      document.removeEventListener('visibilitychange', refreshVisibleTasks);
    };
  }, [autoRefresh, pauseAutoRefresh, refreshIntervalMs, reloadTasks]);

  const createTask = useCallback((payload) => runMutation(() => createTaskRequest(payload)), [runMutation]);
  const updateTask = useCallback((id, patch) => runMutation(() => updateTaskRequest(id, patch)), [runMutation]);
  const archiveTask = useCallback((id) => runMutation(() => archiveTaskRequest(id)), [runMutation]);
  const createTaskComment = useCallback((id, payload) => runMutation(() => createTaskCommentRequest(id, payload)), [runMutation]);
  const refreshTask = useCallback(async (id) => {
    setError('');
    try {
      const task = await fetchTaskRequest(id);
      setTasks((current) => current.map((entry) => (entry.id === id ? task : entry)));
      return task;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, []);

  return {
    tasks,
    error,
    isLoading,
    reloadTasks,
    createTask,
    updateTask,
    archiveTask,
    createTaskComment,
    refreshTask
  };
}
