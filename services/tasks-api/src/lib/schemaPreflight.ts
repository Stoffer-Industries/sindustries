/**
 * tasks-api startup schema preflight (task 20195ce7, AC2).
 *
 * Why this exists
 * ---------------
 * On 2026-10-23 the shared Tasks API started returning HTTP 500 on *every*
 * read. Migration `20261022140000_add_qa_approval_evidence_pins` had been
 * merged to `main`, so Edge fast-forwarded the canonical checkout and the
 * generated Prisma client gained `TaskApproval.verifiedPrHeadSha` — but the
 * migration was never applied to the database every agent reads. Prisma then
 * failed every `TaskApproval` SELECT with P2022 ("column does not exist").
 *
 * The generated client and the database are two artefacts that move
 * independently. This preflight compares them *before* the HTTP listener
 * opens, so a drifted database produces one loud, correctly-attributed
 * startup failure instead of a silent, total outage discovered by an agent
 * whose task queue is dark.
 *
 * How the expected column set is derived
 * --------------------------------------
 * From the generated client's DMMF (`Prisma.dmmf`), not from a hand-written
 * list. The DMMF is regenerated from `prisma/schema.prisma` on every
 * `prisma generate`, so the expected set cannot drift from the client that
 * is actually running. Only fields that map to real columns are counted —
 * `scalar` and `enum` fields. Relation fields (`kind: 'object'`) are not
 * columns.
 *
 * How the target schema is resolved
 * ---------------------------------
 * From the configured Prisma datasource, never hard-coded. The `?schema=`
 * parameter of `DATABASE_URL` is the schema Prisma itself places on the
 * connection's search path, so it is the authoritative answer. When the URL
 * carries no `schema` parameter, the preflight asks the live connection for
 * `current_schema()` rather than assuming a name.
 *
 * Scope: `TaskApproval` only, matching the incident and AC2's wording. The
 * helpers are model-agnostic, but nothing else is checked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '../../generated/prisma/index.js';

/** The model this preflight guards — the model behind the 2026-10-23 outage. */
export const PREFLIGHT_MODEL = 'TaskApproval';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The service's Prisma migrations directory (used to attribute missing columns). */
export const MIGRATIONS_DIR = path.resolve(MODULE_DIR, '../../prisma/migrations');

/** Column kinds that map to a real database column. */
export type ColumnKind = 'scalar' | 'enum';

export interface ExpectedColumn {
  /** Database column name — the Prisma `dbName` when the field is mapped, else the field name. */
  name: string;
  kind: ColumnKind;
}

/**
 * The narrow slice of the Prisma client this module needs. Keeping it small
 * means the preflight can be exercised against a fake client (unit tests)
 * or a transaction client (integration tests) without dragging the whole
 * client surface in.
 */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface PreflightOptions {
  /** Defaults to the service's shared Prisma client. */
  client?: RawQueryClient;
  /** Defaults to `process.env.DATABASE_URL` — the configured Prisma datasource URL. */
  databaseUrl?: string | undefined;
  /** Defaults to the service's `prisma/migrations` directory. */
  migrationsDir?: string;
}

export type SchemaPreflightFailure =
  | 'missing_columns'
  | 'missing_table'
  | 'unresolvable_schema'
  | 'query_failed';

export class SchemaPreflightError extends Error {
  readonly reason: SchemaPreflightFailure;
  /** The resolved schema, or null when it could not be determined. */
  readonly schema: string | null;
  readonly table: string;
  readonly missingColumns: readonly string[];
  /** Missing column -> migration directory that adds it (null when unattributable). */
  readonly migrationByColumn: Readonly<Record<string, string | null>>;

  constructor(
    reason: SchemaPreflightFailure,
    message: string,
    details: {
      schema?: string | null;
      table: string;
      missingColumns?: readonly string[];
      migrationByColumn?: Record<string, string | null>;
    }
  ) {
    super(message);
    this.name = 'SchemaPreflightError';
    this.reason = reason;
    this.schema = details.schema ?? null;
    this.table = details.table;
    this.missingColumns = details.missingColumns ?? [];
    this.migrationByColumn = Object.freeze({ ...(details.migrationByColumn ?? {}) });
  }
}

/**
 * The expected column set for `modelName`, derived from the generated
 * client's DMMF. `dbName` wins over the Prisma field name so a mapped
 * field (`@map`) is checked under its real column name.
 */
export function expectedColumnsFromDmmf(modelName: string = PREFLIGHT_MODEL): ExpectedColumn[] {
  const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
  if (!model) {
    throw new Error(
      `Schema preflight could not find model "${modelName}" in the generated Prisma DMMF. ` +
        'Run `prisma generate` before starting tasks-api.'
    );
  }

  return model.fields
    .filter((field): field is typeof field & { kind: 'scalar' | 'enum' } =>
      field.kind === 'scalar' || field.kind === 'enum'
    )
    .map((field) => ({ name: field.dbName ?? field.name, kind: field.kind }));
}

/** The database table name for `modelName` (`dbName` when mapped via `@@map`). */
export function tableNameFromDmmf(modelName: string = PREFLIGHT_MODEL): string {
  const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
  if (!model) {
    throw new Error(
      `Schema preflight could not find model "${modelName}" in the generated Prisma DMMF. ` +
        'Run `prisma generate` before starting tasks-api.'
    );
  }
  return model.dbName ?? model.name;
}

/**
 * The schema configured on the Prisma datasource, read from the `?schema=`
 * parameter of the datasource URL. Returns null when the URL carries no
 * schema parameter (Prisma then falls back to the connection default).
 */
export function schemaNameFromDatabaseUrl(databaseUrl: string | undefined | null): string | null {
  if (!databaseUrl) return null;
  try {
    const parsed = new URL(databaseUrl);
    const schema = parsed.searchParams.get('schema');
    return schema && schema.trim().length > 0 ? schema.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the schema the generated client will actually read from.
 *
 * Priority: the configured Prisma datasource (`?schema=` on DATABASE_URL),
 * then the live connection's `current_schema()`. Never a hard-coded name.
 */
export async function resolveTargetSchema(
  client: RawQueryClient,
  databaseUrl: string | undefined | null
): Promise<{ schema: string | null; source: string }> {
  const configured = schemaNameFromDatabaseUrl(databaseUrl);
  if (configured) {
    return { schema: configured, source: 'the Prisma datasource URL (DATABASE_URL ?schema=)' };
  }

  const rows = await client.$queryRawUnsafe<Array<{ schema: string | null }>>(
    'SELECT current_schema() AS schema'
  );
  const current = rows[0]?.schema ?? null;
  return {
    schema: current && current.length > 0 ? current : null,
    source: 'the connected database (current_schema())'
  };
}

/** Columns added by a migration file, in the order they appear. */
export function extractAddedColumns(migrationSql: string): string[] {
  const added: string[] = [];
  const seen = new Set<string>();

  const record = (raw: string | undefined) => {
    if (!raw) return;
    const column = raw.trim();
    if (!column || seen.has(column)) return;
    seen.add(column);
    added.push(column);
  };

  // `ALTER TABLE "t" ADD COLUMN [IF NOT EXISTS] "col" <type>`
  const withColumnKeyword = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
  for (const match of migrationSql.matchAll(withColumnKeyword)) {
    record(match[1] ?? match[2]);
  }

  // `ALTER TABLE "t" ADD [IF NOT EXISTS] "col" <type>` — the COLUMN keyword
  // is optional in Postgres. Constraint-ish keywords are excluded so
  // `ADD CONSTRAINT ...` is never mistaken for a column.
  const withoutColumnKeyword =
    /\bADD\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+[A-Za-z]/gi;
  const excluded = new Set([
    'constraint',
    'primary',
    'unique',
    'foreign',
    'check',
    'exclude',
    'column'
  ]);
  for (const match of migrationSql.matchAll(withoutColumnKeyword)) {
    const candidate = match[1] ?? match[2];
    if (!candidate || excluded.has(candidate.toLowerCase())) continue;
    record(candidate);
  }

  return added;
}

/**
 * The migration directory that adds `column`, or null when no migration on
 * disk adds it. Migrations are directory-named with a timestamp prefix, so
 * the lexicographically last match is the most recent one — the migration
 * that has to be applied for the column to exist.
 */
export function findMigrationAddingColumn(
  migrationsDir: string,
  column: string
): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let match: string | null = null;
  for (const name of candidates) {
    const sqlPath = path.join(migrationsDir, name, 'migration.sql');
    let sql: string;
    try {
      sql = fs.readFileSync(sqlPath, 'utf8');
    } catch {
      continue;
    }
    const added = extractAddedColumns(sql);
    if (added.some((candidate) => candidate.toLowerCase() === column.toLowerCase())) {
      match = name;
    }
  }
  return match;
}

/** The actual column names of `table` in `schema`, as the connected database sees them. */
export async function collectActualColumns(
  client: RawQueryClient,
  schema: string,
  table: string
): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ column_name: string }>>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    schema,
    table
  );
  return rows.map((row) => row.column_name);
}

async function tableExists(
  client: RawQueryClient,
  schema: string,
  table: string
): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ table_exists: boolean }>>(
    'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS table_exists',
    schema,
    table
  );
  return Boolean(rows[0]?.table_exists);
}

function formatMissingColumns(
  missingColumns: readonly string[],
  migrationByColumn: Readonly<Record<string, string | null>>
): string {
  return missingColumns
    .map((column) => {
      const migration = migrationByColumn[column];
      const attribution = migration
        ? ` — added by migration ${migration}`
        : ' — no migration on disk adds this column';
      return `    - ${column}${attribution}`;
    })
    .join('\n');
}

/**
 * Verify that the connected database still has every column the generated
 * Prisma client selects on `TaskApproval`. Resolves when the database is
 * current; throws a {@link SchemaPreflightError} naming the missing columns
 * (and the migrations that add them) when it is not.
 */
export async function assertTaskApprovalSchema(options: PreflightOptions = {}): Promise<void> {
  const client = options.client ?? (await defaultClient());
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const modelName = PREFLIGHT_MODEL;
  const table = tableNameFromDmmf(modelName);

  const expected = expectedColumnsFromDmmf(modelName);

  let resolved: { schema: string | null; source: string };
  try {
    resolved = await resolveTargetSchema(client, databaseUrl);
  } catch (error) {
    throw new SchemaPreflightError(
      'query_failed',
      'tasks-api schema preflight could not reach the database, so it cannot verify that the ' +
        'connected schema matches the generated Prisma client.\n' +
        `  Cause: ${error instanceof Error ? error.message : String(error)}\n` +
        'Refusing to start: without a verified schema, every query against a drifted database ' +
        'would fail with Prisma P2022 instead of a clear startup error.',
      { schema: null, table }
    );
  }

  const schema = resolved.schema;
  if (!schema) {
    throw new SchemaPreflightError(
      'unresolvable_schema',
      'tasks-api schema preflight could not determine which database schema to check.\n' +
        '  Tried: the Prisma datasource URL (DATABASE_URL ?schema=) and the connected database ' +
        '(current_schema()).\n' +
        'Refusing to start: the schema could not be verified against the generated Prisma client.',
      { schema: null, table }
    );
  }

  let actual: string[];
  try {
    actual = await collectActualColumns(client, schema, table);
  } catch (error) {
    throw new SchemaPreflightError(
      'query_failed',
      'tasks-api schema preflight could not read the column list of ' +
        `"${schema}"."${table}", so it cannot verify that the connected schema matches the ` +
        'generated Prisma client.\n' +
        `  Cause: ${error instanceof Error ? error.message : String(error)}\n` +
        'Refusing to start: without a verified schema, every query against a drifted database ' +
        'would fail with Prisma P2022 instead of a clear startup error.',
      { schema, table }
    );
  }

  if (actual.length === 0) {
    let exists = false;
    try {
      exists = await tableExists(client, schema, table);
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new SchemaPreflightError(
        'missing_table',
        'tasks-api schema preflight failed: the table the generated Prisma client reads from ' +
          `does not exist in the connected database.\n` +
          `  Schema: ${schema} (resolved from ${resolved.source})\n` +
          `  Table:  ${table}\n` +
          'The database is missing the table entirely — apply the pending migrations, then ' +
          'restart tasks-api:\n' +
          '    npm run prisma:migrate --workspace services/tasks-api',
        { schema, table }
      );
    }
  }

  // PostgreSQL preserves the exact spelling of quoted identifiers. Prisma
  // emits quoted camelCase column names, so a case-insensitive comparison could
  // incorrectly accept `verifiedprheadsha` while the generated client still
  // asks for `verifiedPrHeadSha`. Compare the configured names exactly.
  const actualSet = new Set(actual);
  const missing = expected
    .map((column) => column.name)
    .filter((column) => !actualSet.has(column));

  if (missing.length === 0) return;

  const migrationByColumn: Record<string, string | null> = {};
  for (const column of missing) {
    migrationByColumn[column] = findMigrationAddingColumn(migrationsDir, column);
  }

  throw new SchemaPreflightError(
    'missing_columns',
    'tasks-api schema preflight failed: the connected database is missing ' +
      `${missing.length} column${missing.length === 1 ? '' : 's'} that the generated Prisma ` +
      `client selects on "${table}".\n` +
      `  Schema: ${schema} (resolved from ${resolved.source})\n` +
      `  Table:  ${table}\n` +
      `  Missing columns:\n${formatMissingColumns(missing, migrationByColumn)}\n` +
      'The generated Prisma client is newer than the database it is connected to. Apply the ' +
      'pending migration(s), then restart tasks-api:\n' +
      '    npm run prisma:migrate --workspace services/tasks-api\n' +
      'Refusing to start: serving requests against a database that is missing a selected column ' +
      'would fail every read with Prisma P2022 instead of a clear startup error.',
    { schema, table, missingColumns: missing, migrationByColumn }
  );
}

/**
 * The service's shared Prisma client, imported lazily so that unit tests
 * which inject their own client never construct (or connect) a real one.
 */
async function defaultClient(): Promise<RawQueryClient> {
  const { prisma } = await import('./prisma.ts');
  return prisma as unknown as RawQueryClient;
}
