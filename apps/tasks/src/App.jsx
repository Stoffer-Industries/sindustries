import { useEffect, useMemo, useRef, useState } from 'react';
import { useTasks } from './useTasks.js';
import { useTaskDrafts } from './useTaskDrafts.js';
import { useDebounce } from './hooks/useDebounce.js';
import { useToast } from './hooks/useToast.js';
import { TaskEditor } from './components/TaskEditor.jsx';
import { STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_SCORE, ASSIGNEE_OPTIONS } from './utils/constants.js';
import { createConfettiPieces, normalizeTaskForEditor, assigneeInitial } from './utils/helpers.js';
import { getStoredView, setStoredView } from './utils/storage.js';

function isReadyTask(task) {
  return task.status === 'ready';
}

export function App() {
  const [view, setView] = useState(getStoredView);
  const [selectedId, setSelectedId] = useState(null);
  const initialStatusSelection = ['open', 'ready', 'doing', 'acceptance'];
  const [filters, setFilters] = useState({ q: '', status: initialStatusSelection.join(','), priority: '', tag: '', assignee: '', includeArchived: false });
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set(initialStatusSelection));
  const [openFilterMenu, setOpenFilterMenu] = useState(null);
  const statusMenuRef = useRef(null);
  const priorityMenuRef = useRef(null);
  const assigneeMenuRef = useRef(null);
  const tagMenuRef = useRef(null);

  // Calculate number of visible columns for CSS grid
  const visibleColumnCount = STATUSES.filter(status => selectedStatuses.has(status)).length;

  useEffect(() => {
    const nextStatusFilter = selectedStatuses.size === STATUSES.length ? '' : [...selectedStatuses].join(',');
    setFilters((current) => (current.status === nextStatusFilter ? current : { ...current, status: nextStatusFilter }));
  }, [selectedStatuses]);

  useEffect(() => {
    const menuByKey = {
      status: statusMenuRef,
      priority: priorityMenuRef,
      assignee: assigneeMenuRef,
      tag: tagMenuRef
    };

    function handleClickOutside(event) {
      const menu = menuByKey[openFilterMenu]?.current;
      if (!menu) return;
      if (event.target instanceof Node && !menu.contains(event.target)) {
        setOpenFilterMenu(null);
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') setOpenFilterMenu(null);
    }

    if (openFilterMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [openFilterMenu]);
  
  // Default backlog view to Status: Open (only when switching to backlog)
  useEffect(() => {
    if (view !== 'backlog') return;
    setSelectedStatuses((current) => (current.size === 0 ? new Set(['open']) : current));
  }, [view]);

  // Persist view to localStorage
  useEffect(() => {
    setStoredView(view);
  }, [view]);

  // Debounce search filter
  const debouncedSearch = useDebounce(filters.q, 300);

  // Toast notifications
  const { toasts, showToast } = useToast();

  const [newTask, setNewTask] = useState({ title: '', expanded: false, description: '', priority: 'medium', assignee: '', dueAt: '', tagsText: '', blocked: false, taskType: '' });
  const [confettiBursts, setConfettiBursts] = useState([]);
  const [submittingCommentForTaskId, setSubmittingCommentForTaskId] = useState(null);
  const confettiTimeoutsRef = useRef(new Map());
  const audioContextRef = useRef(null);
  const taskCardRefs = useRef({});

  // Scroll to task card after save/close if needed
  // AC9: When closing a task that has a long card (top above window), scroll should reset accounting for header
  function scrollToTaskIfNeeded(taskId) {
    // Wait for React to commit (editor unmounted, card visible) and ref to be set
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const key = String(taskId);
        const cardEl = taskCardRefs.current[key] ?? taskCardRefs.current[taskId];
        if (!cardEl) return;

        const cardRect = cardEl.getBoundingClientRect();
        const headerHeight = document.querySelector('header')?.offsetHeight ?? 0;
        const buffer = 8;

        const targetScrollY = cardRect.top + window.scrollY - headerHeight - buffer;
        window.scrollTo({ top: Math.max(0, targetScrollY), behavior: 'smooth' });
      });
    });
  }

  // Compute filters with debounced search for API calls
  const apiFilters = useMemo(() => ({
    ...filters,
    q: debouncedSearch
  }), [filters, debouncedSearch]);

  const {
    tasks,
    error,
    isLoading,
    createTask: createTaskRequest,
    updateTask: patchTaskRequest,
    archiveTask: archiveTaskRequest,
    createTaskComment: createTaskCommentRequest,
    refreshTask
  } = useTasks(apiFilters, {
    pauseAutoRefresh: selectedId !== null,
    refreshIntervalMs: 3000
  });
  const {
    getDraft,
    storeDraft,
    clearDraft,
    isTaskDirty,
    hasUnsavedDrafts
  } = useTaskDrafts(normalizeTaskForEditor, tasks);

  // Extract unique tags from all tasks for the filter dropdown
  const allTags = useMemo(() => {
    const tagSet = new Set();
    tasks.forEach((task) => {
      if (Array.isArray(task.tags)) {
        task.tags.forEach((tag) => {
          const tagName = typeof tag === 'string' ? tag : tag.name;
          if (tagName) tagSet.add(tagName);
        });
      }
    });
    return Array.from(tagSet).sort();
  }, [tasks]);

  useEffect(() => {
    return () => {
      for (const timeoutId of confettiTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      confettiTimeoutsRef.current.clear();
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!hasUnsavedDrafts) return undefined;

    function handleBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedDrafts]);

  const boardColumns = useMemo(() => {
    const columns = { open: [], ready: [], doing: [], acceptance: [], done: [] };
    const filtered = filters.priority ? tasks.filter((t) => t.priority === filters.priority) : tasks;
    for (const task of filtered) columns[task.status]?.push(task);
    for (const status of STATUSES) {
      columns[status].sort((a, b) => {
        const priorityDiff = (PRIORITY_SCORE[a.priority] ?? 99) - (PRIORITY_SCORE[b.priority] ?? 99);
        if (priorityDiff !== 0) return priorityDiff;
        // Secondary sort: ready status first, then by date created
        if (isReadyTask(a) !== isReadyTask(b)) return isReadyTask(a) ? -1 : 1;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
    }
    return columns;
  }, [tasks, filters.priority]);

  // Backlog list uses same sort order: priority, readiness, date created
  const sortedBacklogTasks = useMemo(() => {
    const filtered = filters.priority ? tasks.filter((t) => t.priority === filters.priority) : tasks;
    return [...filtered].sort((a, b) => {
      const priorityDiff = (PRIORITY_SCORE[a.priority] ?? 99) - (PRIORITY_SCORE[b.priority] ?? 99);
      if (priorityDiff !== 0) return priorityDiff;
      if (isReadyTask(a) !== isReadyTask(b)) return isReadyTask(a) ? -1 : 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }, [tasks, filters.priority]);

  async function createTask(event) {
    event.preventDefault();
    try {
      await createTaskRequest({
        title: newTask.title.trim(),
        description: newTask.description.trim() || null,
        priority: newTask.priority,
        dueAt: newTask.dueAt ? new Date(`${newTask.dueAt}T00:00:00`).toISOString() : null,
        assignee: newTask.assignee.trim() || null,
        tags: newTask.tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        blocked: newTask.blocked,
        taskType: newTask.taskType || null
      });
      setNewTask({ title: '', expanded: false, description: '', priority: 'medium', assignee: '', dueAt: '', tagsText: '', blocked: false, taskType: '' });
      showToast('Task created', 'success');
    } catch {
      showToast('Failed to create task', 'error');
    }
  }

  async function patchTask(id, patch) {
    try {
      await patchTaskRequest(id, patch);
      showToast('Task updated', 'success');
      return true;
    } catch {
      showToast('Failed to update task', 'error');
      return false;
    }
  }

  async function archiveTask(id) {
    try {
      await archiveTaskRequest(id);
      clearDraft(id);
      setSelectedId(null);
      showToast('Task archived', 'success');
      return true;
    } catch {
      showToast('Failed to archive task', 'error');
      return false;
    }
  }

  async function createTaskComment(id, payload) {
    setSubmittingCommentForTaskId(id);
    try {
      await createTaskCommentRequest(id, payload);
      await refreshTask(id);
      return true;
    } catch {
      return false;
    } finally {
      setSubmittingCommentForTaskId((current) => (current === id ? null : current));
    }
  }

  async function playSalesBell() {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextCtor();
      }

      const context = audioContextRef.current;
      if (context.state === 'suspended') {
        await context.resume();
      }

      const now = context.currentTime + 0.02;
      const notes = [523.25, 659.25, 783.99, 1046.5];

      notes.forEach((frequency, index) => {
        const start = now + index * 0.09;
        const duration = 0.24;

        const lead = context.createOscillator();
        const leadGain = context.createGain();
        lead.type = 'square';
        lead.frequency.setValueAtTime(frequency, start);
        leadGain.gain.setValueAtTime(0.001, start);
        leadGain.gain.exponentialRampToValueAtTime(0.17, start + 0.02);
        leadGain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        lead.connect(leadGain);
        leadGain.connect(context.destination);
        lead.start(start);
        lead.stop(start + duration + 0.03);

        const shimmer = context.createOscillator();
        const shimmerGain = context.createGain();
        shimmer.type = 'triangle';
        shimmer.frequency.setValueAtTime(frequency * 2, start);
        shimmerGain.gain.setValueAtTime(0.001, start);
        shimmerGain.gain.exponentialRampToValueAtTime(0.06, start + 0.02);
        shimmerGain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        shimmer.connect(shimmerGain);
        shimmerGain.connect(context.destination);
        shimmer.start(start);
        shimmer.stop(start + duration + 0.03);
      });
    } catch {
      // No-op on browsers that block or lack Web Audio.
    }
  }

  function openTask(taskId) {
    setSelectedId(taskId);
    void refreshTask(taskId).catch(() => {});
  }

  function toggleTask(taskId, isSelected) {
    if (isSelected) {
      setSelectedId(null);
      return;
    }
    openTask(taskId);
  }

  function launchPulseCelebration() {
    void playSalesBell();

    const id = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const pieces = createConfettiPieces();
    setConfettiBursts((current) => [...current, { id, pieces }]);

    const timeoutId = window.setTimeout(() => {
      setConfettiBursts((current) => current.filter((burst) => burst.id !== id));
      confettiTimeoutsRef.current.delete(id);
    }, 2800);

    confettiTimeoutsRef.current.set(id, timeoutId);
  }

  function updatePulseHoverMotion(event) {
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    const x = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);
    const centerX = x - 0.5;
    const centerY = y - 0.5;
    const distance = Math.min(Math.hypot(centerX, centerY), 0.75);

    const sway = centerX * 11;
    const lift = 3 + Math.abs(centerY) * 7;
    const speed = 460 + Math.round(distance * 360);

    element.style.setProperty('--pulse-tilt', `${(centerX * 5.5).toFixed(2)}deg`);
    element.style.setProperty('--pulse-sway-a', `${sway.toFixed(2)}px`);
    element.style.setProperty('--pulse-sway-b', `${(-sway * 0.72).toFixed(2)}px`);
    element.style.setProperty('--pulse-up-a', `-${lift.toFixed(2)}px`);
    element.style.setProperty('--pulse-up-b', `-${(lift + 1.8).toFixed(2)}px`);
    element.style.setProperty('--pulse-down', `${(centerY * 1.6).toFixed(2)}px`);
    element.style.setProperty('--pulse-speed', `${speed}ms`);
  }

  function resetPulseHoverMotion(event) {
    const element = event.currentTarget;
    element.style.removeProperty('--pulse-tilt');
    element.style.removeProperty('--pulse-sway-a');
    element.style.removeProperty('--pulse-sway-b');
    element.style.removeProperty('--pulse-up-a');
    element.style.removeProperty('--pulse-up-b');
    element.style.removeProperty('--pulse-down');
    element.style.removeProperty('--pulse-speed');
  }

  return (
    <main className="app-shell">
      <header className="hero-header">
        <div className="hero-pattern" aria-hidden="true" />
        <div className="hero-content">
          <div className="brand-wrap">
            <button
              type="button"
              className="brand brand-btn font-display"
              onClick={launchPulseCelebration}
              onPointerEnter={updatePulseHoverMotion}
              onPointerMove={updatePulseHoverMotion}
              onPointerLeave={resetPulseHoverMotion}
              aria-label="Ring Pulse sales bell"
            >
              Pulse
            </button>
          </div>
          <div className="hero-controls">
            <label className="search-wrap" aria-label="Search tasks">
              <span className="search-icon">⌕</span>
              <input
                aria-label="Search"
                placeholder="Search title or description"
                value={filters.q}
                onChange={(e) => setFilters((current) => ({ ...current, q: e.target.value }))}
              />
            </label>
            <button className={`nav-btn ${view === 'backlog' ? 'active' : ''}`} onClick={() => setView('backlog')}>Backlog</button>
            <button className={`nav-btn ${view === 'board' ? 'active' : ''}`} onClick={() => { setView('board'); setFilters((current) => ({ ...current, status: '' })); }}>Kanban</button>
            <a href="/tokens" className="nav-btn">Tokens</a>
            <button type="button" className="primary-btn font-display" onClick={() => setNewTask((current) => ({ ...current, expanded: true }))}>+ New Task</button>
          </div>
        </div>
      </header>

      <section className="content">
        <div className="filter-row panel">
          <div className="filter-controls">
            <div className="status-filter" ref={statusMenuRef}>
              <button
                type="button"
                className={`status-filter-trigger ${selectedStatuses.size === STATUSES.length ? '' : 'is-filtered'}`.trim()}
                aria-label="Status filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'status'}
                onClick={() => setOpenFilterMenu((current) => (current === 'status' ? null : 'status'))}
              >
                {(() => {
                  const selected = STATUSES.filter((s) => selectedStatuses.has(s));
                  const label = selected.length === 0 || selected.length === STATUSES.length
                    ? 'All statuses'
                    : selected.map((s) => STATUS_LABELS[s]).join(', ');
                  return `STATUS: ${label.toUpperCase()}`;
                })()}
              </button>

              {openFilterMenu === 'status' ? (
                <div className="status-filter-menu" role="menu" aria-label="Status filter menu">
                  <label className="status-filter-option" role="menuitemcheckbox" aria-checked={selectedStatuses.size === STATUSES.length}>
                    <input
                      type="checkbox"
                      checked={selectedStatuses.size === STATUSES.length}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const next = checked ? new Set(STATUSES) : new Set(['open']);
                        setSelectedStatuses(next);
                        setFilters((current) => ({ ...current, status: checked ? '' : 'open' }));
                      }}
                    />
                    <span>All</span>
                  </label>

                  <div className="status-filter-divider" aria-hidden="true" />

                  {STATUSES.map((status) => (
                    <label key={status} className="status-filter-option" role="menuitemcheckbox" aria-checked={selectedStatuses.has(status)}>
                      <input
                        type="checkbox"
                        checked={selectedStatuses.has(status)}
                        onChange={() => {
                          setSelectedStatuses((prev) => {
                            const next = new Set(prev);
                            if (next.has(status)) {
                              if (next.size === 1) return prev;
                              next.delete(status);
                            } else {
                              next.add(status);
                            }
                            setFilters((current) => ({ ...current, status: next.size === STATUSES.length ? '' : [...next].join(',') }));
                            return next;
                          });
                        }}
                      />
                      <span>{STATUS_LABELS[status].toUpperCase()}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="status-filter" ref={priorityMenuRef}>
              <button
                type="button"
                className={`status-filter-trigger ${filters.priority ? 'is-filtered' : ''}`.trim()}
                aria-label="Priority filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'priority'}
                onClick={() => setOpenFilterMenu((current) => (current === 'priority' ? null : 'priority'))}
              >
                {`PRIORITY: ${(filters.priority ? filters.priority : 'All priorities').toUpperCase()}`}
              </button>
              {openFilterMenu === 'priority' ? (
                <div className="status-filter-menu" role="menu" aria-label="Priority filter menu">
                  <button
                    type="button"
                    className="status-filter-option"
                    role="menuitemradio"
                    aria-checked={!filters.priority}
                    onClick={() => {
                      setFilters((current) => ({ ...current, priority: '' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    ALL PRIORITIES
                  </button>
                  <div className="status-filter-divider" aria-hidden="true" />
                  {PRIORITIES.map((priority) => (
                    <button
                      key={priority}
                      type="button"
                      className="status-filter-option"
                      role="menuitemradio"
                      aria-checked={filters.priority === priority}
                      onClick={() => {
                        setFilters((current) => ({ ...current, priority }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      {priority.toUpperCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="status-filter" ref={assigneeMenuRef}>
              <button
                type="button"
                className={`status-filter-trigger ${filters.assignee ? 'is-filtered' : ''}`.trim()}
                aria-label="Assignee filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'assignee'}
                onClick={() => setOpenFilterMenu((current) => (current === 'assignee' ? null : 'assignee'))}
              >
                {`ASSIGNEE: ${(filters.assignee ? (filters.assignee === 'unassigned' ? 'Unassigned' : filters.assignee) : 'All').toUpperCase()}`}
              </button>
              {openFilterMenu === 'assignee' ? (
                <div className="status-filter-menu" role="menu" aria-label="Assignee filter menu">
                  <button
                    type="button"
                    className="status-filter-option"
                    role="menuitemradio"
                    aria-checked={!filters.assignee}
                    onClick={() => {
                      setFilters((current) => ({ ...current, assignee: '' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    ALL
                  </button>
                  <button
                    type="button"
                    className="status-filter-option"
                    role="menuitemradio"
                    aria-checked={filters.assignee === 'unassigned'}
                    onClick={() => {
                      setFilters((current) => ({ ...current, assignee: 'unassigned' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    UNASSIGNED
                  </button>
                  <div className="status-filter-divider" aria-hidden="true" />
                  {ASSIGNEE_OPTIONS.map((assignee) => (
                    <button
                      key={assignee}
                      type="button"
                      className="status-filter-option"
                      role="menuitemradio"
                      aria-checked={filters.assignee === assignee}
                      onClick={() => {
                        setFilters((current) => ({ ...current, assignee }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      {assignee.toUpperCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {allTags.length > 0 ? (
              <div className="status-filter" ref={tagMenuRef}>
                <button
                  type="button"
                  className={`status-filter-trigger ${filters.tag ? 'is-filtered' : ''}`.trim()}
                  aria-label="Tag filter"
                  aria-haspopup="menu"
                  aria-expanded={openFilterMenu === 'tag'}
                  onClick={() => setOpenFilterMenu((current) => (current === 'tag' ? null : 'tag'))}
                >
                  {`TAG: ${(filters.tag ? filters.tag : 'All tags').toUpperCase()}`}
                </button>
                {openFilterMenu === 'tag' ? (
                  <div className="status-filter-menu" role="menu" aria-label="Tag filter menu">
                    <button
                      type="button"
                      className="status-filter-option"
                      role="menuitemradio"
                      aria-checked={!filters.tag}
                      onClick={() => {
                        setFilters((current) => ({ ...current, tag: '' }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      ALL TAGS
                    </button>
                    <div className="status-filter-divider" aria-hidden="true" />
                    {allTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="status-filter-option"
                        role="menuitemradio"
                        aria-checked={filters.tag === tag}
                        onClick={() => {
                          setFilters((current) => ({ ...current, tag }));
                          setOpenFilterMenu(null);
                        }}
                      >
                        {tag.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="filter-actions">
            <button
              className={`ghost-btn archived-toggle ${filters.includeArchived ? 'archived-active' : ''}`}
              onClick={() => setFilters((current) => ({ ...current, includeArchived: !current.includeArchived }))}
            >
              {filters.includeArchived ? 'Hide archived' : 'Show archived'}
            </button>
          </div>
        </div>

        {newTask.expanded ? (
          <form onSubmit={createTask} className="task-card stack create-card" aria-label="New task form">
            <div className="task-create-header">
              <h2 className="font-display">New Task</h2>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setNewTask((current) => ({ ...current, expanded: false }))}
              >
                Cancel
              </button>
            </div>

            <div className="editor-grid">
              <label style={{ gridColumn: '1 / -1' }}>
                <span className="small">Title</span>
                <input
                  className="edit-control"
                  aria-label="New task title"
                  value={newTask.title}
                  onChange={(e) => setNewTask((current) => ({ ...current, title: e.target.value }))}
                  required
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                <span className="small">Description</span>
                <input className="edit-control" value={newTask.description} onChange={(e) => setNewTask((current) => ({ ...current, description: e.target.value }))} />
              </label>
              <label>
                <span className="small">Priority</span>
                <select className="edit-control" value={newTask.priority} onChange={(e) => setNewTask((current) => ({ ...current, priority: e.target.value }))}>
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>{priority}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="small">Assignee</span>
                <input className="edit-control" value={newTask.assignee} onChange={(e) => setNewTask((current) => ({ ...current, assignee: e.target.value }))} />
              </label>
              <label>
                <span className="small">Due date</span>
                <input className="edit-control" type="date" value={newTask.dueAt} onChange={(e) => setNewTask((current) => ({ ...current, dueAt: e.target.value }))} />
              </label>
              <label>
                <span className="small">Tags</span>
                <input className="edit-control" value={newTask.tagsText} onChange={(e) => setNewTask((current) => ({ ...current, tagsText: e.target.value }))} placeholder="api, pulse" />
              </label>
              <label>
                <span className="small">Content type</span>
                <select className="edit-control" value={newTask.taskType} onChange={(e) => setNewTask((current) => ({ ...current, taskType: e.target.value }))}>
                  <option value="">None</option>
                  <option value="content">Content</option>
                  <option value="code">Code</option>
                  <option value="research">Research</option>
                </select>
              </label>
            </div>

            <div className="editor-toggles">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={newTask.blocked}
                  onChange={(e) => setNewTask((current) => ({ ...current, blocked: e.target.checked }))}
                />
                <span>Blocked</span>
              </label>
            </div>

            <div className="actions">
              <button type="submit" className="primary-btn font-display">Create task</button>
            </div>
          </form>
        ) : null}

        {error ? <p role="alert" className="error">{error}</p> : null}

        {isLoading && tasks.length === 0 ? (
          <div className="loading-spinner" role="status" aria-label="Loading tasks">
            <div className="spinner" />
            <span className="sr-only">Loading tasks...</span>
          </div>
        ) : null}

        {view === 'backlog' ? (
          <section>

            <ul aria-label="Backlog list" className="task-list">
               {sortedBacklogTasks.map((task, index) => {  
                const isSelected = selectedId === task.id;
                const draft = getDraft(task);
                const hasDraft = isTaskDirty(task);
                const taskTags = Array.isArray(task.tags) ? task.tags.map((tag) => tag.name ?? String(tag)) : [];
                const assignee = task.assignee ?? 'Unassigned';
                return (
                  <li key={task.id}>
                    <article 
                      ref={(el) => { if (el) taskCardRefs.current[String(task.id)] = el; }}
                      className={`task-card ${task.archivedAt ? 'archived' : ''} ${task.blocked ? 'blocked' : ''} ${isReadyTask(task) ? 'ready' : ''} ${isSelected ? 'is-editing' : ''} card-tilt-${index % 3}`}
                      onClick={() => {
                        if (!isSelected) openTask(task.id);
                      }}
                    >
                      <div className="task-row">
                        <button
                          className="task-title-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTask(task.id, isSelected);
                          }}
                        >
                          {task.taskType === 'content' ? <span className="task-type-icon" aria-label="Content task">📝</span> : task.taskType === 'code' ? <span className="task-type-icon" aria-label="Code task">💻</span> : task.taskType === 'research' ? <span className="task-type-icon" aria-label="Research task">🔍</span> : null}
                          {task.title}
                        </button>
                        <div className="assignee-chip">
                          {assigneeInitial(task.assignee) ? <span className="avatar-dot">{assigneeInitial(task.assignee)}</span> : null}
                          <span className="small">{assignee}</span>
                        </div>
                      </div>

                      <div className="badges">
                        <span className={`pill ${task.priority}`}>{task.priority}</span>
                        <span className="pill status">{task.status}</span>
                        {hasDraft ? <span className="pill draft-pill">Unsaved</span> : null}
                        {task.dueAt ? <span className="pill">Due {String(task.dueAt).slice(0, 10)}</span> : null}
                        {taskTags.map((tag) => <span key={`${task.id}-${tag}`} className="pill">#{tag}</span>)}
                      </div>

                      {isSelected ? (
                        <TaskEditor
                          draft={draft}
                          task={task}
                          isDirty={hasDraft}
                          onDraftChange={(nextDraft) => storeDraft(task, nextDraft)}
                          onSave={async (patch) => {
                            const didSave = await patchTask(task.id, patch);
                            if (!didSave) return;
                            clearDraft(task.id);
                            setSelectedId(null);
                            scrollToTaskIfNeeded(task.id);
                          }}
                          onArchive={() => archiveTask(task.id)}
                          onClose={() => {
                            setSelectedId(null);
                            scrollToTaskIfNeeded(task.id);
                          }}
                          onAddComment={(payload) => createTaskComment(task.id, payload)}
                          isSubmittingComment={submittingCommentForTaskId === task.id}
                        />
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section aria-label="Kanban board" className="board-wrap">
            <div className="board" style={{ '--visible-columns': visibleColumnCount }}>
              {STATUSES.map((status) => (
                <div
                  key={status}
                  data-testid={`column-${status}`}
                  className={`column ${!selectedStatuses.has(status) ? 'hidden' : ''}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('text/plain');
                    if (id) patchTask(id, { status });
                  }}
                >
                  <div className="column-head">
                    <h3 className="font-display">{STATUS_LABELS[status]}</h3>
                    <span className="count-pill">{boardColumns[status].length}</span>
                  </div>
                  <ol>
                      {boardColumns[status].map((task, index) => {
                        const isSelected = selectedId === task.id;
                        const draft = getDraft(task);
                        const hasDraft = isTaskDirty(task);
                        const assigneeLetter = assigneeInitial(task.assignee);
                        const assignee = task.assignee?.trim() || 'Unassigned';
                        const taskTags = Array.isArray(task.tags) ? task.tags.map((tag) => tag.name ?? String(tag)) : [];
                        return (
                          <li key={task.id}>
                            <article
                              ref={(el) => { if (el) taskCardRefs.current[String(task.id)] = el; }}
                              data-testid={`card-${task.id}`}
                              className={`board-card ${task.archivedAt ? 'archived' : ''} ${task.blocked ? 'blocked' : ''} ${isReadyTask(task) ? 'ready' : ''} ${isSelected ? 'is-editing' : ''} card-tilt-${index % 3}`}
                              draggable={!isSelected}
                              onDragStart={(e) => {
                                if (!isSelected) e.dataTransfer.setData('text/plain', task.id);
                              }}
                              onClick={(e) => {
                                if (!isSelected) {
                                  e.stopPropagation();
                                  openTask(task.id);
                                }
                              }}
                            >
                              <div className="task-row board-card-row">
                                <button
                                  className="task-title-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleTask(task.id, isSelected);
                                  }}
                                >
                                  {task.taskType === 'content' ? <span className="task-type-icon" aria-label="Content task">📝</span> : task.taskType === 'code' ? <span className="task-type-icon" aria-label="Code task">💻</span> : task.taskType === 'research' ? <span className="task-type-icon" aria-label="Research task">🔍</span> : null}
                                  {task.title}
                                </button>
                              </div>
                              <div className="board-card-meta">
                                <span className={`pill ${task.priority}`}>{task.priority}</span>
                                {taskTags.map((tag) => <span key={tag} className="pill tag-pill">#{tag}</span>)}
                                <div className="board-card-meta-right">
                                  {hasDraft ? <span className="pill draft-pill">Unsaved</span> : null}
                                  {isReadyTask(task) ? <span className="ready-dot" aria-label="Ready">✓</span> : null}
                                  {assigneeLetter ? <span className="avatar-dot" title={assignee} aria-label={`Assignee ${assignee}`}>{assigneeLetter}</span> : null}
                                  <span className="small">{String(task.statusChangedAt).slice(0, 10)}</span>
                                </div>
                              </div>
                              {isSelected ? (
                                <TaskEditor
                                  draft={draft}
                                  task={task}
                                  isDirty={hasDraft}
                                  onDraftChange={(nextDraft) => storeDraft(task, nextDraft)}
                                  onSave={async (patch) => {
                                    const didSave = await patchTask(task.id, patch);
                                    if (!didSave) return;
                                    clearDraft(task.id);
                                    setSelectedId(null);
                                    scrollToTaskIfNeeded(task.id);
                                  }}
                                  onArchive={() => archiveTask(task.id)}
                                  onClose={() => {
                                    setSelectedId(null);
                                    scrollToTaskIfNeeded(task.id);
                                  }}
                                  onAddComment={(payload) => createTaskComment(task.id, payload)}
                                  isSubmittingComment={submittingCommentForTaskId === task.id}
                                />
                              ) : null}
                            </article>
                          </li>
                        );
                      })}
                    </ol>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>

      <nav className="mobile-nav" aria-label="Primary">
        <button className={view === 'backlog' ? 'active' : ''} onClick={() => setView('backlog')}>List</button>
        <button className="fab font-display" onClick={() => setNewTask((current) => ({ ...current, expanded: true }))}>＋</button>
        <button className={view === 'board' ? 'active' : ''} onClick={() => { setView('board'); setFilters((current) => ({ ...current, status: '' })); }}>Board</button>
      </nav>

      {/* Toast notifications */}
      <div className="toast-container" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>

      {/* Accessibility: announce task count to screen readers */}
      <div className="sr-only" role="status" aria-live="polite">
        {isLoading ? 'Loading tasks...' : `${tasks.length} tasks`}
      </div>

      <div className="confetti-layer" aria-hidden="true">
        {confettiBursts.map((burst) => (
          <div key={burst.id} className="confetti-burst">
            {burst.pieces.map((piece) => (
              <span
                key={`${burst.id}-${piece.id}`}
                className="confetti-piece"
                style={{
                  '--confetti-color': piece.color,
                  '--confetti-start-x': `${piece.startX}vw`,
                  '--confetti-drift': `${piece.drift}px`,
                  '--confetti-rotation': `${piece.rotation}deg`,
                  '--confetti-size': `${piece.size}px`,
                  '--confetti-duration': `${piece.duration}ms`,
                  '--confetti-delay': `${piece.delay}ms`
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}
