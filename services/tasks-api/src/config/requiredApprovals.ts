// Configurable taskType -> required-approvals mapping for the Tasks API.
//
// The mapping is editable by Quinn or Tom without a code deploy. The Tasks API
// reads `.openclaw/tasks-api/required-approvals.yaml` on startup; if the file
// is missing or malformed, the loader falls back to a built-in default and
// logs a WARN. The default values match the task spec defaults:
//   feature: [spec, tech_design, qa_agent, accepted]
//   code:    [tech_design, qa_agent, accepted]
//   content: [spec, qa_agent, accepted]
//   research: []
//
// Each approval type also has a configured owner used by the workflow-gate
// ownership surface (task 66054ab4 WS1). The owner is global per approval
// type — `spec` is always Tom's gate regardless of the task type it gates.
// Defaults: spec → Tom, tech_design → Quinn, qa_agent → Ash, accepted → Tom.
// A free-form override is allowed in the YAML `owners:` block; unknown
// approval types are skipped so a typo doesn't take down the loader.
//
// The file format is intentionally narrow — a top-level `version:` line, an
// indented `mappings:` block, and an indented `owners:` block. The loader is
// hand-rolled to avoid pulling in a YAML dependency for a structure that
// fits in ~30 lines of parsing.
//
// See docs/specs/tasks-api-native-approvals-tech-design.md WS2 and
// docs/specs/blocked-by-escalation-owners-and-stacked-avatars-tech-design.md
// for the workflow-gate ownership surface (WS1 of task 66054ab4).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validApprovalTypes } from '../routes/tasks/_constants.ts';

export interface RequiredApprovalsConfig {
  version: number;
  mappings: Record<string, string[]>;
  /**
   * Configured owner per approval type. Used to surface outstanding
   * workflow-gate ownership on a task (`mapTask.workflowGates`) and to
   * scope discovery queues (`?workflowGateOwner=Quinn`). Approval types not
   * listed fall back to the built-in default (`DEFAULT_APPROVAL_OWNERS`).
   */
  owners: Record<string, string>;
  source: 'config-file' | 'builtin-default';
  /**
   * Absolute path of the config file that produced this snapshot, or `null`
   * when no file was loaded (missing file or parse failure → built-in default).
   * Exposed so operators can see which file the API is reading and detect
   * drift between environments on the same commit.
   */
  path: string | null;
  /**
   * Non-secret SHA-256 fingerprint of the resolved policy
   * (`{ version, source, mappings, owners }` with keys sorted). Stable
   * across processes so two environments on the same commit should produce
   * the same hash for their respective loaded configs; mismatches indicate
   * drift between `~/.openclaw/tasks-api/required-approvals.yaml` instances.
   */
  hash: string;
}

/**
 * Built-in default owner per approval type. Used both as the fallback when
 * the loaded config does not override a type and as the seed for the
 * `DEFAULT_REQUIRED_APPROVALS.owners` snapshot. Approval-type → owner
 * mappings are global (not per-task-type) because the same gate is owned
 * by the same person regardless of the work it gates.
 */
export const DEFAULT_APPROVAL_OWNERS: Record<string, string> = {
  spec: 'Tom',
  tech_design: 'Quinn',
  qa_agent: 'Ash',
  accepted: 'Tom'
};

function canonicalConfigFingerprint(
  version: number,
  source: RequiredApprovalsConfig['source'],
  mappings: Record<string, string[]>,
  owners: Record<string, string>
): string {
  const sortedMappings: Record<string, string[]> = {};
  for (const key of Object.keys(mappings).sort()) {
    sortedMappings[key] = [...mappings[key]];
  }
  const sortedOwners: Record<string, string> = {};
  for (const key of Object.keys(owners).sort()) {
    sortedOwners[key] = owners[key];
  }
  const canonical = JSON.stringify({ version, source, mappings: sortedMappings, owners: sortedOwners });
  return createHash('sha256').update(canonical).digest('hex');
}

export const DEFAULT_REQUIRED_APPROVALS: RequiredApprovalsConfig = (() => {
  const version = 2;
  const mappings = {
    feature: ['spec', 'tech_design', 'qa_agent', 'accepted'],
    code: ['tech_design', 'qa_agent', 'accepted'],
    content: ['spec', 'qa_agent', 'accepted'],
    research: []
  };
  const owners = { ...DEFAULT_APPROVAL_OWNERS };
  return {
    version,
    mappings,
    owners,
    source: 'builtin-default',
    path: null,
    hash: canonicalConfigFingerprint(version, 'builtin-default', mappings, owners)
  };
})();

function resolveDefaultConfigPath(): string {
  const fromEnv = process.env.REQUIRED_APPROVALS_CONFIG_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const home = process.env.HOME ?? '/tmp';
  return resolve(home, '.openclaw/tasks-api/required-approvals.yaml');
}

/**
 * Minimal YAML parser for the .openclaw/tasks-api/required-approvals.yaml
 * format. Supports:
 *   - top-level `version: <number>`
 *   - top-level `mappings:` header followed by indented lines of
 *     `<taskType>: [<type>, <type>, ...]`
 *   - top-level `owners:` header followed by indented lines of
 *     `<approvalType>: <owner>` (a single string, not a list)
 *   - `#` end-of-line comments and blank lines
 *
 * Throws on malformed input (e.g. missing `version:`); the loader catches
 * and falls back to the built-in default. Unknown approval types inside the
 * `owners:` block are silently dropped — a typo there should not take the
 * loader down, and the merge layer falls back to the default owner.
 */
export function parseRequiredApprovalsYaml(content: string): RequiredApprovalsConfig {
  const lines = content.split(/\r?\n/);
  let version: number | null = null;
  const mappings: Record<string, string[]> = {};
  const owners: Record<string, string> = {};
  let section: 'none' | 'mappings' | 'owners' = 'none';

  for (const rawLine of lines) {
    // Strip end-of-line comments and trim trailing whitespace.
    const noComment = rawLine.replace(/\s*#.*$/, '');
    if (!noComment.trim()) continue;

    const isTopLevel = !/^[ \t]/.test(noComment);
    const trimmed = noComment.trim();

    if (isTopLevel) {
      const versionMatch = trimmed.match(/^version:\s*(\d+)\s*$/);
      if (versionMatch) {
        version = parseInt(versionMatch[1], 10);
        section = 'none';
        continue;
      }
      if (trimmed === 'mappings:') {
        section = 'mappings';
        continue;
      }
      if (trimmed === 'owners:') {
        section = 'owners';
        continue;
      }
      // Unknown top-level key — ignore and exit the current section.
      section = 'none';
      continue;
    }

    if (section === 'mappings') {
      // Mapping entries must be `<taskType>: [<approval>, ...]`. Lines that
      // do not match this shape are silently skipped: the loader is
      // intentionally lenient about individual entries (so a partial config
      // file remains usable) while still rejecting the entire file when
      // `version:` is missing. Approval-type typos inside the list are still
      // rejected via `validApprovalTypes` below; the silent skip only
      // applies to entries whose shape does not match at all (e.g.
      // `feature: oops` or stray prose).
      const entryMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*\[(.*?)\]\s*$/);
      if (!entryMatch) continue;

      const taskType = entryMatch[1];
      const rawList = entryMatch[2];
      const list = rawList
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      for (const approvalType of list) {
        if (!validApprovalTypes.has(approvalType)) {
          throw new Error(
            `task type "${taskType}" lists unknown approval type "${approvalType}"`
          );
        }
      }

      mappings[taskType] = list;
      continue;
    }

    if (section === 'owners') {
      // Owner entries are `<approvalType>: <owner-name>` (single string).
      // The owner name is intentionally not validated against
      // `validAssignees` so operators can experiment with free-form names
      // (mirroring `Task.assignee`) without taking the loader down. Unknown
      // approval-type keys are silently skipped — the merge layer falls
      // back to `DEFAULT_APPROVAL_OWNERS` for any approval type without a
      // configured owner, so a typo there can't gate a task incorrectly.
      const entryMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*([^\s#].*?)\s*$/);
      if (!entryMatch) continue;
      const approvalType = entryMatch[1];
      if (!validApprovalTypes.has(approvalType)) continue;
      owners[approvalType] = entryMatch[2];
      continue;
    }
  }

  if (version === null) {
    throw new Error('missing top-level `version: <number>` directive');
  }

  return { version, mappings, owners, source: 'config-file' };
}

// Emit the resolved policy once per process so operators can detect drift
// between environments on the same commit (see 2026-W32 audit, [Medium]
// Approval-policy-depends-on-mutable-host-local-configuration). The first
// caller (typically the lobster on startup) writes the snapshot; subsequent
// calls reuse the already-loaded path. The flag is module-private to keep
// the "fire once" semantics outside the public API; tests reset it via the
// `_resetStartupLogForTesting` helper.
let _startupLogEmitted = false;

/** @internal Exposed for tests so the memoized flag can be cleared between
 *  `it` blocks. Not part of the public API. */
export function _resetStartupLogForTesting(): void {
  _startupLogEmitted = false;
}

function emitResolvedPolicyStartupLog(config: RequiredApprovalsConfig): void {
  if (_startupLogEmitted) return;
  _startupLogEmitted = true;
  // Hash is 64 hex chars; show the first 12 so logs stay readable while
  // still surfacing enough entropy to spot drift between environments.
  const shortHash = config.hash.slice(0, 12);
  const pathLabel = config.path ?? '<built-in default>';
  console.info(
    `[required-approvals] resolved policy: source=${config.source} version=${config.version} hash=${shortHash}… path=${pathLabel}`
  );
}

export function loadRequiredApprovalsConfig(
  configPath: string = resolveDefaultConfigPath()
): RequiredApprovalsConfig {
  if (!existsSync(configPath)) {
    const resolved = DEFAULT_REQUIRED_APPROVALS;
    emitResolvedPolicyStartupLog(resolved);
    return resolved;
  }

  try {
    const content = readFileSync(configPath, 'utf8');
    const parsed = parseRequiredApprovalsYaml(content);
    // Merge parsed mappings over the default so a partial config file (e.g.
    // a single override for `feature`) still resolves unknown task types to
    // the default list. Keeps the file as a delta, not a full replacement.
    const mergedMappings: Record<string, string[]> = {
      ...DEFAULT_REQUIRED_APPROVALS.mappings,
      ...parsed.mappings
    };
    // Same delta-merge semantics for owners: an approval type without a
    // configured owner in the file falls back to `DEFAULT_APPROVAL_OWNERS`.
    const mergedOwners: Record<string, string> = {
      ...DEFAULT_APPROVAL_OWNERS,
      ...parsed.owners
    };
    const resolved: RequiredApprovalsConfig = {
      version: parsed.version,
      mappings: mergedMappings,
      owners: mergedOwners,
      source: 'config-file',
      path: configPath,
      hash: canonicalConfigFingerprint(parsed.version, 'config-file', mergedMappings, mergedOwners)
    };
    emitResolvedPolicyStartupLog(resolved);
    return resolved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[required-approvals] failed to parse ${configPath}: ${message}. Falling back to built-in default.`
    );
    const resolved = DEFAULT_REQUIRED_APPROVALS;
    emitResolvedPolicyStartupLog(resolved);
    return resolved;
  }
}

export function requiredApprovalsFor(
  config: RequiredApprovalsConfig,
  taskType: string | null | undefined
): string[] {
  if (!taskType) return [];
  return config.mappings[taskType] ?? [];
}

/**
 * Resolved owner for a required approval type. Returns the configured owner
 * for the given approval type, or `null` when the type is not a known
 * approval type (free-form strings cannot gate a task). Used by the
 * `workflowGates` derivation to surface who owns an outstanding gate when
 * no `TaskApproval` row exists yet — the natural source of truth, since
 * hard-coding `spec → Tom` in the UI duplicates policy state in two places.
 */
export function gateOwnerFor(
  config: RequiredApprovalsConfig,
  approvalType: string | null | undefined
): string | null {
  if (!approvalType || !validApprovalTypes.has(approvalType)) return null;
  return config.owners[approvalType] ?? null;
}
