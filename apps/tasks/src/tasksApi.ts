// Task-related types
export interface TaskFilters {
  q?: string;
  status?: string;
  priority?: string;
  tag?: string;
  assignee?: string;
  taskType?: TaskType | '';
  includeArchived?: boolean;
  // Discovery-queue ownership filters. Both query the API for tasks where the
  // named owner has an outstanding handoff (`workflowGateOwner`) or an
  // exceptional / unmodelled attention request (`attentionOwner`). They are
  // independent surfaces — see `apps/tasks/SPEC.md` Flow 9.
  workflowGateOwner?: string;
  attentionOwner?: string;
  // Note: 'ready' boolean filter is deprecated; use status='ready' instead
}

export type TaskType = 'content' | 'code' | 'research' | 'feature';

export interface Comment {
  id?: string | number;
  author: string;
  text: string;
  createdAt?: string;
}

export interface DependencyReference {
  id: string | number;
  title: string;
  status: string;
  completedAt?: string | null;
}

export interface Task {
  id: string | number;
  title: string;
  description?: string | null;
  status: string;  // open | ready | doing | acceptance | done
  priority: string;
  assignee?: string | null;
  dueAt?: string | null;
  tags?: Array<{ name: string } | string>;
  blocked?: boolean;
  taskType?: TaskType | null;
  archivedAt?: string | null;
  createdAt?: string | null;
  statusChangedAt?: string | null;
  comments?: Comment[];
  approvals?: TaskApproval[];
  dependsOn?: DependencyReference[];
  dependsOnIds?: Array<string | number>;
  dependencyBlocked?: boolean;
  workflowGates?: Array<{ type?: string; gate?: string; owner?: string | null; state: string }>;
  attentionOwners?: string[];
  topAttentionOwner?: string | null;
  attentionOwnerDetails?: Array<{ id: string; owner: string; position: number; addedBy?: string | null; note?: string | null; createdAt: string }>;
}

export interface CreateTaskPayload {
  title: string;
  description?: string | null;
  priority?: string;
  dueAt?: string | null;
  assignee?: string | null;
  tags?: string[];
  blocked?: boolean;
  dependsOnIds?: Array<string | number>;
  taskType?: TaskType | null;
  // Note: 'ready' field removed; use status='ready' instead
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
  taskType?: TaskType | null;
  dependsOnIds?: Array<string | number>;
  // Note: 'ready' field removed — use status field instead
}

export interface CreateCommentPayload {
  author: string;
  text: string;
}

export type ApprovalType = 'spec' | 'tech_design' | 'qa_agent' | 'accepted';
export type ApprovalState = 'approved' | 'revoked';

export interface TaskApproval {
  id: string;
  type: ApprovalType;
  owner: string;
  state: ApprovalState;
  approvedAt: string;
  revokedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequiredApprovals {
  taskType: TaskType;
  requiredApprovals: ApprovalType[];
  version: number;
  source: 'config-file' | 'builtin-default';
}

export interface CreateTaskApprovalPayload {
  type: ApprovalType;
  note?: string;
}

export interface AuthActor {
  actor?: string;
  username?: string;
  displayName?: string | null;
  approvalTypes: ApprovalType[];
  expiresAt?: string;
}

export interface LoginPayload {
  username: string;
  password: string;
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
  ?? 'http://localhost:4001/api/v1';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    credentials: 'include',
    ...options
  });

  const body = response.status === 204
    ? ({ data: null } as ApiResponse<T>)
    : await response.json() as ApiResponse<T>;
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
  if (filters.taskType) query.set('taskType', filters.taskType);
  if (filters.workflowGateOwner) query.set('workflowGateOwner', filters.workflowGateOwner);
  if (filters.attentionOwner) query.set('attentionOwner', filters.attentionOwner);
  if (filters.includeArchived) query.set('includeArchived', 'true');
  // Note: 'ready' boolean filter is deprecated; use status='ready' instead
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

/**
 * Fetch the required approvals for a given task type.
 * Used by the editor's Approvals section to resolve which `<ApprovalType>`
 * rows to render for a task. The Tasks API reads a configurable YAML file
 * plus a built-in default; this endpoint exposes the resolved list.
 */
export async function fetchRequiredApprovals(taskType: TaskType): Promise<RequiredApprovals> {
  return api<RequiredApprovals>(`/task-types/${taskType}/required-approvals`);
}

/** Resolve the current browser session. */
export async function fetchAuthSession(): Promise<AuthActor> {
  return api<AuthActor>('/auth/session', { credentials: 'include' });
}

/** Establish an HttpOnly-cookie browser session. */
export async function login(payload: LoginPayload): Promise<AuthActor> {
  return api<AuthActor>('/auth/session', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(payload)
  });
}

/** End the current browser session. */
export async function logout(): Promise<null> {
  return api<null>('/auth/session', {
    method: 'DELETE',
    credentials: 'include'
  });
}

/**
 * Approve a task as the authenticated browser user. Ownership is derived from
 * the session by the API and must never be supplied by the UI.
 */
export async function createTaskApproval(
  id: string | number,
  payload: CreateTaskApprovalPayload
): Promise<TaskApproval> {
  return api<TaskApproval>(`/tasks/${id}/approvals`, {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(payload)
  });
}

/** Revoke an approval as the authenticated browser user. */
export async function deleteTaskApproval(
  id: string | number,
  type: ApprovalType
): Promise<TaskApproval | null> {
  return api<TaskApproval | null>(`/tasks/${id}/approvals/${type}`, {
    method: 'DELETE',
    credentials: 'include'
  });
}
