import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error('DATABASE_URL is required for analytics budget integration tests');

const databaseName = `analytics_budget_${process.pid}_${Date.now()}`;
const isolatedUrl = new URL(baseDatabaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
isolatedUrl.searchParams.set('schema', 'tasks_api');
process.env.DATABASE_URL = isolatedUrl.toString();

const { PrismaClient } = await import('../generated/prisma/index.js');
const provisioningClient = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
await provisioningClient.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
await provisioningClient.$disconnect();

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: serviceDir,
  env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
  stdio: 'pipe'
});

const [{ createApp }, { authedRequest }, { prisma: appPrisma }] = await Promise.all([
  import('../src/app.ts'),
  import('./helpers/auth.ts'),
  import('../src/lib/prisma.ts')
]);

const prisma = new PrismaClient();
const app = createApp();
let materializedRows = 0;
appPrisma.$use(async (_params, next) => {
  const result = await next(_params);
  if (Array.isArray(result)) materializedRows += result.length;
  return result;
});

const TASK_COUNT = 1_240;
const GATE_EVENT_COUNT = 12_990;
const TERMINAL_EVENT_COUNT = 710;

function taskId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function isoMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

function isoDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

async function createManyInChunks(model, rows, chunkSize = 1_000) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await model.createMany({ data: rows.slice(offset, offset + chunkSize) });
  }
}

function buildReference(events, buckets) {
  const rows = buckets.map((bucket) => ({
    weekStart: isoDateOnly(bucket.start),
    terminalTaskCount: 0,
    taskWithFailureCount: 0,
    gateFailureCount: 0,
    capacityFailureCount: 0,
    qualityFailureCount: 0,
    gateFailureRate: null,
    medianPrCycleTimeSeconds: null,
    p90PrCycleTimeSeconds: null,
    evidenceTypeDistribution: {},
    failureTasks: new Set(),
    cycleTimes: []
  }));

  for (const event of events) {
    const bucketIndex = buckets.findIndex(
      (bucket) => event.occurredAt >= bucket.start && event.occurredAt < bucket.end
    );
    if (bucketIndex === -1) continue;
    const stats = rows[bucketIndex];
    if (event.eventType === 'terminal_summary') {
      stats.terminalTaskCount += 1;
      if (typeof event.prCycleTimeSeconds === 'number') {
        stats.cycleTimes.push(event.prCycleTimeSeconds);
      }
      for (const [key, count] of Object.entries(event.evidenceTypeDistribution || {})) {
        stats.evidenceTypeDistribution[key] =
          (stats.evidenceTypeDistribution[key] || 0) + Number(count);
      }
    } else if (event.eventType === 'gate_failure') {
      stats.gateFailureCount += 1;
      if (event.cause === 'capacity') stats.capacityFailureCount += 1;
      else if (event.cause === 'quality') stats.qualityFailureCount += 1;
      stats.failureTasks.add(event.taskId);
    }
  }

  return rows.map((stats) => {
    const taskWithFailureCount = stats.failureTasks.size;
    return {
      weekStart: stats.weekStart,
      terminalTaskCount: stats.terminalTaskCount,
      taskWithFailureCount,
      gateFailureCount: stats.gateFailureCount,
      capacityFailureCount: stats.capacityFailureCount,
      qualityFailureCount: stats.qualityFailureCount,
      gateFailureRate: stats.terminalTaskCount === 0
        ? null
        : Number((taskWithFailureCount / stats.terminalTaskCount).toFixed(4)),
      medianPrCycleTimeSeconds: median(stats.cycleTimes),
      p90PrCycleTimeSeconds: percentile(stats.cycleTimes, 90),
      evidenceTypeDistribution: stats.evidenceTypeDistribution
    };
  });
}

describe('feature-task analytics bounded-query contract', () => {
  let expectedWeekly;
  let allSeededEventIds;

  beforeAll(async () => {
    const thisMonday = isoMonday(new Date());
    const buckets = [];
    for (let index = 51; index >= 0; index -= 1) {
      const start = new Date(thisMonday);
      start.setDate(start.getDate() - index * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      buckets.push({ start, end });
    }

    await createManyInChunks(
      prisma.task,
      Array.from({ length: TASK_COUNT }, (_, index) => ({
        id: taskId(index + 1),
        title: `Analytics budget task ${index + 1}`
      }))
    );

    const events = [];
    for (let index = 0; index < GATE_EVENT_COUNT; index += 1) {
      const bucket = buckets[index % buckets.length];
      events.push({
        taskId: taskId(1),
        eventKey: `analytics-budget:gate:${index}`,
        eventType: 'gate_failure',
        gate: 'ready_checks',
        cause: index % 2 === 0 ? 'quality' : 'capacity',
        message: 'bounded analytics fixture',
        occurredAt: new Date(bucket.start.getTime() + 60 * 60 * 1000 + index)
      });
    }
    for (let index = 0; index < TERMINAL_EVENT_COUNT; index += 1) {
      const bucket = buckets[index % buckets.length];
      events.push({
        taskId: taskId((index % TASK_COUNT) + 1),
        eventKey: `analytics-budget:terminal:${index}`,
        eventType: 'terminal_summary',
        terminalStatus: 'done',
        prCycleTimeSeconds: 100 + (index % 41),
        evidenceTypeDistribution: { unit: 1, integration: index % 3 },
        occurredAt: new Date(bucket.start.getTime() + 2 * 60 * 60 * 1000 + index)
      });
    }

    expectedWeekly = { data: buildReference(events, buckets) };
    await createManyInChunks(prisma.featureTaskAnalyticsEvent, events);

    allSeededEventIds = new Set(
      (await prisma.featureTaskAnalyticsEvent.findMany({
        where: { taskId: taskId(1) },
        select: { id: true }
      })).map((event) => event.id)
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    const admin = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
      process.env.DATABASE_URL = baseDatabaseUrl;
    }
  });

  it('keeps the 52-week response byte-identical while materialising at most 2,500 rows', async () => {
    const warmup = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query({ weeks: 52 });
    expect(warmup.status).toBe(200);

    materializedRows = 0;
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const response = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query({ weeks: 52 });
    if (global.gc) global.gc();
    const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

    expect(response.status).toBe(200);
    expect(response.text).toBe(JSON.stringify(expectedWeekly));
    expect(materializedRows).toBe(52 + TERMINAL_EVENT_COUNT);
    expect(materializedRows).toBeLessThanOrEqual(2_500);
    expect(retainedHeapBytes).toBeLessThanOrEqual(8 * 1024 * 1024);

    const terminalRows = await prisma.featureTaskAnalyticsEvent.count({
      where: { eventType: 'terminal_summary' }
    });
    expect(terminalRows).toBe(TERMINAL_EVENT_COUNT);
    expect(response.body.data.reduce(
      (sum, bucket) => sum + bucket.terminalTaskCount,
      0
    )).toBe(TERMINAL_EVENT_COUNT);
  });

  it('caps each event page and traverses the complete ordered history exactly once', async () => {
    const seen = [];
    let cursor;
    do {
      const response = await authedRequest(app)
        .get(`/api/v1/feature-task-analytics/tasks/${taskId(1)}/events`)
        .query({ limit: 2_000, ...(cursor ? { cursor } : {}) });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(2_000);
      expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
      seen.push(...response.body.data.map((event) => event.id));
      cursor = response.body.pagination.hasMore
        ? response.body.pagination.nextCursor
        : undefined;
    } while (cursor);

    expect(seen).toHaveLength(allSeededEventIds.size);
    expect(new Set(seen)).toEqual(allSeededEventIds);
  }, 30_000);

  it.each([
    [undefined, 8, 200],
    ['', 8, 200],
    ['52', 52, 200],
    ['0', null, 400],
    ['53', null, 400],
    ['-1', null, 400],
    ['abc', null, 400]
  ])('preserves weeks validation for %s', async (weeks, expectedCount, status) => {
    const response = await authedRequest(app)
      .get('/api/v1/feature-task-analytics/weekly')
      .query(weeks === undefined ? {} : { weeks });

    expect(response.status).toBe(status);
    if (status === 200) expect(response.body.data).toHaveLength(expectedCount);
    else expect(response.body.error.code).toBe('INVALID_WEEKS');
  });
});
