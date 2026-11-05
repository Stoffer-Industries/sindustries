#!/usr/bin/env node
/**
 * platform-migrate.mjs — the consolidated platform's single `release_command`
 * (task 219fb673).
 *
 * The consolidated Fly app has ONE release command, but three services with
 * three Prisma schemas. Fly runs `release_command` directly (not through a
 * shell), so the chain has to live in a script that npm invokes.
 *
 * Each service's `prisma migrate deploy` reads `DATABASE_URL`, and the three
 * staging databases differ by schema — one Neon database, three schemas:
 *
 *   PLATFORM_TASKS_API_DATABASE_URL           -> ?schema=tasks_api
 *   PLATFORM_BUDGET_API_DATABASE_URL          -> ?schema=budget_api
 *   PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL -> ?schema=content_scheduler
 *
 * So each migration runs with its own DATABASE_URL, sourced from the
 * app-level `PLATFORM_*` secret. The schema names and the mapping live in
 * platform-services.mjs, which the supervisor also reads — the two cannot
 * drift.
 *
 * The auto-post worker has no migration (it shares the content_scheduler
 * schema with content-scheduler-api), so it is not in the chain.
 *
 * Usage:
 *   node infra/cloud/platform/platform-migrate.mjs [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { MIGRATION_STEPS } from './platform-services.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Run one service's `prisma migrate deploy` with its own DATABASE_URL.
 *
 * @param {object} step  a MIGRATION_STEPS entry
 * @param {object} env   the app-level environment
 * @returns {{ok: boolean, code: number|null}}
 */
export function runMigration(step, env) {
  const databaseUrl = env?.[step.databaseUrlSource];
  if (!databaseUrl) {
    process.stderr.write(
      `[platform-migrate] ${step.workspace} needs ${step.databaseUrlSource}; it is not set\n`,
    );
    return { ok: false, code: null };
  }

  const childEnv = { ...env, DATABASE_URL: databaseUrl };
  // The service's own `prisma:migrate` script is `prisma migrate deploy`.
  const args = ['run', 'prisma:migrate', '--workspace', step.workspace];
  process.stdout.write(`[platform-migrate] ${step.workspace}\n`);

  if (DRY_RUN) {
    process.stdout.write(`[platform-migrate] would run: npm ${args.join(' ')}\n`);
    return { ok: true, code: 0 };
  }

  const result = spawnSync('npm', args, {
    env: childEnv,
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  return { ok: result.status === 0, code: result.status };
}

function main() {
  const env = process.env;
  for (const step of MIGRATION_STEPS) {
    const { ok } = runMigration(step, env);
    if (!ok) {
      process.stderr.write(
        `[platform-migrate] migration failed for ${step.workspace}; release aborted\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write('[platform-migrate] all platform migrations applied\n');
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main();
}
