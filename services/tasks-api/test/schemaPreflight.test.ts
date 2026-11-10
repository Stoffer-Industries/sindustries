/**
 * Unit tests for the tasks-api startup schema preflight (task 20195ce7, AC2).
 *
 * These tests run without a database: the preflight takes an injectable
 * raw-query client, so the healthy / missing-column / missing-table paths
 * are exercised deterministically. The real-database counterpart lives in
 * `schemaPreflight.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  PREFLIGHT_MODEL,
  SchemaPreflightError,
  assertTaskApprovalSchema,
  expectedColumnsFromDmmf,
  extractAddedColumns,
  findMigrationAddingColumn,
  resolveTargetSchema,
  schemaNameFromDatabaseUrl,
  type RawQueryClient
} from '../src/lib/schemaPreflight.ts';

interface RecordedQuery {
  query: string;
  values: unknown[];
}

function createFakeClient(options: {
  columns: string[];
  tableExists?: boolean;
  currentSchema?: string | null;
}) {
  const calls: RecordedQuery[] = [];

  const client: RawQueryClient = {
    async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
      calls.push({ query, values });
      if (query.includes('information_schema.columns')) {
        return options.columns.map((column_name) => ({ column_name })) as unknown as T;
      }
      if (query.includes('information_schema.tables')) {
        return [{ table_exists: options.tableExists ?? true }] as unknown as T;
      }
      if (query.includes('current_schema()')) {
        return [{ schema: options.currentSchema ?? null }] as unknown as T;
      }
      throw new Error(`unexpected query issued by the preflight: ${query}`);
    }
  };

  return { client, calls };
}

const CONFIGURED_URL = 'postgresql://postgres:postgres@localhost:6432/sindustries_dev?schema=tasks_api';

describe('schema preflight — expected columns', () => {
  it('derives the expected TaskApproval columns from the generated Prisma DMMF', () => {
    const columns = expectedColumnsFromDmmf();
    const names = columns.map((column) => column.name);

    // The three columns added by the migration that caused the 2026-10-23
    // outage. If the DMMF ever stops carrying them, the preflight would no
    // longer catch the exact drift it exists to catch.
    expect(names).toContain('verifiedPrHeadSha');
    expect(names).toContain('verifiedPrNumber');
    expect(names).toContain('verifiedAcSectionDigest');

    // Enum fields are real columns too — the client selects them.
    expect(names).toContain('type');
    expect(names).toContain('state');

    // Relation fields are not columns.
    expect(names).not.toContain('task');

    expect(PREFLIGHT_MODEL).toBe('TaskApproval');
  });

  it('keeps the expected column set in sync with the schema the client was generated from', () => {
    const names = expectedColumnsFromDmmf().map((column) => column.name);
    // Every expected name is a plain identifier (no quoting surprises).
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('schema preflight — schema resolution', () => {
  it('reads the schema from the configured Prisma datasource URL', () => {
    expect(schemaNameFromDatabaseUrl(CONFIGURED_URL)).toBe('tasks_api');
    // Not hard-coded: any configured schema is honoured.
    expect(schemaNameFromDatabaseUrl('postgresql://u:p@h:5432/db?schema=agent_tasks')).toBe(
      'agent_tasks'
    );
  });

  it('returns null when the datasource URL carries no schema parameter', () => {
    expect(schemaNameFromDatabaseUrl('postgresql://u:p@h:5432/db')).toBeNull();
    expect(schemaNameFromDatabaseUrl('postgresql://u:p@h:5432/db?schema=')).toBeNull();
    expect(schemaNameFromDatabaseUrl('not a url')).toBeNull();
    expect(schemaNameFromDatabaseUrl(undefined)).toBeNull();
  });

  it('falls back to the connected database when the URL carries no schema parameter', async () => {
    const { client, calls } = createFakeClient({ columns: [], currentSchema: 'from_connection' });

    const resolved = await resolveTargetSchema(client, 'postgresql://u:p@h:5432/db');

    expect(resolved.schema).toBe('from_connection');
    expect(calls[0]?.query).toContain('current_schema()');
  });

  it('prefers the configured datasource schema over the connection default', async () => {
    const { client, calls } = createFakeClient({ columns: [], currentSchema: 'from_connection' });

    const resolved = await resolveTargetSchema(client, CONFIGURED_URL);

    expect(resolved.schema).toBe('tasks_api');
    expect(calls).toHaveLength(0);
  });
});

describe('schema preflight — healthy database', () => {
  it('resolves when the connected schema has every expected column', async () => {
    const columns = expectedColumnsFromDmmf().map((column) => column.name);
    const { client, calls } = createFakeClient({ columns });

    await expect(
      assertTaskApprovalSchema({ client, databaseUrl: CONFIGURED_URL })
    ).resolves.toBeUndefined();

    const columnQuery = calls.find((call) => call.query.includes('information_schema.columns'));
    expect(columnQuery).toBeDefined();
    // The schema and table are bound parameters, never interpolated into SQL.
    expect(columnQuery?.values).toEqual(['tasks_api', 'TaskApproval']);
    expect(columnQuery?.query).not.toContain('tasks_api');
  });

  it('does not accept a wrong-case column as satisfying the generated client', async () => {
    const columns = expectedColumnsFromDmmf()
      .map((column) => column.name)
      .map((name) => name.toLowerCase());
    const { client } = createFakeClient({ columns });

    const error = await assertTaskApprovalSchema({ client, databaseUrl: CONFIGURED_URL }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(SchemaPreflightError);
    expect((error as SchemaPreflightError).missingColumns.length).toBeGreaterThan(0);
  });

  it('checks the schema it was configured with, not a hard-coded one', async () => {
    const columns = expectedColumnsFromDmmf().map((column) => column.name);
    const { client, calls } = createFakeClient({ columns });

    await assertTaskApprovalSchema({
      client,
      databaseUrl: 'postgresql://u:p@h:5432/db?schema=some_other_schema'
    });

    const columnQuery = calls.find((call) => call.query.includes('information_schema.columns'));
    expect(columnQuery?.values).toEqual(['some_other_schema', 'TaskApproval']);
  });
});

describe('schema preflight — missing column', () => {
  it('fails with an actionable message naming the missing column and its migration', async () => {
    const columns = expectedColumnsFromDmmf()
      .map((column) => column.name)
      .filter((name) => name !== 'verifiedPrHeadSha');
    const { client } = createFakeClient({ columns });

    const error = await assertTaskApprovalSchema({ client, databaseUrl: CONFIGURED_URL }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(SchemaPreflightError);
    const preflightError = error as SchemaPreflightError;
    expect(preflightError.reason).toBe('missing_columns');
    expect(preflightError.missingColumns).toEqual(['verifiedPrHeadSha']);
    expect(preflightError.migrationByColumn.verifiedPrHeadSha).toBe(
      '20261022140000_add_qa_approval_evidence_pins'
    );

    // Actionable: names the column, the migration, and the remediation.
    expect(preflightError.message).toContain('verifiedPrHeadSha');
    expect(preflightError.message).toContain('20261022140000_add_qa_approval_evidence_pins');
    expect(preflightError.message).toContain('npm run prisma:migrate');
    expect(preflightError.message).toContain('tasks_api');
    expect(preflightError.message).toContain('TaskApproval');
  });

  it('names every missing column, not just the first', async () => {
    const columns = expectedColumnsFromDmmf()
      .map((column) => column.name)
      .filter((name) => name !== 'verifiedPrHeadSha' && name !== 'verifiedAcSectionDigest');
    const { client } = createFakeClient({ columns });

    const error = await assertTaskApprovalSchema({ client, databaseUrl: CONFIGURED_URL }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    const preflightError = error as SchemaPreflightError;
    expect(preflightError.missingColumns).toEqual([
      'verifiedPrHeadSha',
      'verifiedAcSectionDigest'
    ]);
    expect(preflightError.message).toContain('verifiedPrHeadSha');
    expect(preflightError.message).toContain('verifiedAcSectionDigest');
  });
});

describe('schema preflight — missing table', () => {
  it('fails with an actionable message when the table does not exist at all', async () => {
    const { client } = createFakeClient({ columns: [], tableExists: false });

    const error = await assertTaskApprovalSchema({ client, databaseUrl: CONFIGURED_URL }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    const preflightError = error as SchemaPreflightError;
    expect(preflightError.reason).toBe('missing_table');
    expect(preflightError.message).toContain('TaskApproval');
    expect(preflightError.message).toContain('tasks_api');
    expect(preflightError.message).toContain('npm run prisma:migrate');
  });
});

describe('schema preflight — migration attribution', () => {
  it('attributes a missing column to the migration directory that adds it', () => {
    expect(findMigrationAddingColumn(MIGRATIONS_DIR, 'verifiedPrHeadSha')).toBe(
      '20261022140000_add_qa_approval_evidence_pins'
    );
    expect(findMigrationAddingColumn(MIGRATIONS_DIR, 'verifiedPrNumber')).toBe(
      '20261022140000_add_qa_approval_evidence_pins'
    );
    expect(findMigrationAddingColumn(MIGRATIONS_DIR, 'verifiedAcSectionDigest')).toBe(
      '20261022140000_add_qa_approval_evidence_pins'
    );
  });

  it('returns null for a column no migration on disk adds', () => {
    expect(findMigrationAddingColumn(MIGRATIONS_DIR, 'definitely_not_a_column')).toBeNull();
  });

  it('returns null when the migrations directory is not readable', () => {
    expect(findMigrationAddingColumn('/nonexistent/migrations/dir', 'verifiedPrHeadSha')).toBeNull();
  });

  it('extracts added columns from migration SQL, ignoring constraints', () => {
    const sql = `
      ALTER TABLE "TaskApproval" ADD COLUMN IF NOT EXISTS "verifiedPrNumber" INTEGER;
      ALTER TABLE "TaskApproval" ADD COLUMN "verifiedPrHeadSha" TEXT;
      ALTER TABLE "Task" ADD CONSTRAINT "TaskApproval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id");
      ALTER TABLE "Task" ADD PRIMARY KEY ("id");
    `;

    const added = extractAddedColumns(sql);

    expect(added).toContain('verifiedPrNumber');
    expect(added).toContain('verifiedPrHeadSha');
    expect(added).not.toContain('CONSTRAINT');
    expect(added).not.toContain('PRIMARY');
  });
});
