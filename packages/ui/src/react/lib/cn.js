/**
 * Re-export `cn` from the `cn` package.
 *
 * `cn` is the shadcn class-name merger — a drop-in replacement for
 * `twMerge(clsx(...))` with Tailwind v4 conflict resolution. All
 * `@sindustries/ui` React components use this as the canonical class
 * combiner so that Tailwind utility classes compose deterministically
 * (e.g. `cn('text-text-primary', isActive && 'text-cta-primary')`
 * always resolves to a single `text-*` class rather than fighting in
 * the cascade).
 *
 * `cn` ships transitively via `@shadcn/lint`'s dep tree — it lives at
 * the repo root in `node_modules/cn/`. Consumers should depend on this
 * re-export rather than reaching into `node_modules` directly so the
 * package boundary stays explicit and the dependency can be swapped
 * without touching every call site.
 */
export { cn } from 'cn';
