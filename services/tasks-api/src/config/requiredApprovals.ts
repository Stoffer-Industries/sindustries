// Configurable taskType -> required-approvals mapping for the Tasks API.
//
// The mapping is editable by Quinn or Tom without a code deploy. The Tasks API
// reads `.openclaw/tasks-api/required-approvals.yaml` on startup; if the file
// is missing or malformed, the loader falls back to a built-in default and
// logs a WARN. The default values match the task spec defaults:
//   feature: [spec, tech_design, qa]
//   code:    [tech_design, qa]
//   content: [spec, qa]
//   research: []
//
// The file format is intentionally narrow — a top-level `version:` line and
// an indented `mappings:` block. The loader is hand-rolled to avoid pulling
// in a YAML dependency for a structure that fits in ~30 lines of parsing.
//
// See docs/specs/tasks-api-native-approvals-tech-design.md WS2.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validApprovalTypes } from '../routes/tasks/_constants.ts';

export interface RequiredApprovalsConfig {
  version: number;
  mappings: Record<string, string[]>;
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
   * (`{ version, source, mappings }` with keys sorted). Stable across
   * processes so two environments on the same commit should produce the
   * same hash for their respective loaded configs; mismatches indicate
   * drift between `~/.openclaw/tasks-api/required-approvals.yaml` instances.
   */
  hash: string;
}

function canonicalConfigFingerprint(
  version: number,
  source: RequiredApprovalsConfig['source'],
  mappings: Record<string, string[]>
): string {
  const sortedMappings: Record<string, string[]> = {};
  for (const key of Object.keys(mappings).sort()) {
    sortedMappings[key] = [...mappings[key]];
  }
  const canonical = JSON.stringify({ version, source, mappings: sortedMappings });
  return createHash('sha256').update(canonical).digest('hex');
}

export const DEFAULT_REQUIRED_APPROVALS: RequiredApprovalsConfig = (() => {
  const version = 1;
  const mappings = {
    feature: ['spec', 'tech_design', 'qa'],
    code: ['tech_design', 'qa'],
    content: ['spec', 'qa'],
    research: []
  };
  return {
    version,
    mappings,
    source: 'builtin-default',
    path: null,
    hash: canonicalConfigFingerprint(version, 'builtin-default', mappings)
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
 *   - `#` end-of-line comments and blank lines
 *
 * Throws on malformed input (e.g. missing `version:`); the loader catches
 * and falls back to the built-in default.
 */
export function parseRequiredApprovalsYaml(
  content: string
): Omit<RequiredApprovalsConfig, 'path' | 'hash'> {
  const lines = content.split(/\r?\n/);
  let version: number | null = null;
  const mappings: Record<string, string[]> = {};
  let inMappings = false;

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
        inMappings = false;
        continue;
      }
      if (trimmed === 'mappings:') {
        inMappings = true;
        continue;
      }
      // Unknown top-level key — ignore and exit mappings block.
      inMappings = false;
      continue;
    }

    if (!inMappings) continue;

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
  }

  if (version === null) {
    throw new Error('missing top-level `version: <number>` directive');
  }

  return { version, mappings, source: 'config-file' };
}

export function loadRequiredApprovalsConfig(
  configPath: string = resolveDefaultConfigPath()
): RequiredApprovalsConfig {
  if (!existsSync(configPath)) {
    return DEFAULT_REQUIRED_APPROVALS;
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
    return {
      version: parsed.version,
      mappings: mergedMappings,
      source: 'config-file',
      path: configPath,
      hash: canonicalConfigFingerprint(parsed.version, 'config-file', mergedMappings)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[required-approvals] failed to parse ${configPath}: ${message}. Falling back to built-in default.`
    );
    return DEFAULT_REQUIRED_APPROVALS;
  }
}

export function requiredApprovalsFor(
  config: RequiredApprovalsConfig,
  taskType: string | null | undefined
): string[] {
  if (!taskType) return [];
  return config.mappings[taskType] ?? [];
}
