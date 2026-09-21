#!/usr/bin/env node
/**
 * check-clerk-profiles-readiness.js
 *
 * Phase 1 + Phase 2 dry-run check for task bb09eaed (GymTrack Clerk migration).
 * Scans apps/gymtrack/supabase/migrations/ for every table whose `user_id`
 * (or related column) currently references `auth.users(id)` and reports:
 *
 *   - tables still pointing at auth.users(id)        (need Phase 2 repoint)
 *   - tables already repointed at public.profiles(id) (Phase 2 done)
 *   - presence + completeness of the public.profiles table (Phase 1 done)
 *   - whether every repointed table carries a clerk_user_id text column
 *
 * This is intentionally a no-writes, no-DB-connection, file-system-only
 * probe. It does not assert pass/fail; it reports the current state. The
 * readiness verdict is derived from the report:
 *
 *   "ready_for_phase_3_cutover" requires:
 *     1. public.profiles table migration has landed (Phase 1)
 *     2. zero rows in "still pointing at auth.users(id)"
 *     3. zero rows in "missing clerk_user_id linkage on repointed tables"
 *
 *   Until those three hold, this script reports
 *     "phase_<n>_outstanding: <reason>" and exits 0 (informational).
 *
 * The scanner tracks both CREATE TABLE statements (Phase 1, where
 * public.profiles is created) and ALTER TABLE statements (Phase 2, where
 * existing tables' user_id FK is repointed at public.profiles(id) and the
 * clerk_user_id denormalised column is added).
 *
 * Usage:
 *   node apps/gymtrack/scripts/check-clerk-profiles-readiness.js
 *   npm run check:clerk-profiles-readiness
 *
 * Exits 0 on informational reports, 1 only on script errors (parse
 * failures, missing files, etc.). The readiness verdict is communicated
 * via the report body, never via the exit code — automation that wants a
 * binary signal should grep the report for "ready_for_phase_3_cutover".
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "..", "supabase", "migrations");
const APPS_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// ---- helpers --------------------------------------------------------

const REPORT_GROUPS = {
  AUTH_FK_STILL_PRESENT: "tables_still_pointing_at_auth_users",
  REPOINTED_OK:          "tables_repointed_at_public_profiles",
  PUBLIC_PROFILES_STATE: "public_profiles_readiness",
  READINESS_VERDICT:     "readiness_verdict",
};

function listMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`migrations dir not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readMigration(name) {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

// Strip line comments + block comments so a stray `references auth.users(id)`
// in a comment header does not match the create-table scanner. Preserves
// original line numbers for diagnostics.
function stripComments(sql) {
  let out = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  while (i < sql.length) {
    const c = sql[i];
    const nx = sql[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      out += c;
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && nx === "/") {
        inBlock = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "-" && nx === "-") {
      inLine = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && nx === "*") {
      inBlock = true;
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Match `create table [if not exists] [[public.]name] ( ... )` with the
// closing paren correctly nested. Captures the body between the opening
// paren after the table name and the matching close.
function findCreateTableStatements(sql) {
  const tables = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-zA-Z_][\w]*)\s*\(/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth += 1;
      else if (sql[i] === ")") depth -= 1;
      i += 1;
    }
    const body = sql.slice(start, i - 1);
    tables.push({ name, body: body.toLowerCase() });
  }
  return tables;
}

// Match a `references auth.users(id)` (with optional `on delete ...` etc.)
// substring inside a column definition.
function hasAuthUserFK(body, columnName) {
  // The scanner is intentionally permissive; column-shape variants matter.
  const escapedCol = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|\\n|,)\\s*${escapedCol}\\b[^,\\n]*?references\\s+auth\\.users\\s*\\(`,
    "i",
  );
  return re.test(body);
}

// Match `references public.profiles(id)` inside a column definition
// (Phase 2 repoint target).
function hasProfilesFK(body, columnName) {
  const escapedCol = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|\\n|,)\\s*${escapedCol}\\b[^,\\n]*?references\\s+public\\.profiles\\s*\\(`,
    "i",
  );
  return re.test(body);
}

// Determine whether a table has a `clerk_user_id` text column added
// during Phase 2's repoint path.
function hasClerkUserIdColumn(body) {
  return /(?:^|\n|,)\s*clerk_user_id\s+text\b/.test(body);
}

// Match `alter table [if exists] [[public.]name] ...` and capture the body
// of the alter block (everything up to the next `;` or end of input). The
// scanner is intentionally permissive: it looks only for the patterns we
// care about (FK repoint, column add/drop) inside each block.
function findAlterTableStatements(sql) {
  const alters = [];
  const re = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-zA-Z_][\w]*)/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    const start = re.lastIndex;
    let end = sql.length;
    for (let i = start; i < sql.length; i += 1) {
      if (sql[i] === ";") {
        end = i;
        break;
      }
    }
    alters.push({ name, body: sql.slice(start, end).toLowerCase() });
  }
  return alters;
}

// Does this ALTER TABLE block add a FOREIGN KEY … REFERENCES public.profiles
// on `user_id`? Used to detect Phase 2 repoint.
function alterAddsProfilesFK(body) {
  return /add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*user_id\s*\)\s*references\s+public\.profiles\b/.test(body)
      || /add\s+constraint\s+\S+\s+foreign\s+key\s*\(\s*user_id\s*\)\s*references\s+public\.profiles\b/.test(body);
}

// Does this ALTER TABLE block drop the auth.users FK on `user_id`? The
// conventional constraint name is `<table>_user_id_fkey`. We also accept
// the generic pattern `drop constraint … references auth.users` for
// forward-compat with explicit naming.
function alterDropsAuthUserFK(body, tableName) {
  const fkName = `${tableName}_user_id_fkey`;
  if (new RegExp(`drop\\s+constraint(?:\\s+if\\s+exists)?\\s+${fkName}\\b`).test(body)) return true;
  return /drop\s+constraint[^;]*references\s+auth\.users\b/.test(body);
}

// Does this ALTER TABLE block add the `clerk_user_id` text column?
function alterAddsClerkUserIdColumn(body) {
  return /add\s+column(?:\s+if\s+not\s+exists)?\s+clerk_user_id\s+text\b/.test(body);
}

// Match `drop table [if exists] [[public.]name]`. A dropped table should
// not appear in the readiness report (its FK target is no longer in the
// schema at all). The scanner tracks drops separately so it can omit the
// table from both stillAuth and repointed.
function findDroppedTables(sql) {
  const dropped = new Set();
  const re = /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-zA-Z_][\w]*)/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    dropped.add(match[1].toLowerCase());
  }
  return dropped;
}

// ---- main -----------------------------------------------------------

function main() {
  const migrations = listMigrations();
  const profileTableMigrations = [];
  const fkInventory = new Map();
  // table -> { authFK: bool, profilesFK: bool, clerkUserIdCol: bool }
  const droppedTables = new Set();

  for (const fileName of migrations) {
    const raw = readMigration(fileName);
    const sql = stripComments(raw);

    // Track DROP TABLE so decommissioned tables don't pollute the
    // readiness verdict (a dropped table has no FK to repoint).
    for (const name of findDroppedTables(sql)) {
      droppedTables.add(name);
    }

    const tables = findCreateTableStatements(sql);

    for (const t of tables) {
      if (t.name === "profiles") {
        profileTableMigrations.push({ file: fileName, body: t.body });
      }
      const authFK = hasAuthUserFK(t.body, "user_id");
      const profilesFK = hasProfilesFK(t.body, "user_id");
      const clerkCol = hasClerkUserIdColumn(t.body);
      if (authFK || profilesFK || clerkCol) {
        const current = fkInventory.get(t.name) ?? {
          authFK: false,
          profilesFK: false,
          clerkUserIdCol: false,
          firstSeen: fileName,
          repointedInFile: null,
        };
        current.authFK = current.authFK || authFK;
        current.profilesFK = current.profilesFK || profilesFK;
        current.clerkUserIdCol = current.clerkUserIdCol || clerkCol;
        fkInventory.set(t.name, current);
      }
    }

    // ALTER TABLE scan — Phase 2 repoint lives here, not in CREATE TABLE.
    // A Phase 2 repoint adds a `references public.profiles` constraint on
    // `user_id` AND drops the prior `references auth.users` constraint.
    // Either signal flips the table's effective state in `fkInventory`.
    const alters = findAlterTableStatements(sql);
    for (const a of alters) {
      const addsProfiles = alterAddsProfilesFK(a.body);
      const dropsAuth    = alterDropsAuthUserFK(a.body, a.name);
      const addsClerkCol = alterAddsClerkUserIdColumn(a.body);
      if (!addsProfiles && !dropsAuth && !addsClerkCol) continue;

      const current = fkInventory.get(a.name) ?? {
        authFK: false,
        profilesFK: false,
        clerkUserIdCol: false,
        firstSeen: fileName,
        repointedInFile: null,
      };
      if (dropsAuth) current.authFK = false;
      if (addsProfiles) {
        current.profilesFK = true;
        current.repointedInFile = fileName;
      }
      if (addsClerkCol) current.clerkUserIdCol = true;
      fkInventory.set(a.name, current);
    }
  }

  const stillAuth = [];
  const repointed = [];
  for (const [table, info] of fkInventory.entries()) {
    if (droppedTables.has(table)) continue;
    if (info.authFK) stillAuth.push({ table, ...info });
    if (info.profilesFK) repointed.push({ table, ...info });
  }
  stillAuth.sort((a, b) => a.table.localeCompare(b.table));
  repointed.sort((a, b) => a.table.localeCompare(b.table));

  // Tables that should have a clerk_user_id column for Phase 2 — those
  // whose CREATE TABLE had a user_id → auth.users FK (the Phase 2 target).
  // A repointed table missing this column is a regression on Phase 2's
  // data-shape contract (RLS subquery resolves through it).
  const missingClerkCol = repointed
    .filter((t) => !t.clerkUserIdCol)
    .map((t) => t.table);

  const profilesReady = profileTableMigrations.length > 0;
  const verdicts = [];
  if (profilesReady) {
    verdicts.push("phase_1_landed: public.profiles table created");
  } else {
    verdicts.push("phase_1_outstanding: public.profiles table not yet created");
  }
  if (stillAuth.length > 0) {
    verdicts.push(
      `phase_2_outstanding: ${stillAuth.length} table(s) still reference auth.users(id): ` +
        stillAuth.map((t) => t.table).join(", "),
    );
  } else if (profilesReady) {
    verdicts.push("phase_2_landed: all FK targets repointed at public.profiles");
  }
  if (missingClerkCol.length > 0) {
    verdicts.push(
      `phase_2_outstanding: ${missingClerkCol.length} repointed table(s) missing clerk_user_id column: ` +
        missingClerkCol.join(", "),
    );
  }
  if (
    profilesReady &&
    stillAuth.length === 0 &&
    missingClerkCol.length === 0
  ) {
    verdicts.push("ready_for_phase_3_cutover");
  }

  const report = {
    scanned_migrations: migrations.length,
    migrations_dir: MIGRATIONS_DIR.replace(REPO_ROOT + "/", ""),
    groups: {
      [REPORT_GROUPS.PUBLIC_PROFILES_STATE]: {
        phase_1_landed: profilesReady,
        profile_create_files: profileTableMigrations.map((p) => p.file),
      },
      [REPORT_GROUPS.AUTH_FK_STILL_PRESENT]: stillAuth,
      [REPORT_GROUPS.REPOINTED_OK]: repointed,
      [REPORT_GROUPS.READINESS_VERDICT]: verdicts,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
