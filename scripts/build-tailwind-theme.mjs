/**
 * Regenerate packages/ui/src/react/tailwind-theme.css from
 * packages/design-tokens/styles.css.
 *
 * The generator is intentionally trivial: it parses each `--si-*` custom
 * property declaration out of `styles.css`, then re-exports it as a
 * `--<tailwind-namespace>-<name>: var(--si-...);` line inside a
 * `@theme inline { ... }` block. `@theme inline` tells Tailwind v4 to
 * keep the `var()` chain at use sites (rather than expanding the value
 * into the utility class), so `@sindustries/design-tokens` remains the
 * single source of truth and Tailwind utility classes resolve at runtime
 * to the same value.
 *
 * Categories and the corresponding Tailwind namespace each prefix maps
 * into:
 *
 *   `--si-color-*`        → `--color-*`        (Tailwind color utilities)
 *   `--si-font-*`         → `--font-*`         (Tailwind font-family utilities)
 *   `--si-radius-*`       → `--radius-*`       (Tailwind border-radius utilities)
 *   `--si-shadow-*`       → `--shadow-*`       (Tailwind box-shadow utilities)
 *   `--si-space-*`        → `--spacing-*`      (Tailwind spacing scale)
 *
 * `--si-budget-color-*` (the budget-app sub-namespace) is folded into the
 * color namespace and surfaces as `--color-budget-*`. React Native does
 * not consume Tailwind so the budget-mobile path is unaffected.
 *
 * The output is committed (mirroring the generated-files policy used by
 * `packages/design-tokens/styles.css` and `tokens.ts`). Running the
 * generator without a fresh `tokens.json` is a no-op; the output is
 * deterministic given the same input.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCssAbs = process.env.BTT_INPUT_CSS
  ? resolve(process.env.BTT_INPUT_CSS)
  : resolve(repoRoot, 'packages/design-tokens/styles.css');
const outputCssAbs = process.env.BTT_OUTPUT_CSS
  ? resolve(process.env.BTT_OUTPUT_CSS)
  : resolve(repoRoot, 'packages/ui/src/react/tailwind-theme.css');

/**
 * Map a `--si-<category>-<rest>` token name to its Tailwind theme namespace.
 *
 * Only categories we explicitly re-export are mapped; anything else (e.g.
 * `--si-z-index-*`, `--si-breakpoint-*` if added later) is silently
 * dropped — those would need a deliberate namespace choice and a code
 * review to confirm Tailwind picks them up.
 */
const CATEGORY_TO_NAMESPACE = {
  color: 'color',
  font: 'font',
  radius: 'radius',
  shadow: 'shadow',
  space: 'spacing'
};

/**
 * Tailwind v4 reads theme variables from the @theme block. The list below
 * is the set of namespaces we generate. Order matches CATEGORY_TO_NAMESPACE
 * keys but is irrelevant to Tailwind — declarations are alphabetised
 * within each block.
 */
const EMIT_ORDER = ['color', 'font', 'radius', 'shadow', 'space'];

/**
 * Parse `--si-<category>-<name>: <value>;` declarations out of a CSS
 * source string. Declarations outside `:root` (e.g. nested rules) are
 * ignored — `styles.css` only declares tokens inside `:root` and
 * `[data-si-theme="dark"]`, and both use the same set of property
 * names so a flat deduped collection is what we want.
 *
 * Returns a map keyed by the `--si-...` property name. The value is the
 * raw token value (right-hand side of the declaration, trimmed).
 *
 * @param {string} cssText
 * @returns {Map<string, string>}
 */
function parseSiDeclarations(cssText) {
  /** @type {Map<string, string>} */
  const out = new Map();
  // Match: optional whitespace, `--si-...`, colon, value, semicolon.
  // Property names use kebab-case a-z/0-9; values can contain spaces,
  // commas, parens, slashes, and rgba() etc. — we just slurp until the
  // terminating semicolon at the end of a declaration line.
  const re = /^\s*(--si-[a-z0-9-]+)\s*:\s*([^;]+?)\s*;\s*$/gm;
  let match;
  while ((match = re.exec(cssText)) !== null) {
    const prop = match[1];
    const value = match[2];
    // Preserve the first declaration seen; the second (typically the
    // `[data-si-theme="dark"]` block) is treated as a duplicate and
    // ignored. Both blocks currently mirror each other in `styles.css`,
    // so this is a no-op today; the explicit dedupe keeps the generator
    // safe if they ever diverge.
    if (!out.has(prop)) {
      out.set(prop, value);
    }
  }
  return out;
}

/**
 * Group declarations by Tailwind theme namespace.
 *
 * @param {Map<string, string>} declarations
 * @returns {Record<string, Array<{ prop: string, tailwindProp: string, value: string }>>}
 */
function groupByNamespace(declarations) {
  /** @type {Record<string, Array<{ prop: string, tailwindProp: string, value: string }>>} */
  const grouped = Object.fromEntries(EMIT_ORDER.map((key) => [key, []]));
  for (const [prop, value] of declarations) {
    const rest = prop.slice('--si-'.length);
    const dashIndex = rest.indexOf('-');
    if (dashIndex === -1) continue;
    const category = rest.slice(0, dashIndex);
    const tailwindCategory = CATEGORY_TO_NAMESPACE[category];
    if (!tailwindCategory) continue;
    const tailwindProp = `--${tailwindCategory}-${rest.slice(dashIndex + 1)}`;
    grouped[category].push({ prop, tailwindProp, value });
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => a.tailwindProp.localeCompare(b.tailwindProp));
  }
  return grouped;
}

/**
 * Build the @theme inline block from the grouped declarations.
 *
 * @param {Record<string, Array<{ prop: string, tailwindProp: string, value: string }>>} grouped
 * @returns {string}
 */
function buildThemeBlock(grouped) {
  const sections = [];
  for (const category of EMIT_ORDER) {
    const items = grouped[category];
    if (items.length === 0) continue;
    const namespace = CATEGORY_TO_NAMESPACE[category];
    const heading = `  /* ${namespace} — sourced from ${items.length} --si-${category}-* token(s) */`;
    const lines = items.map(
      ({ tailwindProp, prop }) => `  ${tailwindProp}: var(${prop});`
    );
    sections.push([heading, ...lines].join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * Render the final CSS file. The structure: a leading GENERATED
 * comment, a single `@import "tailwindcss";`, and the generated
 * `@theme inline` block.
 *
 * Note: this file does NOT `@import` `packages/design-tokens/styles.css`
 * itself. The `var(--si-...)` references inside `@theme inline` resolve
 * at runtime against whichever stylesheet the consumer imported the
 * tokens from first — usually `packages/ui/src/react/styles.css`, which
 * already imports `@sindustries/design-tokens/styles.css`. Re-importing
 * the tokens file from this bridge caused the bundler to emit
 * `@import url("...fonts...")` twice, which Lightning CSS rejects as
 * `@import` rules must precede all other rules.
 *
 * @param {string} themeBlock
 * @returns {string}
 */
function renderOutput(themeBlock) {
  return `/*
 * GENERATED FILE — do not edit by hand.
 * Source of truth: packages/design-tokens/styles.css.
 * Regenerate with \`npm run build:tailwind-theme\`.
 *
 * This file bridges @sindustries/design-tokens into a Tailwind v4
 * \`@theme inline\` block. Each \`--si-*\` CSS custom property declared
 * in \`styles.css\` is re-exported here as a \`--<namespace>-*\` Tailwind
 * theme variable backed by a \`var()\` reference. Tailwind utility
 * classes (\`bg-cta-primary\`, \`text-ink-900\`, \`p-4\`, …) resolve at
 * runtime through the same \`var()\` chain, so
 * @sindustries/design-tokens remains the single source of truth and
 * Tailwind never defines its own token values.
 */

@import "tailwindcss";

@theme inline {
${themeBlock}
}
`;
}

async function main() {
  const cssText = await readFile(tokensCssAbs, 'utf8');
  const declarations = parseSiDeclarations(cssText);
  const grouped = groupByNamespace(declarations);
  const themeBlock = buildThemeBlock(grouped);
  const output = renderOutput(themeBlock);
  await writeFile(outputCssAbs, output, 'utf8');
  const totals = Object.fromEntries(
    EMIT_ORDER.map((key) => [key, grouped[key].length])
  );
  process.stdout.write(
    `wrote ${relative(repoRoot, outputCssAbs)} (${declarations.size} tokens; ${Object.entries(totals)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')})\n`
  );
}

main().catch((err) => {
  process.stderr.write(`build-tailwind-theme: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
