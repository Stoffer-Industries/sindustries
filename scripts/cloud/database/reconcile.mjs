#!/usr/bin/env node
// scripts/cloud/database/reconcile.mjs
//
// Runs service-owned reconciliation manifests against a source and
// destination, compares normalised outputs, and emits a comparison
// envelope with no row data, no IDs, and no DSNs.
//
// Inputs (mode-0600 DSN files):
//   --source-tasks-dsn-file <path>     tasks_api source DSN
//   --source-budget-dsn-file <path>    budget_api source DSN
//   --dest-tasks-dsn-file <path>       tasks_api destination DSN
//   --dest-budget-dsn-file <path>      budget_api destination DSN
//
// Optional:
//   --output <path>                    default: ./artifacts/cloud-staging/reconcile-<runId>.json
//
// Output envelope shape:
//   {
//     "schemaVersion": 1,
//     "kind": "cloud-staging-reconcile",
//     "runId": "<id>",
//     "services": {
//       "tasks-api":  { "checks": [...], "allMatch": true|false, "digestMatch": true|false },
//       "budget-api": { "checks": [...], "allMatch": true|false, "digestMatch": true|false }
//     },
//     "verdict": "PASS|FAIL"
//   }
//
// Each check records only the check name, source count, destination
// count, delta, and match boolean. Encrypted Akahu token bytes are
// never decrypted, printed, or compared. IDs and PK digests are kept
// in-memory and never written to the envelope.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SERVICES = [
  { name: 'tasks-api',  manifest: join(REPO_ROOT, 'services/tasks-api/ops/reconciliation.sql') },
  { name: 'budget-api', manifest: join(REPO_ROOT, 'services/budget-api/ops/reconciliation.sql') },
];

// ----- arg parsing ---------------------------------------------------------

function parseArgs(argv) {
  const args = {
    sourceTasks: '',
    sourceBudget: '',
    destTasks: '',
    destBudget: '',
    output: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--source-tasks-dsn-file':  args.sourceTasks  = value; i++; break;
      case '--source-budget-dsn-file': args.sourceBudget = value; i++; break;
      case '--dest-tasks-dsn-file':    args.destTasks    = value; i++; break;
      case '--dest-budget-dsn-file':   args.destBudget   = value; i++; break;
      case '--output':                 args.output       = value; i++; break;
      case '--help': case '-h':
        process.stderr.write([
          'Usage: reconcile.mjs --source-tasks-dsn-file <path> --source-budget-dsn-file <path>',
          '                 --dest-tasks-dsn-file <path>   --dest-budget-dsn-file <path>',
          '                 [--output <path>]',
          '',
        ].join('\n'));
        process.exit(0);
      default:
        process.stderr.write(`unknown argument: ${flag}\n`);
        process.exit(2);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'output' && !value) {
      process.stderr.write(`missing required --${kebab(key)} argument\n`);
      process.exit(2);
    }
  }
  return args;
}

function kebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

async function readSecret(filePath) {
  // Mode-0600 check is performed by the calling shell script; here we
  // simply read the file contents and trust the caller.
  const data = await readFile(filePath, 'utf8');
  return data.replace(/\s+$/u, '');
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const hex = randomBytes(3).toString('hex');
  return `${stamp}-${hex}`;
}

// ----- client wiring -------------------------------------------------------

function buildClient(dsn) {
  const client = new Client({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
  // Re-enable strong verification when DSN includes sslmode=verify-full;
  // pg will already enforce that.
  return client;
}

async function withClient(dsn, fn) {
  const client = buildClient(dsn);
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

// ----- manifest runner -----------------------------------------------------

// Each reconciliation manifest is a sequence of SELECT statements that
// return rows shaped as:
//   (check_name TEXT, metric TEXT, value BIGINT)
// where `metric` is a stable label (e.g. "row_count", "distinct_pk_count",
// "orphan_count", "duplicate_group_count") and `value` is a non-negative
// integer.
//
// The manifest is split on `;` boundaries at lines that are not inside a
// string literal; we additionally skip blank lines and `--` comments.

function splitSqlStatements(sql) {
  const cleaned = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  // Naive split: psql-style semicolon-terminated statements, no
  // dollar-quoted bodies in the manifest. The manifest format is
  // deliberately constrained so this is safe.
  return cleaned
    .split(/;\s*\n/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runManifest(client, manifestPath) {
  const sql = await readFile(manifestPath, 'utf8');
  const statements = splitSqlStatements(sql);
  const results = [];
  for (const stmt of statements) {
    const res = await client.query(stmt);
    for (const row of res.rows) {
      results.push({
        check: String(row.check_name),
        metric: String(row.metric),
        value: Number(row.value),
      });
    }
  }
  return results;
}

// ----- digest --------------------------------------------------------------

// Computes a deterministic in-memory digest of the canonical primary-key
// set for every owned table. The raw IDs and the digest are kept in
// memory only; only the boolean digestMatch is recorded in the envelope.
//
// Tables listed here MUST match the manifest's "owned tables" set.

const TASKS_API_TABLES = [
  'Task',
  'TaskComment',
  'TaskDependency',
  'TaskTag',
  'Approval',
  'AttentionOwner',
];

const BUDGET_API_TABLES = [
  'LinkedCard',
  'Transaction',
  'AkahuToken',
  'BudgetCategory',
  'BudgetSettings',
];

function tableSetForService(serviceName) {
  return serviceName === 'tasks-api' ? TASKS_API_TABLES : BUDGET_API_TABLES;
}

async function pkDigest(client, serviceName) {
  const tables = tableSetForService(serviceName);
  const hash = createHash('sha256');
  for (const table of tables) {
    const res = await client.query(
      `SELECT id::text AS id FROM ${table} ORDER BY id::text`
    );
    for (const row of res.rows) {
      hash.update(`${table}::`);
      hash.update(row.id);
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

// ----- main ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = makeRunId();
  const outputPath = args.output || `./artifacts/cloud-staging/reconcile-${runId}.json`;

  const sourceTasks  = await readSecret(args.sourceTasks);
  const sourceBudget = await readSecret(args.sourceBudget);
  const destTasks    = await readSecret(args.destTasks);
  const destBudget   = await readSecret(args.destBudget);

  // Same-DSN safety (defence in depth — caller already checked this).
  if (sourceTasks === destTasks || sourceBudget === destBudget) {
    process.stderr.write('source and destination DSNs are identical; refusing\n');
    process.exit(3);
  }

  const dsnByService = {
    'tasks-api':  { source: sourceTasks,  dest: destTasks  },
    'budget-api': { source: sourceBudget, dest: destBudget },
  };

  const envelope = {
    schemaVersion: 1,
    kind: 'cloud-staging-reconcile',
    runId,
    services: {},
  };

  for (const { name, manifest } of SERVICES) {
    const dsn = dsnByService[name];
    const checks = [];
    let allMatch = true;

    for (const side of ['source', 'dest']) {
      const sideResults = await withClient(dsn[side], (client) => runManifest(client, manifest));
      checks.push({ side, results: sideResults });
    }

    const sourceMap = new Map();
    const destMap = new Map();
    for (const r of checks[0].results) sourceMap.set(`${r.check}::${r.metric}`, r.value);
    for (const r of checks[1].results) destMap.set(`${r.check}::${r.metric}`, r.value);

    const merged = [];
    const keys = new Set([...sourceMap.keys(), ...destMap.keys()]);
    for (const key of keys) {
      const sourceValue = sourceMap.get(key) ?? 0;
      const destValue   = destMap.get(key)   ?? 0;
      const match = sourceValue === destValue;
      if (!match) allMatch = false;
      const [check, metric] = key.split('::');
      merged.push({ check, metric, source: sourceValue, dest: destValue, delta: destValue - sourceValue, match });
    }
    merged.sort((a, b) => (a.check + a.metric).localeCompare(b.check + b.metric));

    // PK digest comparison.
    const sourceDigest = await withClient(dsn.source,  (c) => pkDigest(c, name));
    const destDigest   = await withClient(dsn.dest,    (c) => pkDigest(c, name));
    const digestMatch = sourceDigest === destDigest;

    envelope.services[name] = {
      checks: merged,
      allMatch,
      digestMatch,
    };
  }

  envelope.verdict = Object.values(envelope.services).every((s) => s.allMatch && s.digestMatch)
    ? 'PASS'
    : 'FAIL';

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  process.stderr.write(`reconcile verdict=${envelope.verdict} output=${outputPath}\n`);
  process.exit(envelope.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`reconcile failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
