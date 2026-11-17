/**
 * egress-allowlist-facts.mjs — the facts a Neon IP allowlist and its Fly
 * source addresses can be compared by, without recording an address.
 *
 * WHY THIS EXISTS
 *
 * AC2 asks for a production Neon branch "with connectivity restricted to
 * production services". The repository's own Neon contract names where
 * that restriction is supposed to come from: Fly's APP-SCOPED STATIC EGRESS
 * IPs, allocated per production app, because Fly's shared egress ranges
 * are not a fixed set of addresses and an allowlist built from "the
 * current shared ranges" drifts.
 *
 * Before this module, the repository owned the Neon side of that pair
 * (`allowed_ips.ips`) and NOTHING on the Fly side. The allowlist gate could
 * therefore say "the project carries 0 allowed IP address(es)" and name the
 * Neon account plan as the blocker — which is only HALF the truth. If no
 * app-scoped egress address is allocated, there is no allowlist to apply
 * even after the Neon plan supports one, and a reader of the gate would
 * believe that upgrading the plan closes AC2 on its own. It does not.
 *
 * The same class of defect this chain keeps closing: a gate that reports
 * the consequence and names one cause, while the other cause is invisible.
 *
 * The addresses themselves are never recorded. The artifact is committed,
 * compared between runs and pasted into task comments, so an address is
 * reduced to a fingerprint — the same discipline the probe targets use.
 * Two fingerprint sets can be compared for equality without either side
 * disclosing what it points at.
 *
 * The same module is imported by the capture and by the checker, so both
 * sides derive the identity the same way. A checker that carried its own
 * copy of the identity rule could agree with a drifted capture.
 *
 * Pure Node, no deps.
 */

import { createHash } from 'node:crypto';

/**
 * How many hex characters a fingerprint carries.
 *
 * 16 hex characters is 64 bits: far more than enough to tell two
 * addresses apart, far too little to reconstruct one by brute force.
 */
const FINGERPRINT_LENGTH = 16;

/**
 * The canonical form of an address, for comparison.
 *
 * The same address is written differently by different providers: Fly
 * returns a bare address, Neon stores an allowlist entry as a CIDR
 * (`1.2.3.4/32`), and an IPv6 literal may arrive bracketed or with a
 * zone index. Comparing the raw strings would call two spellings of one
 * address two different addresses — so the prefix length, the brackets and
 * the zone index are dropped and the remainder is lowercased.
 *
 * The address is NOT expanded to its full IPv6 form: a shortened IPv6
 * literal and its expanded spelling are the same address, but expanding it
 * correctly means parsing it, and a half-parsed address is worse than a
 * conservative one. Both providers return addresses in their own canonical
 * form, so the comparison is between provider-written values.
 *
 * @param {unknown} value
 * @returns {string|null} the canonical address, or null when there is none
 */
export function canonicalIp(value) {
  let raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;

  // A CIDR prefix length is a property of the RULE, not of the address.
  const slash = raw.indexOf('/');
  if (slash !== -1) raw = raw.slice(0, slash);

  // An IPv6 literal may arrive bracketed: `[2a09::1]`.
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);

  // An IPv6 zone index (`fe80::1%eth0`) names the local interface, not the
  // address.
  const zone = raw.indexOf('%');
  if (zone !== -1) raw = raw.slice(0, zone);

  raw = raw.trim();
  return raw || null;
}

/**
 * The fingerprint of an address.
 *
 * @param {unknown} value
 * @returns {string|null} a hex fingerprint, or null when there is no address
 */
export function ipFingerprint(value) {
  const canonical = canonicalIp(value);
  if (!canonical) return null;
  return createHash('sha256').update(canonical).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Is this address an IPv6 literal?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIpv6Address(value) {
  const canonical = canonicalIp(value);
  if (!canonical) return false;
  return canonical.includes(':');
}

/**
 * The fingerprint form of a set of addresses.
 *
 * This is what the artifact carries: the fingerprint of each address, with
 * duplicates removed. The addresses themselves never leave this function.
 *
 * @param {unknown} values
 * @returns {string[]} fingerprints, in first-seen order
 */
export function fingerprintIpSet(values) {
  const fingerprints = [];
  for (const value of Array.isArray(values) ? values : []) {
    const fingerprint = ipFingerprint(value);
    if (fingerprint && !fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
  }
  return fingerprints;
}

/**
 * Do two fingerprint sets describe the same addresses?
 *
 * Both sides must be the same size AND contain the same members: an
 * allowlist that is missing an address OR carries one that production does
 * not use is a different set, and the difference is what the gate has to
 * report.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function ipSetsMatch(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((entry) => members.has(entry));
}

/**
 * The members of `left` that are not in `right`.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {string[]}
 */
export function ipSetDifference(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  const members = new Set(right);
  return left.filter((entry) => !members.has(entry));
}
