import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchTasks,
  createTask,
  updateTask,
  fetchTask,
  archiveTask,
  createTaskComment
} from '../tasksApi.ts';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create mock response
const mockResponse = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue({ data })
});

describe('tasksApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default port for tests
    vi.spyOn(window, 'location', 'value').mockValue({
      port: '5173'
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchTasks', () => {
    it('fetches tasks with no filters', async () => {
      const tasks = [{ id: 1, title: 'Task 1' }];
      mockFetch.mockResolvedValueOnce(mockResponse(tasks));

      const result = await fetchTasks({});

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks?sort=priority&limit=100',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual(tasks);
    });

    it('adds query parameters for filters', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]));

      await fetchTasks({ q: 'test', status: 'open', priority: 'high' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('q=test'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('status=open'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('priority=high'),
        expect.any(Object)
      );
    });

    it('includes archived flag when set', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]));

      await fetchTasks({ includeArchived: true });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('includeArchived=true'),
        expect.any(Object)
      );
    });

    it('throws error on failed request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: { message: 'Not found' } })
      });

      await expect(fetchTasks({})).rejects.toThrow('Not found');
    });
  });

  describe('createTask', () => {
    it('creates task with payload', async () => {
      const task = { id: 1, title: 'New Task' };
      mockFetch.mockResolvedValueOnce(mockResponse(task));

      const result = await createTask({ title: 'New Task' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'New Task' })
        })
      );
      expect(result).toEqual(task);
    });

    it('sends full payload', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      await createTask({
        title: 'Task',
        description: 'Description',
        priority: 'high',
        dueAt: '2024-01-15',
        assignee: 'John',
        tags: ['tag1'],
        blocked: true
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(expect.objectContaining({
            title: 'Task',
            description: 'Description',
            priority: 'high',
            dueAt: '2024-01-15',
            assignee: 'John',
            tags: ['tag1'],
            blocked: true
          }))
        })
      );
    });
  });

  describe('updateTask', () => {
    it('updates task with patch', async () => {
      const task = { id: 1, title: 'Updated' };
      mockFetch.mockResolvedValueOnce(mockResponse(task));

      const result = await updateTask(1, { title: 'Updated', status: 'done', dependsOnIds: ['dep-1'] });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks/1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Updated', status: 'done', dependsOnIds: ['dep-1'] })
        })
      );
      expect(result).toEqual(task);
    });
  });

  describe('fetchTask', () => {
    it('fetches single task by id', async () => {
      const task = { id: 1, title: 'Task' };
      mockFetch.mockResolvedValueOnce(mockResponse(task));

      const result = await fetchTask(1);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks/1',
        expect.any(Object)
      );
      expect(result).toEqual(task);
    });

    it('handles string id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      await fetchTask('abc-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks/abc-123',
        expect.any(Object)
      );
    });
  });

  describe('archiveTask', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null));

      const result = await archiveTask(1);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks/1',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result).toBeNull();
    });
  });

  describe('createTaskComment', () => {
    it('posts comment to task', async () => {
      const comment = { id: 1, author: 'John', text: 'Comment' };
      mockFetch.mockResolvedValueOnce(mockResponse(comment));

      const result = await createTaskComment(1, { author: 'John', text: 'Comment' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/tasks/1/comments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ author: 'John', text: 'Comment' })
        })
      );
      expect(result).toEqual(comment);
    });
  });
});
