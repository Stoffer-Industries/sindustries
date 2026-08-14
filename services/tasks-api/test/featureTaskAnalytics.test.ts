import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Prisma mock ---------------------------------------------------------

const prismaMock: any = {
  featureTaskAnalyticsEvent: {
    upsert: vi.fn(),
    findMany: vi.fn()
  },
  task: {
    findFirst: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

const VALID_UUID = '12345678-1234-1234-1234-123456789012';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (input: any) => {
    if (Array.isArray(input)) return Promise.all(input);
    if (typeof input === 'function') return input(prismaMock);
    return Promise.resolve(input);
  });
  prismaMock.task.findFirst.mockResolvedValue({ id: VALID_UUID });
});

describe('POST /api/v1/feature-task-analytics/events', () => {
  it('creates a gate_failure event and returns { created, updated, events }', async () => {
    const createdAt = new Date('2026-07-25T08:00:00.000Z');
    const updatedAt = createdAt;
    prismaMock.featureTaskAnalyticsEvent.upsert.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      taskId: VALID_UUID,
      eventKey: 'feature-task:abc:ready_checks:hash:1',
      eventType: 'gate_failure',
      gate: 'ready_checks',
      cause: 'quality',
      message: 'missing tech design',
      occurredAt: createdAt,
      terminalStatus: null,
      completionTimestamp: null,
      totalGateFailureCount: null,
      capacityBlockCount: null,
      qualityFailureCount: null,
      prCycleTimeSeconds: null,
      evidenceTypeDistribution: null,
      details: null,
      createdAt,
      updatedAt
    });

    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'feature-task:abc:ready_checks:hash:1',
        eventType: 'gate_failure',
        gate: 'ready_checks',
        cause: 'quality',
        message: 'missing tech design'
      });

    expect(response.status).toBe(201);
    expect(response.body.data.created).toBe(1);
    expect(response.body.data.updated).toBe(0);
    expect(response.body.data.events).toHaveLength(1);
    expect(response.body.data.events[0].eventType).toBe('gate_failure');
    expect(response.body.data.events[0].gate).toBe('ready_checks');
    expect(response.body.data.events[0].cause).toBe('quality');
    expect(response.body.data.events[0].occurredAt).toBe(createdAt.toISOString());
  });

  it('upserts duplicate eventKey and reports it as updated', async () => {
    const createdAt = new Date('2026-07-25T08:00:00.000Z');
    const updatedAt = new Date('2026-07-25T09:00:00.000Z');
    prismaMock.featureTaskAnalyticsEvent.upsert.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      taskId: VALID_UUID,
      eventKey: 'feature-task:abc:terminal:done',
      eventType: 'terminal_summary',
      gate: null,
      cause: null,
      message: null,
      occurredAt: createdAt,
      terminalStatus: 'done',
      completionTimestamp: createdAt,
      totalGateFailureCount: 0,
      capacityBlockCount: 0,
      qualityFailureCount: 0,
      prCycleTimeSeconds: 3600,
      evidenceTypeDistribution: { unit: 2 },
      details: null,
      createdAt,
      updatedAt
    });

    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'feature-task:abc:terminal:done',
        eventType: 'terminal_summary',
        terminalStatus: 'done',
        totalGateFailureCount: 0,
        capacityBlockCount: 0,
        qualityFailureCount: 0,
        prCycleTimeSeconds: 3600,
        evidenceTypeDistribution: { unit: 2 }
      });

    expect(response.status).toBe(201);
    expect(response.body.data.created).toBe(0);
    expect(response.body.data.updated).toBe(1);
  });

  it('accepts a batch via { events: [...] } and processes all rows', async () => {
    const createdAt = new Date('2026-07-25T08:00:00.000Z');
    const updatedAt = createdAt;
    prismaMock.featureTaskAnalyticsEvent.upsert.mockResolvedValue({
      id: 'row',
      taskId: VALID_UUID,
      eventKey: 'k',
      eventType: 'gate_failure',
      gate: 'ready_checks',
      cause: 'quality',
      message: 'm',
      occurredAt: createdAt,
      terminalStatus: null,
      completionTimestamp: null,
      totalGateFailureCount: null,
      capacityBlockCount: null,
      qualityFailureCount: null,
      prCycleTimeSeconds: null,
      evidenceTypeDistribution: null,
      details: null,
      createdAt,
      updatedAt
    });

    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        events: [
          {
            taskId: VALID_UUID,
            eventKey: 'feature-task:abc:ready_checks:hash:1',
            eventType: 'gate_failure',
            gate: 'ready_checks',
            cause: 'quality',
            message: 'missing tech design'
          },
          {
            taskId: VALID_UUID,
            eventKey: 'feature-task:abc:ready_checks:hash:2',
            eventType: 'gate_failure',
            gate: 'ready_checks',
            cause: 'capacity',
            message: 'implementer at capacity'
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.data.events).toHaveLength(2);
    expect(prismaMock.featureTaskAnalyticsEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed taskId with 400', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: 'not-a-uuid',
        eventKey: 'k',
        eventType: 'gate_failure',
        gate: 'ready_checks',
        cause: 'quality'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
  });

  it('rejects invalid eventType with 400', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'transitioned'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
  });

  it('rejects gate_failure events missing gate', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'gate_failure',
        cause: 'quality'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
    expect(response.body.error.message).toContain('gate');
  });

  it('rejects gate_failure events missing cause', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'gate_failure',
        gate: 'ready_checks'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
    expect(response.body.error.message).toContain('cause');
  });

  it('rejects terminal_summary events that include gate', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'terminal_summary',
        gate: 'post_merge',
        terminalStatus: 'done'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
  });

  it('rejects terminal_summary events with invalid terminalStatus', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'terminal_summary',
        terminalStatus: 'finished'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
  });

  it('rejects terminal_summary events with non-integer counts', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({
        taskId: VALID_UUID,
        eventKey: 'k',
        eventType: 'terminal_summary',
        totalGateFailureCount: 1.5
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENT');
  });

  it('rejects empty batch', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({ events: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('EVENTS_REQUIRED');
  });

  it('rejects oversized batch', async () => {
    const events = Array.from({ length: 501 }, (_, i) => ({
      taskId: VALID_UUID,
      eventKey: `k:${i}`,
      eventType: 'gate_failure',
      gate: 'ready_checks',
      cause: 'quality'
    }));

    const app = createApp();
    const response = await authedRequest(app)
      .post('/api/v1/feature-task-analytics/events')
      .send({ events });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BATCH_TOO_LARGE');
  });
});

describe('GET /api/v1/feature-task-analytics/tasks/:taskId/events', () => {
  it('returns chronological events for a task', async () => {
    const createdAt = new Date('2026-07-25T08:00:00.000Z');
    prismaMock.featureTaskAnalyticsEvent.findMany.mockResolvedValue([
      {
        id: 'row1',
        taskId: VALID_UUID,
        eventKey: 'k1',
        eventType: 'gate_failure',
        gate: 'ready_checks',
        cause: 'quality',
        message: 'missing',
        occurredAt: createdAt,
        terminalStatus: null,
        completionTimestamp: null,
        totalGateFailureCount: null,
        capacityBlockCount: null,
        qualityFailureCount: null,
        prCycleTimeSeconds: null,
        evidenceTypeDistribution: null,
        details: null,
        createdAt,
        updatedAt: createdAt
      }
    ]);

    const app = createApp();
    const response = await authedRequest(app).get(`/api/v1/feature-task-analytics/tasks/${VALID_UUID}/events`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(prismaMock.featureTaskAnalyticsEvent.findMany).toHaveBeenCalledWith({
      where: { taskId: VALID_UUID },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }]
    });
  });

  it('returns 404 when task does not exist', async () => {
    prismaMock.task.findFirst.mockResolvedValue(null);

    const app = createApp();
    const response = await authedRequest(app).get(`/api/v1/feature-task-analytics/tasks/${VALID_UUID}/events`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TASK_NOT_FOUND');
  });

  it('rejects malformed taskId', async () => {
    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/feature-task-analytics/tasks/nope/events');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TASK_ID');
  });
});

describe('GET /api/v1/feature-task-analytics/weekly', () => {
  // Freeze "now" so that the Monday-start week boundaries are stable.
  // 2026-07-29T00:00:00.000Z is 2026-07-29T12:00:00 NZST — a Wednesday.
  // The current week is [2026-07-27 Mon, 2026-08-03 Mon), so:
  //   data[0].weekStart = '2026-06-08' (49 days before thisMonday)
  //   data[7].weekStart = '2026-07-27' (thisMonday)
  const NOW = new Date('2026-07-29T00:00:00.000Z');
  const THIS_MONDAY = '2026-07-27';

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function bucketStart(weeksAgo) {
    // Anchor on thisMonday in UTC (which is 2026-07-27T00:00:00Z = mid-day NZST).
    // The bucket math is timezone-agnostic; only the boundary string matters.
    const d = new Date(`${THIS_MONDAY}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
    return d;
  }

  it('returns 8 weekly buckets by default, oldest first', async () => {
    prismaMock.featureTaskAnalyticsEvent.findMany.mockResolvedValue([]);

    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query({});

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(8);
    // Oldest week is 7 weeks before thisMonday (2026-07-27).
    expect(response.body.data[0].weekStart).toBe('2026-06-08');
    expect(response.body.data[7].weekStart).toBe('2026-07-27');
  });

  it('computes gateFailureRate, splits capacity/quality, and aggregates evidence distribution', async () => {
    const weekStart = bucketStart(0);
    const inWeek = new Date(weekStart);
    inWeek.setUTCDate(inWeek.getUTCDate() + 1);
    prismaMock.featureTaskAnalyticsEvent.findMany.mockResolvedValue([
      {
        taskId: 'task-1',
        eventType: 'terminal_summary',
        cause: null,
        occurredAt: inWeek,
        prCycleTimeSeconds: 1800,
        evidenceTypeDistribution: { unit: 2, integration: 1 }
      },
      {
        taskId: 'task-2',
        eventType: 'terminal_summary',
        cause: null,
        occurredAt: inWeek,
        prCycleTimeSeconds: 3600,
        evidenceTypeDistribution: { unit: 1, e2e: 1 }
      },
      {
        taskId: 'task-1',
        eventType: 'gate_failure',
        cause: 'quality',
        occurredAt: inWeek,
        prCycleTimeSeconds: null,
        evidenceTypeDistribution: null
      },
      {
        taskId: 'task-1',
        eventType: 'gate_failure',
        cause: 'capacity',
        occurredAt: inWeek,
        prCycleTimeSeconds: null,
        evidenceTypeDistribution: null
      },
      {
        taskId: 'task-2',
        eventType: 'gate_failure',
        cause: 'quality',
        occurredAt: inWeek,
        prCycleTimeSeconds: null,
        evidenceTypeDistribution: null
      }
    ]);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/feature-task-analytics/weekly');

    expect(response.status).toBe(200);
    const currentWeek = response.body.data[7];
    expect(currentWeek.weekStart).toBe('2026-07-27');
    expect(currentWeek.terminalTaskCount).toBe(2);
    expect(currentWeek.taskWithFailureCount).toBe(2);
    expect(currentWeek.gateFailureCount).toBe(3);
    expect(currentWeek.capacityFailureCount).toBe(1);
    expect(currentWeek.qualityFailureCount).toBe(2);
    expect(currentWeek.gateFailureRate).toBe(1); // 2/2
    expect(currentWeek.medianPrCycleTimeSeconds).toBe(2700); // median of [1800, 3600]
    expect(currentWeek.evidenceTypeDistribution).toEqual({ unit: 3, integration: 1, e2e: 1 });
  });

  it('returns null gateFailureRate when terminalTaskCount is 0', async () => {
    const weekStart = bucketStart(0);
    const inWeek = new Date(weekStart);
    inWeek.setUTCDate(inWeek.getUTCDate() + 1);
    prismaMock.featureTaskAnalyticsEvent.findMany.mockResolvedValue([
      {
        taskId: 'task-1',
        eventType: 'gate_failure',
        cause: 'quality',
        occurredAt: inWeek,
        prCycleTimeSeconds: null,
        evidenceTypeDistribution: null
      }
    ]);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/feature-task-analytics/weekly');

    expect(response.status).toBe(200);
    const currentWeek = response.body.data[7];
    expect(currentWeek.terminalTaskCount).toBe(0);
    expect(currentWeek.taskWithFailureCount).toBe(1);
    expect(currentWeek.gateFailureRate).toBeNull();
  });

  it('rejects invalid weeks query', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query({ weeks: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_WEEKS');
  });

  it('rejects weeks > 52', async () => {
    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query({ weeks: 100 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_WEEKS');
  });

  it('computes p90 prCycleTimeSeconds as nearest-rank', async () => {
    const weekStart = bucketStart(0);
    const inWeek = new Date(weekStart);
    inWeek.setUTCDate(inWeek.getUTCDate() + 1);
    const cycleTimes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    prismaMock.featureTaskAnalyticsEvent.findMany.mockResolvedValue(
      cycleTimes.map((seconds, idx) => ({
        taskId: `task-${idx}`,
        eventType: 'terminal_summary',
        cause: null,
        occurredAt: inWeek,
        prCycleTimeSeconds: seconds,
        evidenceTypeDistribution: null
      }))
    );

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/feature-task-analytics/weekly');

    expect(response.status).toBe(200);
    const currentWeek = response.body.data[7];
    expect(currentWeek.terminalTaskCount).toBe(10);
    // Nearest-rank p90: ceil(0.9 * 10) = 9, so values[8] = 900.
    expect(currentWeek.p90PrCycleTimeSeconds).toBe(900);
  });
});
