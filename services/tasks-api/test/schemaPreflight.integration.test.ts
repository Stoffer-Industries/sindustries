/**
 * Real-database coverage for the tasks-api startup schema preflight
 * (task 20195ce7, AC2).
 *
 * Two cases:
 *  - healthy: the connected database has every column the generated Prisma
 *    client selects on `TaskApproval` — the preflight resolves.
 *  - missing column: a throwaway schema holds a `TaskApproval` table that
 *    is missing one of those columns — the preflight refuses to boot with
 *    an actionable message naming the column and the migration that adds
 *    it.
 *
 * The drifted case uses a dedicated throwaway schema rather than dropping a
 * column from the live table: the preflight is read-only by contract, and
 * this keeps the test from taking an ACCESS EXCLUSIVE lock on a table other
 * tests (and, locally, other services) are reading.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/index.js';
import { prisma } from '../src/lib/prisma.ts';
import {
  SchemaPreflightError,
  assertTaskApprovalSchema,
  expectedColumnsFromDmmf
} from '../src/lib/schemaPreflight.ts';

const TEST_SCHEMA = 'tasks_api_preflight_test';
const MISSING_COLUMN = 'verifiedPrHeadSha';

const baseUrl = new URL(process.env.DATABASE_URL as string);
const driftedUrl = new URL(baseUrl.toString());
driftedUrl.searchParams.set('schema', TEST_SCHEMA);

const admin = new PrismaClient({ datasources: { db: { url: baseUrl.toString() } } });
const drifted = new PrismaClient({ datasources: { db: { url: driftedUrl.toString() } } });

describe('schema preflight against the connected database', () => {
  it('resolves when the connected schema matches the generated client', async () => {
    await expect(assertTaskApprovalSchema()).resolves.toBeUndefined();
  });

  it('refuses to pass when a selected column is missing, naming it and its migration', async () => {
    const error = await assertTaskApprovalSchema({
      client: drifted,
      databaseUrl: driftedUrl.toString()
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(SchemaPreflightError);
    const preflightError = error as SchemaPreflightError;

    expect(preflightError.reason).toBe('missing_columns');
    expect(preflightError.missingColumns).toContain(MISSING_COLUMN);
    expect(preflightError.schema).toBe(TEST_SCHEMA);
    expect(preflightError.migrationByColumn[MISSING_COLUMN]).toBe(
      '20261022140000_add_qa_approval_evidence_pins'
    );

    // Actionable: names the column, the migration, and the remediation.
    expect(preflightError.message).toContain(MISSING_COLUMN);
    expect(preflightError.message).toContain('20261022140000_add_qa_approval_evidence_pins');
    expect(preflightError.message).toContain('npm run prisma:migrate');
  });
});

beforeAll(async () => {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);

  // Same column set as the generated client, minus one — everything the
  // preflight checks is derived from the DMMF, so the fixture stays in sync
  // with schema.prisma automatically.
  const columnDefs = expectedColumnsFromDmmf()
    .filter((column) => column.name !== MISSING_COLUMN)
    .map((column) => `"${column.name}" TEXT`)
    .join(', ');

  await admin.$executeRawUnsafe(
    `CREATE TABLE "${TEST_SCHEMA}"."TaskApproval" (${columnDefs})`
  );
});

afterAll(async () => {
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  } finally {
    await drifted.$disconnect();
    await admin.$disconnect();
    await prisma.$disconnect();
  }
});
