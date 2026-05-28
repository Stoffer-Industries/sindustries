// Task-related types
export interface TaskFilters {
  q?: string;
  status?: string;
  priority?: string;
  tag?: string;
  assignee?: string;
  includeArchived?: boolean;
  // Note: 'ready' boolean filter is deprecated — use status='ready' or status='triage' instead
}

export interface Comment {
  id?: string | number;
  author: string;
  text: string;
  createdAt?: string;
}

export interface TaskHistoryEntry {
  id?: string | number;
  field: string;
  oldValue?: string | null;
  newValue?: string | null;
  actor: string;
  createdAt?: string;
}

export interface Task {
  id: string | number;
  title: string;
  description?: string | null;
  status: string;  // open | triage | ready | doing | acceptance | done
  priority: string;
  assignee?: string | null;
  dueAt?: string | null;
  tags?: Array<{ name: string } | string>;
  blocked?: boolean;
  archivedAt?: string | null;
  createdAt?: string | null;
  statusChangedAt?: string | null;
  comments?: Comment[];
  history?: TaskHistoryEntry[];
}

export interface CreateTaskPayload {
  title: string;
  description?: string | null;
  priority?: string;
  dueAt?: string | null;
  assignee?: string | null;
  tags?: string[];
  blocked?: boolean;
  // Note: 'ready' field removed — use status='triage' or status='ready' instead
}

export interface UpdateTaskPayload {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assignee?: string | null;
  dueAt?: string | null;
  tags?: string[];
  blocked?: boolean;
  ready?: boolean;
  actor?: string;
  // Note: 'ready' field removed — use status field instead
}

export interface CreateCommentPayload {
  author: string;
  text: string;
}

// API Response wrapper
interface ApiResponse<T> {
  data: T;
  error?: {
    message: string;
  };
}

const DEFAULT_API_BASE_BY_PORT: Record<string, string> = {
  '5173': 'http://localhost:4000/api/v1',
  '5174': 'http://localhost:4001/api/v1'
};

const API_BASE =
  import.meta.env.VITE_TASKS_API_BASE_URL
  ?? DEFAULT_API_BASE_BY_PORT[window.location.port]
  ?? 'http://localhost:4000/api/v1';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options
  });

  const body = await response.json() as ApiResponse<T>;
  if (!response.ok) throw new Error(body?.error?.message ?? 'Request failed');
  return body.data;
}

/**
 * Fetch tasks with optional filters
 */
export async function fetchTasks(filters: TaskFilters): Promise<Task[]> {
  const query = new URLSearchParams({ sort: 'priority', limit: '10000' });
  if (filters.q) query.set('q', filters.q);
  if (filters.status) query.set('status', filters.status);
  if (filters.priority) query.set('priority', filters.priority);
  if (filters.tag) query.set('tag', filters.tag);
  if (filters.assignee) query.set('assignee', filters.assignee);
  if (filters.includeArchived) query.set('includeArchived', 'true');
  // Note: 'ready' boolean filter is deprecated — use status='ready' or status='triage' instead
  return api<Task[]>('/tasks?' + query.toString());
}

/**
 * Create a new task
 */
export async function createTask(payload: CreateTaskPayload): Promise<Task> {
  return api<Task>('/tasks', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * Update an existing task
 */
export async function updateTask(id: string | number, patch: UpdateTaskPayload): Promise<Task> {
  return api<Task>('/tasks/' + id, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

/**
 * Fetch a single task by ID
 */
export async function fetchTask(id: string | number): Promise<Task> {
  return api<Task>('/tasks/' + id);
}

/**
 * Archive a task
 */
export async function archiveTask(id: string | number): Promise<null> {
  return api<null>('/tasks/' + id, { method: 'DELETE' });
}

/**
 * Add a comment to a task
 */
export async function createTaskComment(id: string | number, payload: CreateCommentPayload): Promise<Comment> {
  return api<Comment>('/tasks/' + id + '/comments', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}
