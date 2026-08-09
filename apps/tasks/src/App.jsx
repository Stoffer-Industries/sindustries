import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardContainer,
  Dropdown,
  DropdownDivider,
  DropdownOption,
  Field,
  Input,
  SearchInput,
  Select,
  Tooltip,
  cx
} from '@sindustries/ui/react';
import { useTasks } from './useTasks.js';
import { useTaskDrafts } from './useTaskDrafts.js';
import { fetchTask } from './tasksApi';
import { useDebounce } from './hooks/useDebounce.js';
import { usePulseCelebration } from './hooks/usePulseCelebration.js';
import { useToast } from './hooks/useToast.js';
import { ConfettiLayer } from './components/ConfettiLayer.jsx';
import { TaskCardSummary } from './components/TaskCardSummary.jsx';
import { TaskEditor } from './components/TaskEditor.jsx';
import { ToastStack } from './components/ToastStack.jsx';
import { STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_SCORE, ASSIGNEE_OPTIONS, TASK_TYPES, TASK_TYPE_LABELS } from './utils/constants.js';
import { normalizeTaskForEditor, taskCardTilt } from './utils/helpers.js';
import { getStoredView, setStoredView } from './utils/storage.js';

function isReadyTask(task) {
  return task.status === 'ready';
}

function cardState(task, isSelected) {
  if (task.archivedAt) return 'archived';
  if (isSelected) return 'editing';
  if (task.blocked || task.dependencyBlocked) return 'blocked';
  if (isReadyTask(task)) return 'ready';
  return undefined;
}

export function App() {
  const [view, setView] = useState(getStoredView);
  const [selectedId, setSelectedId] = useState(null);
  const initialStatusSelection = ['open', 'ready', 'doing', 'acceptance'];
  const [filters, setFilters] = useState({ q: '', status: initialStatusSelection.join(','), priority: '', tag: '', assignee: '', taskType: '', includeArchived: false });
  const [selectedStatuses, setSelectedStatuses] = useState(() => new Set(initialStatusSelection));
  const [openFilterMenu, setOpenFilterMenu] = useState(null);
  const statusMenuRef = useRef(null);
  const priorityMenuRef = useRef(null);
  const assigneeMenuRef = useRef(null);
  const taskTypeMenuRef = useRef(null);
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
      taskType: taskTypeMenuRef,
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
  const [submittingCommentForTaskId, setSubmittingCommentForTaskId] = useState(null);
  const taskCardRefs = useRef({});
  const { confettiBursts, triggerCelebration, hoverProps: pulseHoverProps } = usePulseCelebration();

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

  return (
    <main className="app-shell">
      <header className="hero-header">
        <div className="hero-pattern" aria-hidden="true" />
        <div className="hero-content">
          <div className="brand-wrap">
            <button
              type="button"
              className="brand brand-btn si-font-display"
              onClick={triggerCelebration}
              aria-label="Ring Pulse sales bell"
              {...pulseHoverProps}
            >
              Pulse
            </button>
          </div>
          <div className="hero-controls">
            <SearchInput
              className="header-search"
              label="Search"
              placeholder="Search title or description"
              value={filters.q}
              onChange={(e) => setFilters((current) => ({ ...current, q: e.target.value }))}
            />
            <Button variant="nav" active={view === 'backlog'} onClick={() => setView('backlog')}>Backlog</Button>
            <Button variant="nav" active={view === 'board'} onClick={() => { setView('board'); setFilters((current) => ({ ...current, status: '' })); }}>Kanban</Button>
            <Button type="button" variant="primary" tone="display" onClick={() => setNewTask((current) => ({ ...current, expanded: true }))}>+ New Task</Button>
          </div>
        </div>
      </header>

      <section className="content">
        <CardContainer variant="filter">
          <CardContainer.Content>
            <div className="filter-row">
              <div className="filter-controls">
            <div className="status-filter" ref={statusMenuRef}>
              <Button
                type="button"
                variant="filter"
                active={selectedStatuses.size !== STATUSES.length}
                className="filter-trigger"
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
              </Button>

              {openFilterMenu === 'status' ? (
                <Dropdown className="filter-menu" role="menu" aria-label="Status filter menu">
                  <DropdownOption as="label" role="menuitemcheckbox" aria-checked={selectedStatuses.size === STATUSES.length}>
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
                  </DropdownOption>

                  <DropdownDivider />

                  {STATUSES.map((status) => (
                    <DropdownOption as="label" key={status} role="menuitemcheckbox" aria-checked={selectedStatuses.has(status)}>
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
                    </DropdownOption>
                  ))}
                </Dropdown>
              ) : null}
            </div>
            <div className="status-filter" ref={priorityMenuRef}>
              <Button
                type="button"
                variant="filter"
                active={Boolean(filters.priority)}
                className="filter-trigger"
                aria-label="Priority filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'priority'}
                onClick={() => setOpenFilterMenu((current) => (current === 'priority' ? null : 'priority'))}
              >
                {`PRIORITY: ${(filters.priority ? filters.priority : 'All priorities').toUpperCase()}`}
              </Button>
              {openFilterMenu === 'priority' ? (
                <Dropdown className="filter-menu" role="menu" aria-label="Priority filter menu">
                  <DropdownOption
                    type="button"
                    role="menuitemradio"
                    aria-checked={!filters.priority}
                    onClick={() => {
                      setFilters((current) => ({ ...current, priority: '' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    ALL PRIORITIES
                  </DropdownOption>
                  <DropdownDivider />
                  {PRIORITIES.map((priority) => (
                    <DropdownOption
                      key={priority}
                      type="button"
                      role="menuitemradio"
                      aria-checked={filters.priority === priority}
                      onClick={() => {
                        setFilters((current) => ({ ...current, priority }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      {priority.toUpperCase()}
                    </DropdownOption>
                  ))}
                </Dropdown>
              ) : null}
            </div>

            <div className="status-filter" ref={assigneeMenuRef}>
              <Button
                type="button"
                variant="filter"
                active={Boolean(filters.assignee)}
                className="filter-trigger"
                aria-label="Assignee filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'assignee'}
                onClick={() => setOpenFilterMenu((current) => (current === 'assignee' ? null : 'assignee'))}
              >
                {`ASSIGNEE: ${(filters.assignee ? (filters.assignee === 'unassigned' ? 'Unassigned' : filters.assignee) : 'All').toUpperCase()}`}
              </Button>
              {openFilterMenu === 'assignee' ? (
                <Dropdown className="filter-menu" role="menu" aria-label="Assignee filter menu">
                  <DropdownOption
                    type="button"
                    role="menuitemradio"
                    aria-checked={!filters.assignee}
                    onClick={() => {
                      setFilters((current) => ({ ...current, assignee: '' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    ALL
                  </DropdownOption>
                  <DropdownOption
                    type="button"
                    role="menuitemradio"
                    aria-checked={filters.assignee === 'unassigned'}
                    onClick={() => {
                      setFilters((current) => ({ ...current, assignee: 'unassigned' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    UNASSIGNED
                  </DropdownOption>
                  <DropdownDivider />
                  {ASSIGNEE_OPTIONS.map((assignee) => (
                    <DropdownOption
                      key={assignee}
                      type="button"
                      role="menuitemradio"
                      aria-checked={filters.assignee === assignee}
                      onClick={() => {
                        setFilters((current) => ({ ...current, assignee }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      {assignee.toUpperCase()}
                    </DropdownOption>
                  ))}
                </Dropdown>
              ) : null}
            </div>

            <div className="status-filter" ref={taskTypeMenuRef}>
              <Button
                type="button"
                variant="filter"
                active={Boolean(filters.taskType)}
                className="filter-trigger"
                aria-label="Task type filter"
                aria-haspopup="menu"
                aria-expanded={openFilterMenu === 'taskType'}
                onClick={() => setOpenFilterMenu((current) => (current === 'taskType' ? null : 'taskType'))}
              >
                {`TYPE: ${(filters.taskType ? TASK_TYPE_LABELS[filters.taskType] : 'All types').toUpperCase()}`}
              </Button>
              {openFilterMenu === 'taskType' ? (
                <Dropdown className="filter-menu" role="menu" aria-label="Task type filter menu">
                  <DropdownOption
                    type="button"
                    role="menuitemradio"
                    aria-checked={!filters.taskType}
                    onClick={() => {
                      setFilters((current) => ({ ...current, taskType: '' }));
                      setOpenFilterMenu(null);
                    }}
                  >
                    ALL TYPES
                  </DropdownOption>
                  <DropdownDivider />
                  {TASK_TYPES.map((taskType) => (
                    <DropdownOption
                      key={taskType}
                      type="button"
                      role="menuitemradio"
                      aria-checked={filters.taskType === taskType}
                      onClick={() => {
                        setFilters((current) => ({ ...current, taskType }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      {TASK_TYPE_LABELS[taskType].toUpperCase()}
                    </DropdownOption>
                  ))}
                </Dropdown>
              ) : null}
            </div>

            {allTags.length > 0 ? (
              <div className="status-filter" ref={tagMenuRef}>
                <Button
                  type="button"
                  variant="filter"
                  active={Boolean(filters.tag)}
                  className="filter-trigger"
                  aria-label="Tag filter"
                  aria-haspopup="menu"
                  aria-expanded={openFilterMenu === 'tag'}
                  onClick={() => setOpenFilterMenu((current) => (current === 'tag' ? null : 'tag'))}
                >
                  {`TAG: ${(filters.tag ? filters.tag : 'All tags').toUpperCase()}`}
                </Button>
                {openFilterMenu === 'tag' ? (
                  <Dropdown className="filter-menu" role="menu" aria-label="Tag filter menu">
                    <DropdownOption
                      type="button"
                      role="menuitemradio"
                      aria-checked={!filters.tag}
                      onClick={() => {
                        setFilters((current) => ({ ...current, tag: '' }));
                        setOpenFilterMenu(null);
                      }}
                    >
                      ALL TAGS
                    </DropdownOption>
                    <DropdownDivider />
                    {allTags.map((tag) => (
                      <DropdownOption
                        key={tag}
                        type="button"
                        role="menuitemradio"
                        aria-checked={filters.tag === tag}
                        onClick={() => {
                          setFilters((current) => ({ ...current, tag }));
                          setOpenFilterMenu(null);
                        }}
                      >
                        {tag.toUpperCase()}
                      </DropdownOption>
                    ))}
                  </Dropdown>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="filter-actions">
            <Button
              variant="ghost"
              tone="display"
              active={filters.includeArchived}
              onClick={() => setFilters((current) => ({ ...current, includeArchived: !current.includeArchived }))}
            >
              {filters.includeArchived ? 'Hide archived' : 'Show archived'}
            </Button>
          </div>
            </div>
          </CardContainer.Content>
        </CardContainer>

        {newTask.expanded ? (
          <Card as="form" variant="pulse" onSubmit={createTask} className="task-card stack create-card content-inset" aria-label="New task form">
            <div className="task-create-header">
              <h2 className="si-font-display">New Task</h2>
              <Button
                type="button"
                variant="ghost"
                tone="display"
                onClick={() => setNewTask((current) => ({ ...current, expanded: false }))}
              >
                Cancel
              </Button>
            </div>

            <div className="editor-grid">
              <Field label="Title" style={{ gridColumn: '1 / -1' }}>
                <Input
                  aria-label="New task title"
                  value={newTask.title}
                  onChange={(e) => setNewTask((current) => ({ ...current, title: e.target.value }))}
                  required
                />
              </Field>
              <Field label="Description" style={{ gridColumn: '1 / -1' }}>
                <Input value={newTask.description} onChange={(e) => setNewTask((current) => ({ ...current, description: e.target.value }))} />
              </Field>
              <Field label="Priority">
                <Select value={newTask.priority} onChange={(e) => setNewTask((current) => ({ ...current, priority: e.target.value }))}>
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>{priority}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Assignee">
                <Input value={newTask.assignee} onChange={(e) => setNewTask((current) => ({ ...current, assignee: e.target.value }))} />
              </Field>
              <Field label="Due date">
                <Input type="date" value={newTask.dueAt} onChange={(e) => setNewTask((current) => ({ ...current, dueAt: e.target.value }))} />
              </Field>
              <Field label="Tags">
                <Input value={newTask.tagsText} onChange={(e) => setNewTask((current) => ({ ...current, tagsText: e.target.value }))} placeholder="api, pulse" />
              </Field>
              <Field label="Content type">
                <Select value={newTask.taskType} onChange={(e) => setNewTask((current) => ({ ...current, taskType: e.target.value }))}>
                  <option value="">None</option>
                  {TASK_TYPES.map((taskType) => (
                    <option key={taskType} value={taskType}>{TASK_TYPE_LABELS[taskType]}</option>
                  ))}
                </Select>
              </Field>
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
              <Button type="submit" variant="primary" tone="display">Create task</Button>
            </div>
          </Card>
        ) : null}

        {error ? <p role="alert" className="si-alert si-alert--error content-inset">{error}</p> : null}

        {isLoading && tasks.length === 0 ? (
          <div className="loading-spinner content-inset" role="status" aria-label="Loading tasks">
            <div className="spinner" />
            <span className="sr-only">Loading tasks...</span>
          </div>
        ) : null}

        {view === 'backlog' ? (
          <section className="content-inset">

            <ul aria-label="Backlog list" className="task-list">
               {sortedBacklogTasks.map((task, index) => {  
                const isSelected = selectedId === task.id;
                const draft = getDraft(task);
                const hasDraft = isTaskDirty(task);
                return (
                  <li key={task.id ?? `${task.status}-${task.title}-${index}`}>
                    <Card
                      as="article"
                      variant="pulse"
                      interactive
                      tilt={isSelected ? undefined : taskCardTilt(task.id)}
                      state={cardState(task, isSelected)}
                      ref={(el) => { if (el) taskCardRefs.current[String(task.id)] = el; }}
                      className="task-card"
                      onClick={() => {
                        if (!isSelected) openTask(task.id);
                      }}
                    >
                      {!isSelected ? (
                        <TaskCardSummary
                          task={task}
                          hasDraft={hasDraft}
                          onTitleClick={(e) => {
                            e.stopPropagation();
                            toggleTask(task.id, isSelected);
                          }}
                        />
                      ) : (
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
                          onPatch={async (patch) => {
                            const didSave = await patchTask(task.id, patch);
                            if (didSave) clearDraft(task.id);
                            return didSave;
                          }}
                          onArchive={() => archiveTask(task.id)}
                          onClose={() => {
                            setSelectedId(null);
                            scrollToTaskIfNeeded(task.id);
                          }}
                          onAddComment={(payload) => createTaskComment(task.id, payload)}
                          onFetchDependency={fetchTask}
                          onUpdateDependencies={(dependsOnIds) => patchTask(task.id, { dependsOnIds })}
                          onOpenTask={openTask}
                          onTaskRefresh={refreshTask}
                          isSubmittingComment={submittingCommentForTaskId === task.id}
                        />
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section aria-label="Kanban board" className="board-wrap">
            <div className="board" style={{ '--visible-columns': visibleColumnCount }}>
              {STATUSES.map((status) => (
                <CardContainer
                  as="div"
                  variant="column"
                  key={status}
                  data-testid={`column-${status}`}
                  className={cx(!selectedStatuses.has(status) && 'si-card-container--hidden')}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('text/plain');
                    if (id) patchTask(id, { status });
                  }}
                >
                  <CardContainer.Header>
                    <h3 className="si-font-display si-card-container__title">{STATUS_LABELS[status]}</h3>
                    <Tooltip>{boardColumns[status].length}</Tooltip>
                  </CardContainer.Header>
                  <CardContainer.Content>
                    <ol>
                      {boardColumns[status].map((task, index) => {
                        const isSelected = selectedId === task.id;
                        const draft = getDraft(task);
                        const hasDraft = isTaskDirty(task);
                        return (
                          <li key={task.id ?? `${status}-${task.title}-${index}`}>
                            <Card
                              as="article"
                              variant="pulse"
                              interactive
                              tilt={isSelected ? undefined : taskCardTilt(task.id)}
                              state={cardState(task, isSelected)}
                              ref={(el) => { if (el) taskCardRefs.current[String(task.id)] = el; }}
                              data-testid={`card-${task.id}`}
                              className="board-card"
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
                              {!isSelected ? (
                                <TaskCardSummary
                                  task={task}
                                  hasDraft={hasDraft}
                                  onTitleClick={(e) => {
                                    e.stopPropagation();
                                    toggleTask(task.id, isSelected);
                                  }}
                                />
                              ) : (
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
                                  onPatch={async (patch) => {
                                    const didSave = await patchTask(task.id, patch);
                                    if (didSave) clearDraft(task.id);
                                    return didSave;
                                  }}
                                  onArchive={() => archiveTask(task.id)}
                                  onClose={() => {
                                    setSelectedId(null);
                                    scrollToTaskIfNeeded(task.id);
                                  }}
                                  onAddComment={(payload) => createTaskComment(task.id, payload)}
                                  onFetchDependency={fetchTask}
                                  onUpdateDependencies={(dependsOnIds) => patchTask(task.id, { dependsOnIds })}
                                  onOpenTask={openTask}
                                  onTaskRefresh={refreshTask}
                                  isSubmittingComment={submittingCommentForTaskId === task.id}
                                />
                              )}
                            </Card>
                          </li>
                        );
                      })}
                    </ol>
                  </CardContainer.Content>
                </CardContainer>
              ))}
            </div>
          </section>
        )}
      </section>

      <nav className="mobile-nav" aria-label="Primary">
        <Button variant="ghost" tone="display" active={view === 'backlog'} onClick={() => setView('backlog')}>List</Button>
        <Button variant="primary" tone="display" className="fab" onClick={() => setNewTask((current) => ({ ...current, expanded: true }))}>＋</Button>
        <Button variant="ghost" tone="display" active={view === 'board'} onClick={() => { setView('board'); setFilters((current) => ({ ...current, status: '' })); }}>Board</Button>
      </nav>

      <ToastStack toasts={toasts} />

      {/* Accessibility: announce task count to screen readers */}
      <div className="sr-only" role="status" aria-live="polite">
        {isLoading ? 'Loading tasks...' : `${tasks.length} tasks`}
      </div>

      <ConfettiLayer bursts={confettiBursts} />
    </main>
  );
}
