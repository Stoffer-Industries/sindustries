/**
 * probe-target-facts.mjs — the facts a deployed probe's targets can be
 * compared by, without recording a single target value.
 *
 * WHY THIS EXISTS
 *
 * AC6 says the production health probe must be "pointed at the new
 * production targets". The repository could prove the DEPLOYED cadence
 * (the production overlay's interval values) and could prove that the
 * production Fly apps exist, but nothing proved WHERE the deployed probe
 * actually looks: a production probe carrying the production cadence while
 * still pointed at the staging database and the staging Redis passes every
 * check the repository owns while watching the wrong environment.
 *
 * The probe's targets are secrets. `HEALTH_PROBE_DATABASES` carries a
 * Postgres DSN with a password, `HEALTH_PROBE_REDIS` a Redis URL with one,
 * and `HEALTH_PROBE_FLY_APPS` a public URL. The artifact this evidence
 * flows into is committed, compared between runs and pasted into task
 * comments, so a raw target value must never reach it.
 *
 * The comparison therefore runs on a HOST IDENTITY: the part of a target
 * value that names WHICH service it points at, with every credential
 * stripped, reduced to a fingerprint. The artifact carries the fingerprint
 * and the target's LABEL — never the host, never the value — and two
 * fingerprints can be compared for equality without either side disclosing
 * what it points at.
 *
 * The same module is imported by the capture and by the checker, so both
 * sides derive an identity the same way. A checker that carried its own
 * copy of the identity rule could agree with a drifted capture.
 *
 * Pure Node, no deps.
 */

import { createHash } from 'node:crypto';

/**
 * The environment variables that name the probe's targets.
 *
 * These are the keys the health probe reads at boot
 * (`infra/cloud/observability/health-probe/src/probe.ts`): comma-separated
 * `label=value` lists. The probe's own cadence variables are read
 * separately, by the capture, because they are numbers rather than
 * targets.
 */
export const PROBE_TARGET_KEYS = [
  'HEALTH_PROBE_FLY_APPS',
  'HEALTH_PROBE_DATABASES',
  'HEALTH_PROBE_REDIS',
];

/**
 * How many hex characters a fingerprint carries.
 *
 * 16 hex characters is 64 bits: far more than enough to tell two service
 * endpoints apart, far too little to reconstruct a hostname by brute force.
 */
const FINGERPRINT_LENGTH = 16;

/**
 * A Neon endpoint id, with the pooler suffix normalised away.
 *
 * Neon serves the same database on two hostnames: the direct endpoint
 * (`ep-abc123.us-east-2.aws.neon.tech`) and the pooler
 * (`ep-abc123-pooler.us-east-2.aws.neon.tech`). Both name the SAME
 * database, so a probe configured with either must compare equal to the
 * production branch the capture read. The endpoint id (`ep-abc123`) is
 * what identifies the database, and a different Neon project has a
 * different id — so normalising the pooler suffix keeps the comparison
 * honest in both directions.
 */
const NEON_ENDPOINT_LABEL = /^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/**
 * The host of a target value, with every credential stripped.
 *
 * The value can be a URL (`https://host/path`), a DSN
 * (`postgresql://user:password@host:5432/db`) or a bare host. Whatever it
 * is, the answer is the host: the userinfo, the port, the path and the
 * query are dropped, because they are either a credential or noise.
 *
 * @param {unknown} value
 * @returns {string|null} the lowercase host, or null when there is none
 */
export function hostOfTargetValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const schemeSplit = raw.indexOf('://');
  const afterScheme = schemeSplit >= 0 ? raw.slice(schemeSplit + 3) : raw;
  const authority = afterScheme.split(/[/?#]/)[0];
  if (!authority) return null;

  const withoutUserInfo = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;

  // An IPv6 literal keeps its brackets and loses its port:
  // `[::1]:5432` → `[::1]`.
  let host = withoutUserInfo;
  if (host.startsWith('[')) {
    const closing = host.indexOf(']');
    host = closing === -1 ? host : host.slice(0, closing + 1);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }

  host = host.trim().toLowerCase();
  return host || null;
}

/**
 * The identity of a host: the part that names WHICH service it is.
 *
 * For a Neon endpoint that is the endpoint id, so the direct and pooler
 * hostnames of one database share an identity while a different database
 * does not. For anything else it is the host itself.
 *
 * @param {unknown} host
 * @returns {string|null}
 */
export function hostIdentity(host) {
  const normalized = String(host ?? '').trim().toLowerCase();
  if (!normalized) return null;

  const firstLabel = normalized.split('.')[0];
  if (NEON_ENDPOINT_LABEL.test(firstLabel)) {
    const endpointId = firstLabel.replace(/-pooler$/, '');
    if (endpointId) return endpointId;
  }
  return normalized;
}

/**
 * The fingerprint of a host identity.
 *
 * The fingerprint is what the artifact carries. It is stable for the same
 * identity and carries nothing about the host itself.
 *
 * @param {unknown} hostOrIdentity
 * @returns {string|null} a hex fingerprint, or null when there is no host
 */
export function hostFingerprint(hostOrIdentity) {
  const identity = hostIdentity(hostOrIdentity);
  if (!identity) return null;
  return createHash('sha256').update(identity).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Parse the probe's target list format.
 *
 * The health probe reads comma-separated `label=value` entries
 * (`parseDbTargets` / `parseHttpTargets` / `parseRedisTargets` in
 * `infra/cloud/observability/health-probe/src/probe.ts`). An entry the
 * probe itself would ignore is counted as malformed rather than dropped
 * silently: a probe carrying a target the probe cannot parse is watching
 * nothing, and the gate has to be able to say so.
 *
 * @param {unknown} raw the raw environment value
 * @returns {{entries: {label: string, host: string}[], malformed: number}}
 */
export function parseProbeTargetEntries(raw) {
  const entries = [];
  let malformed = 0;

  for (const chunk of String(raw ?? '').split(',')) {
    const entry = chunk.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      malformed += 1;
      continue;
    }
    const label = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    const host = hostOfTargetValue(value);
    if (!label || !host) {
      malformed += 1;
      continue;
    }
    entries.push({ label, host });
  }

  return { entries, malformed };
}

/**
 * The fingerprint form of a parsed target list.
 *
 * This is what the artifact carries: the label of each target and the
 * fingerprint of the service it points at. The host itself never leaves
 * this function.
 *
 * @param {unknown} raw the raw environment value
 * @returns {{targets: {label: string, hostFingerprint: string}[], malformed: number}}
 */
export function fingerprintProbeTargets(raw) {
  const { entries, malformed } = parseProbeTargetEntries(raw);
  return {
    targets: entries.map(({ label, host }) => ({
      label,
      hostFingerprint: hostFingerprint(host),
    })),
    malformed,
  };
}
