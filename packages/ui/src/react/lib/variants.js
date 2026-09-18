import { cn } from './cn.js';

/**
 * Define a Tailwind variant factory for a UI component.
 *
 * Mirrors the ergonomics of `cva` (class-variance-authority) without
 * pulling in the dependency — `@sindustries/ui` already pulls in
 * `cn` via `@shadcn/lint`, and `defineVariants` only needs `cn` plus a
 * declarative shape.
 *
 * @param {object} definition
 * @param {string | string[]} definition.base  Base classes applied to every
 *   instance. Arrays are flattened. Pass a single string or an array.
 * @param {Record<string, Record<string, string | string[]>>} [definition.variants]
 *   Variants keyed by axis name (e.g. `variant`, `size`, `tone`). Each axis
 *   maps value → class string. `string[]` values are flattened.
 * @param {Record<string, string | string[] | true>} [definition.defaults]
 *   Default variant values used when the consumer does not provide the axis.
 * @param {Record<string, string | string[] | ((opts: Record<string, unknown>) => string | string[] | undefined | false | null)>} [definition.compounds]
 *   Compound classes — apply when ALL listed axis values match. Useful for
 *   "primary + pulse" → different from "primary" alone.
 * @returns {(props?: { variant?: string, size?: string, tone?: string, [k: string]: unknown, class?: string, className?: string }) => string}
 *   A function that takes the consumer's variant props plus a `class` (or
 *   `className`) override and returns the composed class string.
 */
export function defineVariants(definition) {
  const { base, variants = {}, defaults = {}, compounds = {} } = definition ?? {};

  const baseClasses = flatten(base);

  return function resolve(props = {}) {
    const resolved = { ...defaults, ...stripUndefined(props) };

    const parts = [baseClasses];

    for (const [axis, value] of Object.entries(resolved)) {
      if (axis === 'class' || axis === 'className') continue;
      const axisVariants = variants[axis];
      if (!axisVariants) continue;
      const classForValue = axisVariants[value];
      if (classForValue == null) continue;
      parts.push(flatten(classForValue));
    }

    for (const [key, fn] of Object.entries(compounds)) {
      if (typeof fn !== 'function') continue;
      const applied = fn(resolved);
      if (applied == null || applied === false) continue;
      parts.push(flatten(applied));
    }

    const override = props.class ?? props.className;
    if (override) parts.push(flatten(override));

    return cn(...parts);
  };
}

function flatten(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([cls]) => cls)
      .join(' ');
  }
  return '';
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
