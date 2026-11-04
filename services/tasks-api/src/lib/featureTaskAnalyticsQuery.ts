import { Prisma } from '../../generated/prisma/index.js';

export async function fetchWeeklyAnalyticsCounts(prismaClient, buckets) {
  if (buckets.length === 0) return [];

  const values = buckets.map((bucket, bucketIndex) => Prisma.sql`(
    ${bucketIndex}::integer,
    ${bucket.start}::timestamptz,
    ${bucket.end}::timestamptz
  )`);

  const rows = await prismaClient.$queryRaw(Prisma.sql`
    SELECT
      b.bucket_index AS "bucketIndex",
      COUNT(*) FILTER (WHERE e."eventType" = 'terminal_summary') AS "terminalTaskCount",
      COUNT(DISTINCT e."taskId") FILTER (WHERE e."eventType" = 'gate_failure') AS "taskWithFailureCount",
      COUNT(*) FILTER (WHERE e."eventType" = 'gate_failure') AS "gateFailureCount",
      COUNT(*) FILTER (
        WHERE e."eventType" = 'gate_failure' AND e."cause" = 'capacity'
      ) AS "capacityFailureCount",
      COUNT(*) FILTER (
        WHERE e."eventType" = 'gate_failure' AND e."cause" = 'quality'
      ) AS "qualityFailureCount"
    FROM (VALUES ${Prisma.join(values)}) AS b(bucket_index, start_at, end_at)
    LEFT JOIN "FeatureTaskAnalyticsEvent" e
      ON e."occurredAt" >= b.start_at
      AND e."occurredAt" < b.end_at
    GROUP BY b.bucket_index
    ORDER BY b.bucket_index
  `);

  return rows.map((row) => ({
    bucketIndex: Number(row.bucketIndex),
    terminalTaskCount: Number(row.terminalTaskCount),
    taskWithFailureCount: Number(row.taskWithFailureCount),
    gateFailureCount: Number(row.gateFailureCount),
    capacityFailureCount: Number(row.capacityFailureCount),
    qualityFailureCount: Number(row.qualityFailureCount)
  }));
}

export function fetchWeeklyTerminalSummaries(prismaClient, start, end) {
  // This read intentionally has no take/limit. These rows are the complete
  // percentile and evidence-distribution inputs; truncating them would make
  // the published weekly statistics incorrect.
  return prismaClient.featureTaskAnalyticsEvent.findMany({
    where: {
      eventType: 'terminal_summary',
      occurredAt: { gte: start, lt: end }
    },
    select: {
      taskId: true,
      occurredAt: true,
      prCycleTimeSeconds: true,
      evidenceTypeDistribution: true
    },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  });
}

export function fetchTaskAnalyticsEvents(prismaClient, taskId, limit, cursor) {
  const cursorPredicate = cursor
    ? {
        OR: [
          { occurredAt: { gt: cursor.occurredAt } },
          { occurredAt: cursor.occurredAt, createdAt: { gt: cursor.createdAt } },
          {
            occurredAt: cursor.occurredAt,
            createdAt: cursor.createdAt,
            id: { gte: cursor.id }
          }
        ]
      }
    : {};

  return prismaClient.featureTaskAnalyticsEvent.findMany({
    where: { taskId, ...cursorPredicate },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1
  });
}
