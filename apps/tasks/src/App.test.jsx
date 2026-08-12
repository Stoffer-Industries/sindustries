import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.jsx';

// Mock the auth-session call so App mount doesn't drain a tasks-fetch mock
// in tests that rely on `vi.fn().mockResolvedValueOnce(...)` chains. The
// default returns an unauthenticated session; individual tests can override
// via `fetchAuthSession.mockResolvedValueOnce(...)` if needed.
vi.mock('./tasksApi.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAuthSession: vi.fn().mockResolvedValue({ displayName: null })
}));

function mockTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Task 1',
    status: 'open',
    statusChangedAt: '2026-03-01T00:00:00.000Z',
    priority: 'medium',
    comments: [],
    ...overrides
  };
}

function ensureLocalStorage() {
  if (window.localStorage) return;

  const store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      removeItem: (key) => store.delete(key),
      setItem: (key, value) => store.set(key, String(value))
    }
  });
}

describe('tasks ui', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ensureLocalStorage();
    window.localStorage.clear();
  });

  it('renders existing comments in the task detail view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [mockTask({
            id: 'commented-task',
            title: 'Commented task',
            comments: [
              {
                id: 'comment-1',
                author: 'Quinn',
                text: 'Backend slice is in.',
                createdAt: '2026-03-12T09:00:00.000Z'
              }
            ]
          })]
        })
      })
    );

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Commented task' }));

    expect(screen.getByRole('heading', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByText('1 comment')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Task comments' })).toBeInTheDocument();
    expect(screen.getByText('Backend slice is in.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Task comments' })).toHaveTextContent('Quinn');
    expect(screen.getByRole('button', { name: 'Comment', exact: true })).toHaveAttribute('aria-expanded', 'false');
  });

  it('creates a comment, disables submit while pending, and clears/closes the composer on success', async () => {
    let comments = [
      {
        id: 'comment-1',
        author: 'Tom',
        text: 'Oldest comment',
        createdAt: '2026-03-12T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Quinn',
        text: 'Newer existing comment',
        createdAt: '2026-03-12T09:30:00.000Z'
      }
    ];
    let resolvePost;

    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [mockTask({ id: 'comment-create-task', title: 'Comment create task', comments: [] })]
          })
        });
      }

      if (method === 'GET' && urlText.endsWith('/tasks/comment-create-task')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: mockTask({ id: 'comment-create-task', title: 'Comment create task', comments })
          })
        });
      }

      if (method === 'POST' && urlText.includes('/tasks/comment-create-task/comments')) {
        return new Promise((resolve) => {
          resolvePost = () => {
            comments = [
              ...comments,
              {
                id: 'comment-3',
                author: 'Rowan',
                text: 'UI slice landed.',
                createdAt: '2026-03-12T10:00:00.000Z'
              }
            ];
            resolve({
              ok: true,
              json: async () => ({ data: comments.at(-1) })
            });
          };
        });
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Comment create task' }));

    const toggleButton = screen.getByRole('button', { name: 'Comment' });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggleButton);
    const closeComposerButton = screen.getAllByRole('button', { name: 'Close' }).find((button) => button.getAttribute('aria-controls') === 'task-comment-composer');
    expect(closeComposerButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(screen.getByLabelText('Comment author'), { target: { value: 'Rowan' } });
    fireEvent.change(screen.getByLabelText('Comment text'), { target: { value: 'UI slice landed.' } });

    const addCommentButton = screen.getByRole('button', { name: 'Add comment' });
    fireEvent.click(addCommentButton);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled());
    resolvePost();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/tasks/comment-create-task/comments'), expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.getByText('UI slice landed.')).toBeInTheDocument());
    expect(screen.queryByLabelText('Comment author')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Comment text')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment', exact: true })).toHaveAttribute('aria-expanded', 'false');

    const commentItems = within(screen.getByRole('list', { name: 'Task comments' })).getAllByRole('listitem');
    expect(within(commentItems[0]).getByText('UI slice landed.')).toBeInTheDocument();
    expect(within(commentItems[1]).getByText('Newer existing comment')).toBeInTheDocument();
    expect(within(commentItems[2]).getByText('Oldest comment')).toBeInTheDocument();
  });

  it('renders backlog list and filter controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [mockTask()] }) }));

    render(<App />);

    // Click Backlog button to switch from default Kanban view
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    expect(await screen.findByRole('list', { name: 'Backlog list' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Status filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Task type filter')).toBeInTheDocument();
  });

  it('filters tasks by task type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [mockTask({ taskType: 'feature' })] }) });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByLabelText('Task type filter'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'FEATURE' }));

    await waitFor(() => {
      const typeFilterCall = fetchMock.mock.calls.find(([url]) => String(url).includes('taskType=feature'));
      expect(typeFilterCall?.[0]).toContain('taskType=feature');
    });
    expect(screen.getByLabelText('Task type filter')).toHaveTextContent('TYPE: FEATURE');
  });

  it('renders board columns sorted by priority, readiness, then createdAt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            mockTask({ id: 'newer', title: 'Newer', status: 'ready', priority: 'medium', createdAt: '2026-03-02T00:00:00.000Z' }),
            mockTask({ id: 'older', title: 'Older', status: 'ready', priority: 'medium', createdAt: '2026-03-01T00:00:00.000Z' })
          ]
        })
      })
    );

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));

    const readyColumn = await screen.findByTestId('column-ready');
    const cards = within(readyColumn).getAllByRole('article');
    expect(cards[0]).toHaveTextContent('Older');
    expect(cards[1]).toHaveTextContent('Newer');
  });

  it('shows tags, priority, assignee, and date on collapsed kanban cards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [mockTask({
            id: 'assigned',
            title: 'Assigned',
            assignee: 'Quinn',
            priority: 'urgent',
            tags: [{ name: 'api' }, { name: 'backend' }],
            statusChangedAt: '2026-03-07T00:00:00.000Z'
          })]
        })
      })
    );

    render(<App />);

    const card = await screen.findByTestId('card-assigned');
    expect(within(card).getByRole('button', { name: 'Assigned' })).toBeInTheDocument();
    expect(within(card).getByText('api')).toBeInTheDocument();
    expect(within(card).getByText('backend')).toBeInTheDocument();
    expect(within(card).getByText('urgent')).toBeInTheDocument();
    const assigneeAvatar = within(card).getByLabelText('delivery assignee Quinn');
    expect(assigneeAvatar.querySelector('.si-avatar')).not.toBeNull();
    const assigneeImg = assigneeAvatar.querySelector('img');
    expect(assigneeImg).not.toBeNull();
    expect(assigneeImg).toHaveAttribute('src', '/avatars/quinn.png');
    expect(assigneeImg).toHaveAttribute('alt', 'Quinn');
    expect(within(card).getByText('2026-03-07')).toBeInTheDocument();
  });

  it('marks dependency-blocked tasks with the blocked card state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [mockTask({
            id: 'dependency-blocked',
            title: 'Dependency blocked',
            dependencyBlocked: true,
            blocked: false
          })]
        })
      })
    );

    render(<App />);

    const card = await screen.findByTestId('card-dependency-blocked');
    expect(card).toHaveClass('si-card--blocked');
  });

  it('opens a dependency that is outside the current task collection', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              mockTask({
                id: 'visible-task',
                title: 'Visible task',
                dependsOn: [{ id: 'done-dependency', title: 'Done dependency', status: 'done' }],
                dependsOnIds: ['done-dependency']
              })
            ]
          })
        };
      }

      if (method === 'GET' && urlText.endsWith('/tasks/visible-task')) {
        return {
          ok: true,
          json: async () => ({
            data: mockTask({
              id: 'visible-task',
              title: 'Visible task',
              dependsOn: [{ id: 'done-dependency', title: 'Done dependency', status: 'done' }],
              dependsOnIds: ['done-dependency']
            })
          })
        };
      }

      if (method === 'GET' && urlText.endsWith('/tasks/done-dependency')) {
        return {
          ok: true,
          json: async () => ({
            data: mockTask({
              id: 'done-dependency',
              title: 'Done dependency',
              status: 'done'
            })
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Visible task' }));
    fireEvent.click(screen.getByRole('button', { name: /Done dependency\s*Done/ }));

    await waitFor(() => expect(screen.getByLabelText('Detail title')).toHaveValue('Done dependency'));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/tasks/done-dependency'), expect.any(Object));
  });

  it('refreshes tasks when the window regains focus', async () => {
    localStorage.setItem('tasks-app-view', 'board');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [mockTask({ id: 'focus-task', title: 'Before refresh', status: 'open' })]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [mockTask({ id: 'focus-task', title: 'After refresh', status: 'open' })]
        })
      });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Before refresh' })).toBeInTheDocument();

    fireEvent(window, new Event('focus'));

    expect(await screen.findByRole('button', { name: 'After refresh' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves unsaved task edits when closing and reopening a ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [mockTask({ id: 'draft-task', title: 'Original title' })]
        })
      })
    );

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Original title' }));
    fireEvent.change(screen.getByLabelText('Detail title'), { target: { value: 'Draft title' } });
    expect(screen.getByLabelText('Detail title')).toHaveValue('Draft title');

    // Click the first Close button (there are now two - one in title row, one in actions)
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Original title' }));
    expect(screen.getByLabelText('Detail title')).toHaveValue('Draft title');
  });

  it('preserves and saves unsaved task type edits', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return {
          ok: true,
          json: async () => ({
            data: [mockTask({ id: 'type-draft-task', title: 'Type draft task', taskType: 'code' })]
          })
        };
      }

      if (method === 'PATCH' && urlText.includes('/tasks/type-draft-task')) {
        return {
          ok: true,
          json: async () => ({
            data: mockTask({ id: 'type-draft-task', title: 'Type draft task', taskType: 'feature' })
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Type draft task' }));
    fireEvent.change(screen.getByLabelText('Detail task type'), { target: { value: 'feature' } });

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Type draft task' }));
    expect(screen.getByLabelText('Detail task type')).toHaveValue('feature');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, options]) => String(url).includes('/tasks/type-draft-task') && options?.method === 'PATCH');
      expect(JSON.parse(patchCall?.[1]?.body ?? '{}')).toMatchObject({ taskType: 'feature' });
    });
  });

  it('restores unsaved task edits after remounting the page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [mockTask({ id: 'persisted-task', title: 'Persist me' })]
        })
      })
    );

    const firstRender = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Persist me' }));
    fireEvent.change(screen.getByLabelText('Detail title'), { target: { value: 'Restored draft' } });

    firstRender.unmount();

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Persist me' }));
    expect(screen.getByLabelText('Detail title')).toHaveValue('Restored draft');
  });

  it('creates and archives a task from the UI', async () => {
    let createdVisible = false;

    const fetchMock = vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'POST' && urlText.includes('/tasks')) {
        createdVisible = true;
        return { ok: true, json: async () => ({ data: mockTask({ id: 'created', title: 'Created' }) }) };
      }

      if (method === 'DELETE' && urlText.includes('/tasks/created')) {
        createdVisible = false;
        return { ok: true, json: async () => ({ data: { id: 'created', archivedAt: '2026-03-03T00:00:00.000Z' } }) };
      }

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return {
          ok: true,
          json: async () => ({
            data: createdVisible
              ? [mockTask(), mockTask({ id: 'created', title: 'Created' })]
              : [mockTask()]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));
    fireEvent.change(screen.getByLabelText('New task title'), { target: { value: 'Created' } });
    expect(screen.getByRole('option', { name: 'Feature' })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('None'), { target: { value: 'feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/tasks'), expect.objectContaining({ method: 'POST' })));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tasks'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"taskType":"feature"')
      })
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Created' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive task' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/tasks/created'), expect.objectContaining({ method: 'DELETE' })));
  });

  it('moves focus to the next editor field on Enter and saves from the last field', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return {
          ok: true,
          json: async () => ({
            data: [mockTask({ id: 'editor-task', title: 'Editor task', description: 'Line one' })]
          })
        };
      }

      if (method === 'PATCH' && urlText.includes('/tasks/editor-task')) {
        return {
          ok: true,
          json: async () => ({
            data: mockTask({ id: 'editor-task', title: 'Editor task', description: 'Line one', status: 'ready' })
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Editor task' }));

    const titleInput = screen.getByLabelText('Detail title');
    titleInput.focus();
    // Enter edit mode for description first
    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    fireEvent.keyDown(titleInput, { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(screen.getByLabelText('Detail description')).toHaveFocus();

    const descriptionInput = screen.getByLabelText('Detail description');
    descriptionInput.focus();
    fireEvent.keyDown(descriptionInput, { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(screen.getByLabelText('Detail status')).toHaveFocus();

    screen.getByLabelText('Detail blocked').focus();
    fireEvent.keyDown(screen.getByLabelText('Detail blocked'), { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/tasks/editor-task'), expect.objectContaining({ method: 'PATCH' })));
  });

  it('allows Shift+Enter to insert a newline in the description without saving', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const urlText = String(url);

      if (method === 'GET' && urlText.includes('/tasks?')) {
        return {
          ok: true,
          json: async () => ({
            data: [mockTask({ id: 'multiline-task', title: 'Multiline task', description: 'Line one' })]
          })
        };
      }

      if (method === 'PATCH' && urlText.includes('/tasks/multiline-task')) {
        return {
          ok: true,
          json: async () => ({ data: mockTask({ id: 'multiline-task', title: 'Multiline task', description: 'Line one\nLine two' }) })
        };
      }

      throw new Error(`Unexpected fetch call: ${method} ${urlText}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Multiline task' }));

    // Enter edit mode for description
    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    const descriptionInput = screen.getByLabelText('Detail description');
    descriptionInput.focus();
    fireEvent.change(descriptionInput, { target: { value: 'Line one\nLine two' } });
    fireEvent.keyDown(descriptionInput, { key: 'Enter', code: 'Enter', charCode: 13, shiftKey: true });

    expect(descriptionInput).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/tasks/multiline-task'), expect.objectContaining({ method: 'PATCH' }));
    expect(descriptionInput.value).toBe('Line one\nLine two');
  });

  it('toggles archived filter and updates query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [mockTask()] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [mockTask({ archivedAt: '2026-03-01T00:00:00.000Z' })] }) });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // Switch to Backlog view from default Kanban view
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));

    await screen.findByRole('list', { name: 'Backlog list' });
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }));

    await waitFor(() => {
      const includeArchivedCall = fetchMock.mock.calls.find(([url]) => String(url).includes('includeArchived=true'));
      expect(includeArchivedCall?.[0]).toContain('includeArchived=true');
    });
  });

  it('shows archived tasks on the kanban board when archived filter is enabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [mockTask()] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [mockTask({ id: 'archived-task', title: 'Archived task', archivedAt: '2026-03-01T00:00:00.000Z' })]
        })
      });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByTestId('column-open');
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }));

    const archivedCard = await screen.findByTestId('card-archived-task');
    expect(archivedCard).toHaveClass('si-card--archived');
    expect(within(archivedCard).getByRole('button', { name: 'Archived task' })).toBeInTheDocument();
  });
});
