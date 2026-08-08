import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The script reads TASKS_API_BASE_URL at module-load time, so set it before
// the dynamic import below and use a fresh module instance per test.
const BASE_URL = 'http://tasks-api.test';

describe('migrate-legacy-approvals fetchAllTasks', () => {
  const originalEnv = process.env.TASKS_API_BASE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TASKS_API_BASE_URL = BASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.TASKS_API_BASE_URL = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('hydrates every task via GET /tasks/:id so comments are present, not just the list response', async () => {
    // The list endpoint intentionally mirrors real API behaviour here:
    // `comments` is always `[]` on GET /tasks (list), even when the task
    // has real comments — only GET /tasks/:id includes them. A regression
    // to `fetchAllTasks` using list-response comments directly would make
    // this test fail because `task-2`'s legacy tech_design approval would
    // never be detected.
    const listResponse = {
      data: [
        { id: 'task-1', title: 'A', description: '- [x] **Approved by Tom**', comments: [], approvals: [] },
        { id: 'task-2', title: 'B', description: null, comments: [], approvals: [] }
      ],
      page: { nextCursor: null }
    };

    const detailResponses: Record<string, unknown> = {
      'task-1': {
        data: {
          id: 'task-1',
          title: 'A',
          description: '- [x] **Approved by Tom**',
          status: 'doing',
          taskType: 'feature',
          approvals: [],
          comments: []
        }
      },
      'task-2': {
        data: {
          id: 'task-2',
          title: 'B',
          description: null,
          status: 'doing',
          taskType: 'feature',
          approvals: [],
          comments: [
            {
              id: 'c1',
              author: 'Quinn',
              text: '[tech-design-approved] true',
              createdAt: '2026-08-08T00:00:00.000Z',
              updatedAt: '2026-08-08T00:00:00.000Z'
            }
          ]
        }
      }
    };

    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${BASE_URL}/api/v1/tasks?limit=200`) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      const idMatch = url.match(/\/api\/v1\/tasks\/([^/?]+)$/);
      if (idMatch && detailResponses[idMatch[1]]) {
        return new Response(JSON.stringify(detailResponses[idMatch[1]]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const mod = await import('../scripts/migrate-legacy-approvals.ts');
    const tasks = await mod.fetchAllTasks();

    expect(tasks).toHaveLength(2);
    // GET /tasks/:id was called once per task, not zero times.
    const detailCalls = fetchMock.mock.calls.filter(([u]) => /\/tasks\/task-[12]$/.test(String(u)));
    expect(detailCalls).toHaveLength(2);

    const task2 = tasks.find((t) => t.id === 'task-2');
    expect(task2?.comments).toHaveLength(1);
    expect(task2?.comments[0]?.text).toBe('[tech-design-approved] true');
  });

  it('walks pagination via cursor when hydrating the id list', async () => {
    const page1 = {
      data: [{ id: 'task-1', title: 'A', description: null, comments: [], approvals: [] }],
      page: { nextCursor: 'cursor-1' }
    };
    const page2 = {
      data: [{ id: 'task-2', title: 'B', description: null, comments: [], approvals: [] }],
      page: { nextCursor: null }
    };
    const detail = (id: string) => ({
      data: { id, title: id, description: null, status: 'doing', taskType: 'feature', approvals: [], comments: [] }
    });

    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${BASE_URL}/api/v1/tasks?limit=200`) {
        return new Response(JSON.stringify(page1), { status: 200 });
      }
      if (url === `${BASE_URL}/api/v1/tasks?limit=200&cursor=cursor-1`) {
        return new Response(JSON.stringify(page2), { status: 200 });
      }
      const idMatch = url.match(/\/api\/v1\/tasks\/([^/?]+)$/);
      if (idMatch) {
        return new Response(JSON.stringify(detail(idMatch[1])), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const mod = await import('../scripts/migrate-legacy-approvals.ts');
    const ids = await mod.fetchTaskListIds();

    expect(ids).toEqual(['task-1', 'task-2']);
  });
});
