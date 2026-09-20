import React, { useState } from 'react';

import { cn } from './lib/cn.js';
import { defineVariants } from './lib/variants.js';

export function cx(...values) {
  return values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return cx(...value);
    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([key]) => key);
    }
    return [value];
  }).join(' ');
}

/**
 * Button variant factory.
 *
 * Maps the legacy `si-button--<variant>` BEM classes to Tailwind v4
 * utility classes (sourced from `tailwind-theme.css` `@theme inline`
 * bridge). Per-variant hover border-color overrides stay in
 * `kit-pulse.css` / `base.css` because they use `color-mix()` rules
 * that don't translate cleanly to utility-class composition without
 * `@utility` declarations (out of scope for slice 3).
 *
 * Kit-specific overrides:
 * - `tone='pulse' | 'display'` — handled in `kit-pulse.css` via the
 *   `.si-button--pulse` / `.si-button--display` selectors, which key
 *   off the legacy class. We keep the legacy `si-button--pulse` /
 *   `si-button--display` classes emitted by this factory so the kit
 *   CSS keeps working without rewrite.
 * - `[data-si-pack='brand']` — handled in `kit-brand.css`. The
 *   migrated utility classes compose with the brand-kit overrides
 *   via the cascade.
 */
const buttonClasses = defineVariants({
  base: [
    'inline-flex items-center justify-center gap-2',
    'font-ui font-extrabold leading-none no-underline uppercase',
    'rounded-pill border-2 border-border-subtle cursor-pointer',
    'min-h-10 px-4',
    'transition-[background,border-color,box-shadow,color,transform] duration-150 ease-out'
  ],
  variants: {
    variant: {
      primary: 'bg-cta-primary border-cta-primary text-cta-primary-text',
      secondary: 'bg-cta-secondary border-cta-secondary text-text-primary',
      outline: 'bg-transparent border-border-subtle text-text-primary',
      ghost: 'bg-bg-field border-transparent text-text-primary',
      destructive: 'bg-accent-500 border-accent-500 text-on-danger-fg',
      nav: 'bg-bg-section border-border-subtle text-text-primary',
      filter:
        'bg-bg-section border-border-subtle text-text-primary justify-between min-w-0 w-full overflow-hidden pr-3 text-left'
    },
    size: {
      sm: 'min-h-8 px-3',
      md: 'min-h-10 px-4',
      lg: 'min-h-12 px-5'
    }
  },
  defaults: { variant: 'secondary', size: 'md' }
});

export const PULSE_TILT_CLASSES = ['si-card-tilt-0', 'si-card-tilt-1', 'si-card-tilt-2'];

function dataStateClass(prefix, state) {
  return state ? `${prefix}--${state}` : null;
}

export function Button({
  as: Component = 'button',
  variant = 'secondary',
  tone,
  active = false,
  size = 'md',
  className,
  ...props
}) {
  return (
    <Component
      className={cn(
        buttonClasses({ variant, size }),
        // Emit the legacy BEM classes alongside the Tailwind utilities so
        // (a) kit CSS rules in `base.css`, `kit-pulse.css`, and
        // `kit-brand.css` continue to match (`:hover`, `::after`, etc.),
        // (b) existing consumer tests that assert on `si-button--<variant>`
        // stay green during the slice-3 migration. The `si-button--<variant>`
        // emissions will be retired once slices 4 + 5 collapse the kit CSS
        // into utility classes and the snapshot tests in
        // `__snapshots__/` cover the variant matrix instead.
        'si-button',
        `si-button--${variant}`,
        `si-button--${size}`,
        tone && `si-button--${tone}`,
        active && 'is-active',
        className
      )}
      {...props}
    />
  );
}

/**
 * Badge variant factory.
 *
 * Every `si-badge--<variant>` color rule in `base.css` uses
 * `color-mix()` to blend the variant hue with
 * `--si-color-bg-section` (e.g. `urgent` blends `--si-color-status-danger`
 * 22% with `--si-color-bg-section`). That blend does not translate
 * cleanly to a Tailwind utility class without an `@utility`
 * declaration (out of scope for slice 3 partial — slice 5 collapses
 * the kit CSS into utility classes or `@utility` declarations land).
 *
 * Slice 3 migrates the **layout/typography** surface to Tailwind
 * utility classes — `inline-flex`, `items-center`, `font-ui`,
 * `font-extrabold`, `leading-none`, `capitalize`, `rounded-pill`,
 * `border`, `text-xs`, `min-h-[22px]`, `px-2` — and keeps the legacy
 * `si-badge--<variant>` class as the source of color so the existing
 * `base.css` / `kit-pulse.css` rules continue to match. The legacy
 * classes retire when slices 4 + 5 land. `defineVariants` is wired so
 * future variants with non-color-mix colors can extend this factory
 * without changing the call site.
 */
const badgeClasses = defineVariants({
  base: [
    'inline-flex items-center',
    'font-ui font-extrabold leading-none capitalize',
    'rounded-pill border',
    'text-xs min-h-[22px] px-2'
  ]
});

export function Badge({ as: Component = 'span', variant = 'neutral', tone, className, ...props }) {
  return (
    <Component
      className={cn(
        badgeClasses({ variant, tone }),
        // Legacy color classes (color-mix blends) + tone='pulse'
        // kit-pulse overrides. Retired in slices 4 + 5 when the kit CSS
        // collapses to utility classes (or `@utility` declarations land).
        'si-badge',
        `si-badge--${variant}`,
        tone ? `si-badge--${tone}` : null,
        className
      )}
      {...props}
    />
  );
}

/**
 * Tooltip variant factory.
 *
 * Maps the legacy `si-tooltip` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge). The shadow
 * is a custom literal (`0 2px 3.5px -1px rgb(0 0 0 / 0.06)`) emitted via
 * an arbitrary-value utility class — `--si-shadow-soft` / `--si-shadow-hard`
 * are too coarse for this surface, and an `@utility` declaration is out
 * of scope for slice 3 (slice 5 may collapse it).
 */
const tooltipClasses = defineVariants({
  base: [
    'inline-flex items-center justify-center',
    'bg-cta-secondary border border-border-subtle rounded-pill',
    'font-ui font-bold text-sm text-text-primary',
    'shadow-[0_2px_3.5px_-1px_rgb(0_0_0/0.06)]',
    'py-[3px] px-3'
  ]
});

export function Tooltip({ className, ...props }) {
  return (
    <span
      className={cn(
        tooltipClasses(),
        // Legacy BEM class retained so:
        // (a) the `si-tooltip` rule in `base.css` continues to match any
        //     downstream kit overrides that key off the legacy selector,
        // (b) the consumer test in `index.test.jsx` (`toHaveClass('si-tooltip')`)
        //     stays green during the slice-3 migration. Both retire in
        //     slices 4 + 5 when the kit CSS collapses to utility classes
        //     (or `@utility` declarations land).
        'si-tooltip',
        className
      )}
      {...props}
    />
  );
}

/**
 * Card variant factory.
 *
 * Maps the legacy `si-card` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge).
 *
 * Layout/typography surface:
 * - `bg-bg-section border border-border-subtle rounded-lg text-text-primary p-5`
 *   is the default card chrome, equivalent to the legacy `.si-card` rule.
 * - `pulse` variant overrides background / border / radius / padding to
 *   match `.si-card--pulse` in `kit-pulse.css` (`bg-bg-surface`,
 *   `border-2 border-bg-canvas`, `rounded-none`, `shadow-hard`,
 *   `py-[14px] px-4`).
 *
 * State surface (`.si-card--ready`, `.si-card--blocked`,
 * `.si-card--archived`, `.si-card--editing`):
 * - `ready` → `border-status-success`
 * - `blocked` → `bg-accent-500 border-accent-500 text-on-danger-fg`
 * - `archived` → `grayscale-[0.7] opacity-55`
 * - `editing` → `border-cta-primary`
 *
 * `:focus-within` rule (`border-color: var(--si-color-cta-primary)` in
 * `base.css`) becomes `focus-within:border-cta-primary` on the base
 * so the editing-state and the focus-within pseudo both resolve.
 *
 * Interactive (`.si-card--interactive` + `:hover`): handled as an
 * additive boolean class string rather than a variant axis because the
 * `:hover` rule is one declaration. `tilt` stays as a CSS-variable
 * setter (`.si-card-tilt-<n>`) — those rules only set `--si-card-rotate`
 * / `--si-card-rotate-hover` and are read by the pulse variant's
 * `transform rotate(var(--si-card-rotate, 0deg))`. They retire when
 * slice 5 collapses the kit CSS into utility classes or `@utility`
 * declarations.
 *
 * Legacy BEM classes retained as additive emissions so `base.css` /
 * `kit-pulse.css` kit overrides and existing consumer tests stay green
 * during the slice-3 migration. Retires in slices 4 + 5.
 */
const cardClasses = defineVariants({
  base: [
    'bg-bg-section border border-border-subtle rounded-lg',
    'text-text-primary',
    'p-5',
    'focus-within:border-cta-primary'
  ],
  variants: {
    variant: {
      default: '',
      ink: '',
      pulse: 'bg-bg-surface border-2 border-bg-canvas rounded-none shadow-hard py-[14px] px-4'
    },
    state: {
      ready: 'border-status-success',
      blocked: 'bg-accent-500 border-accent-500 text-on-danger-fg',
      archived: 'grayscale-[0.7] opacity-55',
      editing: 'border-cta-primary'
    }
  }
});

export const Card = React.forwardRef(function Card({
  as: Component = 'article',
  variant = 'default',
  state,
  interactive = false,
  tilt,
  className,
  ...props
}, ref) {
  return (
    <Component
      ref={ref}
      className={cn(
        cardClasses({ variant, state }),
        interactive &&
          'cursor-pointer transition duration-150 ease-out hover:border-border-strong',
        typeof tilt === 'number' ? PULSE_TILT_CLASSES[tilt % PULSE_TILT_CLASSES.length] : tilt,
        // Legacy BEM classes retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-card',
        `si-card--${variant}`,
        dataStateClass('si-card', state),
        interactive && 'si-card--interactive',
        className
      )}
      {...props}
    />
  );
});

/**
 * CardContainer variant factory.
 *
 * Maps the legacy `si-card-container` BEM class to Tailwind v4 utility
 * classes (sourced from `tailwind-theme.css` `@theme inline` bridge).
 * The chrome — `bg-bg-section border-2 border-ink-950 rounded-none
 * grid overflow-hidden` — matches the legacy `.si-card-container` rule
 * in `kit-pulse.css`. The `column` variant adds `grid-rows-[auto_1fr]
 * h-full min-h-full w-full` to fill available height. The `filter`
 * variant uses `bg-bg-surface border-l-0 border-r-0 border-t-2
 * border-b-2 border-ink-950 shadow-none h-auto mb-4 max-w-none
 * min-h-0 overflow-visible relative w-full z-20` to match the
 * filter-bar override; the column descendant selectors stay in
 * `kit-pulse.css` for now and retire in slice 5.
 *
 * Legacy BEM classes retained as additive emissions so kit overrides
 * (`.si-card-container--column .si-card-container__header` etc.) and
 * existing consumer tests stay green during the slice-3 migration.
 * Retires in slices 4 + 5.
 */
const cardContainerClasses = defineVariants({
  base: ['bg-bg-section border-2 border-ink-950 rounded-none grid overflow-hidden text-text-primary'],
  variants: {
    variant: {
      column: 'grid-rows-[auto_1fr] h-full min-h-full w-full',
      filter: 'bg-bg-surface border-l-0 border-r-0 border-t-2 border-b-2 border-ink-950 shadow-none h-auto mb-4 max-w-none min-h-0 overflow-visible relative w-full z-20',
      hidden: 'hidden'
    }
  }
});

const cardContainerHeaderClasses = defineVariants({
  base: ['bg-bg-section-header p-3']
});

const cardContainerTitleClasses = defineVariants({
  base: ['font-display text-base font-bold leading-normal m-0 text-text-primary']
});

const cardContainerContentClasses = defineVariants({
  base: ['bg-bg-section grid gap-4 p-3']
});

const cardContainerActionsClasses = defineVariants({
  base: ['flex flex-wrap items-center gap-2 p-3']
});

export const CardContainer = React.forwardRef(function CardContainer({
  as: Component = 'article',
  variant,
  className,
  children,
  ...props
}, ref) {
  return (
    <Component
      ref={ref}
      className={cn(
        cardContainerClasses({ variant }),
        // Legacy BEM classes retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-card-container',
        variant && `si-card-container--${variant}`,
        className
      )}
      {...props}
    >
      {children}
    </Component>
  );
});

function CardContainerHeader({
  as: Component = 'div',
  title,
  titleAs: TitleComponent = 'h2',
  className,
  children,
  ...props
}) {
  return (
    <Component
      className={cn(
        cardContainerHeaderClasses(),
        // Legacy BEM class retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-card-container__header',
        className
      )}
      {...props}
    >
      {title ? (
        <TitleComponent
          className={cn(
            cardContainerTitleClasses(),
            // Legacy BEM class retained for kit overrides + existing tests.
            // Retires in slices 4 + 5.
            'si-card-container__title',
            className
          )}
        >
          {title}
        </TitleComponent>
      ) : (
        children
      )}
    </Component>
  );
}

function CardContainerContent({ className, ...props }) {
  return (
    <div
      className={cn(
        cardContainerContentClasses(),
        // Legacy BEM class retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-card-container__content',
        className
      )}
      {...props}
    />
  );
}

function CardContainerActions({ className, ...props }) {
  return (
    <div
      className={cn(
        cardContainerActionsClasses(),
        // Legacy BEM class retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-card-container__actions',
        className
      )}
      {...props}
    />
  );
}

CardContainer.Header = CardContainerHeader;
CardContainer.Content = CardContainerContent;
CardContainer.Actions = CardContainerActions;

/**
 * Field variant factory.
 *
 * Maps the legacy `si-field` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge). The
 * wrapper is a 1-column grid with `gap-1` — equivalent to
 * `display: grid; gap: var(--si-space-1)` in the original CSS. The
 * inner label uses `text-text-muted`, `font-ui`, `text-[0.8rem]`,
 * `font-medium` to match the legacy `si-field__label` rule. Both
 * legacy BEM classes retire in slices 4 + 5.
 */
const fieldClasses = defineVariants({
  base: ['grid gap-1']
});

const fieldLabelClasses = defineVariants({
  base: ['font-ui text-[0.8rem] font-medium text-text-muted']
});

export function Field({ label, className, children, ...props }) {
  return (
    <label
      className={cn(
        fieldClasses(),
        // Legacy BEM class retained so the `si-field` rule in `base.css`
        // continues to match any downstream kit overrides that key off
        // the legacy selector. Retires in slices 4 + 5.
        'si-field',
        className
      )}
      {...props}
    >
      {label ? (
        <span
          className={cn(
            fieldLabelClasses(),
            // Legacy BEM class retained so the `si-field__label` rule in
            // `base.css` continues to match any downstream kit overrides
            // that key off the legacy selector. Retires in slices 4 + 5.
            'si-field__label'
          )}
        >
          {label}
        </span>
      ) : null}
      {children}
    </label>
  );
}

/**
 * Input variant factory.
 *
 * Maps the legacy `si-input` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge). The chrome
 * — `bg-bg-field`, `border-2 border-border-subtle`, `rounded-sm`,
 * `text-text-secondary`, `min-h-10`, `py-2 px-3`, `w-full` — matches the
 * original CSS 1:1, plus placeholder color (`placeholder:text-text-muted`)
 * and focus border (`focus:border-cta-primary focus:outline-none`). The
 * legacy `si-input` class is retained as an additive class string so the
 * `base.css` rules for `:focus-visible` outline continue to match. Retires
 * in slices 4 + 5.
 */
const inputBaseClasses = [
  'font-ui',
  'bg-bg-field border-2 border-border-subtle rounded-sm',
  'text-text-secondary min-h-10 py-2 px-3 w-full',
  'placeholder:text-text-muted',
  'focus:border-cta-primary focus:outline-none'
];

const inputClasses = defineVariants({
  base: inputBaseClasses
});

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        inputClasses(),
        // Legacy BEM class retained so:
        // (a) the `si-input` rule in `base.css` (font-family + focus
        //     outline) continues to match,
        // (b) the consumer test in `index.test.jsx`
        //     (`toHaveClass('si-input')`) stays green. Retires in
        //     slices 4 + 5 when the kit CSS collapses to utility
        //     classes (or `@utility` declarations land).
        'si-input',
        className
      )}
      {...props}
    />
  );
});

/**
 * Select shares the Input chrome — `base.css` declares `si-input` and
 * `si-select` in the same font-family rule and gives Select no
 * variant-specific styling beyond inheriting Input's chrome. We re-use
 * `inputClasses()` and add the legacy `si-select` class for any future
 * kit overrides that key off the selector. Retires in slices 4 + 5.
 */
export const Select = React.forwardRef(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        inputClasses(),
        // Legacy BEM class retained for kit override selector matching.
        'si-input',
        'si-select',
        className
      )}
      {...props}
    />
  );
});

/**
 * Textarea variant factory.
 *
 * Inherits the Input chrome and adds `resize-y` to mirror the legacy
 * `si-textarea { resize: vertical; }` rule in `base.css`. The legacy
 * `si-textarea` class is retained for `base.css` `:focus` border-color
 * matching (`si-input:focus, .si-textarea:focus`). Retires in
 * slices 4 + 5.
 */
const textareaClasses = defineVariants({
  base: [...inputBaseClasses, 'resize-y']
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        textareaClasses(),
        // Legacy BEM class retained for kit override selector matching
        // (the `base.css` rule pairs `si-input:focus, .si-textarea:focus`
        // for the focus border-color).
        'si-input',
        'si-textarea',
        className
      )}
      {...props}
    />
  );
});

/**
 * SearchInput variant factories.
 *
 * Three coordinated surfaces — wrapper (label), icon (span), and inner
 * input. The wrapper uses `inline-flex items-center min-w-[260px] relative`
 * to mirror `base.css` `si-search`. The icon is absolutely positioned at
 * `left-3` with `text-[1.1rem] leading-none pointer-events-none z-1` —
 * preserves the original CSS coordinates exactly (no vertical centering,
 * matching the legacy icon's `position: absolute; left: var(--si-space-3)`
 * with no `top` property; the icon sits at the top of the wrapper because
 * the input below it determines the wrapper height via the input's own
 * min-h-10). The inner input keeps `bg-bg-section` (overrides Input's
 * `bg-bg-field`), `rounded-pill` (overrides Input's `rounded-sm`), and
 * `pl-[2.5rem]` — equivalent to the legacy
 * `padding-left: calc(var(--si-space-3) + 1.25rem + var(--si-space-2))`
 * (0.75rem + 1.25rem + 0.5rem = 2.5rem).
 */
const searchClasses = defineVariants({
  base: ['inline-flex items-center min-w-[260px] relative']
});

const searchIconClasses = defineVariants({
  base: ['absolute left-3 text-text-muted text-[1.1rem] leading-none pointer-events-none z-1']
});

const searchInputClasses = defineVariants({
  base: [
    'font-ui',
    'bg-bg-section border-2 border-border-subtle rounded-pill',
    'text-text-secondary min-h-10 py-2 pr-3 pl-[2.5rem] w-full',
    'placeholder:text-text-muted',
    'focus:border-cta-primary focus:outline-none'
  ]
});

export const SearchInput = React.forwardRef(function SearchInput({
  label = 'Search',
  icon = '⌕',
  className,
  inputClassName,
  ...props
}, ref) {
  return (
    <label
      className={cn(
        searchClasses(),
        // Legacy BEM class retained for kit override selector matching.
        'si-search',
        className
      )}
    >
      <span
        className={cn(
          searchIconClasses(),
          // Legacy BEM class retained for kit override selector matching.
          'si-search__icon'
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <Input
        ref={ref}
        className={cn(
          searchInputClasses(),
          // Legacy BEM class retained so:
          // (a) the `si-search__input` rule in `base.css` (rounded-pill +
          //     padding-left) continues to match,
          // (b) the consumer test in `index.test.jsx`
          //     (`toHaveClass('si-search__input')`) stays green. The
          //     utility classes compose with the legacy rule; the legacy
          //     rule retires in slices 4 + 5.
          'si-search__input',
          inputClassName
        )}
        aria-label={label}
        {...props}
      />
    </label>
  );
});

/**
 * Dropdown variant factory.
 *
 * Maps the legacy `si-dropdown` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge). The
 * surface — `bg-section`, `border-2 border-border-subtle`, `rounded-md`,
 * `shadow-soft`, `gap-1`, `min-w-[220px]`, `p-2` — matches the original
 * 1:1 and the legacy `si-dropdown` rule in `base.css` continues to
 * match as an additive class string. Retires in slices 4 + 5.
 */
const dropdownClasses = defineVariants({
  base: [
    'grid gap-1 min-w-[220px] p-2',
    'bg-bg-section border-2 border-border-subtle rounded-md',
    'shadow-soft'
  ]
});

export function Dropdown({ className, ...props }) {
  return (
    <div
      className={cn(
        dropdownClasses(),
        // Legacy BEM class retained so the `si-dropdown` rule in `base.css`
        // continues to match any downstream kit overrides that key off the
        // legacy selector. Retires in slices 4 + 5 when the kit CSS
        // collapses to utility classes (or `@utility` declarations land).
        'si-dropdown',
        className
      )}
      {...props}
    />
  );
}

/**
 * DropdownOption variant factory.
 *
 * Maps the legacy `si-dropdown__option` BEM class to Tailwind v4 utility
 * classes (sourced from `tailwind-theme.css` `@theme inline` bridge). The
 * hover treatment is `:hover:bg-text-primary/8` via Tailwind v4's native
 * opacity modifier syntax (`bg-text-primary/8`) — `color-mix(in srgb,
 * var(--si-color-text-primary) 8%, transparent)` in the original CSS
 * reduces to the same final value once Tailwind resolves the alpha
 * modifier against the CSS variable. Retires in slices 4 + 5.
 */
const dropdownOptionClasses = defineVariants({
  base: [
    'flex items-center gap-2',
    'bg-transparent border-0 rounded-sm',
    'text-text-primary text-[0.85rem] font-extrabold uppercase',
    'min-h-8 p-2 text-left w-full cursor-pointer',
    'hover:bg-text-primary/[0.08]'
  ]
});

export function DropdownOption({ as: Component = 'button', className, ...props }) {
  return (
    <Component
      className={cn(
        dropdownOptionClasses(),
        // Legacy BEM class retained so the `si-dropdown__option` rule
        // (and its `:hover` rule) in `base.css` continues to match any
        // downstream kit overrides that key off the legacy selector.
        // Retires in slices 4 + 5 when the kit CSS collapses to utility
        // classes (or `@utility` declarations land).
        'si-dropdown__option',
        className
      )}
      {...props}
    />
  );
}

/**
 * DropdownDivider variant factory.
 *
 * Maps the legacy `si-dropdown__divider` BEM class to Tailwind v4 utility
 * classes (sourced from `tailwind-theme.css` `@theme inline` bridge). The
 * divider itself is a 1px tall `bg-border-subtle` block with `my-1` for
 * spacing — equivalent to `height: 1px; margin: var(--si-space-1)` in
 * the original CSS. Retires in slices 4 + 5.
 */
const dropdownDividerClasses = defineVariants({
  base: ['h-px my-1 bg-border-subtle']
});

export function DropdownDivider(props) {
  return (
    <div
      className={cn(
        dropdownDividerClasses(),
        // Legacy BEM class retained so the `si-dropdown__divider` rule in
        // `base.css` continues to match any downstream kit overrides that
        // key off the legacy selector. Retires in slices 4 + 5.
        'si-dropdown__divider',
        props.className
      )}
      aria-hidden="true"
      {...props}
    />
  );
}

/**
 * Divider variant factory.
 *
 * Maps the legacy `si-divider` / `si-divider--<variant>` BEM classes to
 * Tailwind v4 utility classes (sourced from `tailwind-theme.css`
 * `@theme inline` bridge). Two variants match the original surface:
 *
 * - `subtle` — 1px top border in `--color-border-subtle`
 * - `dashed` — 2px dashed top border in `--color-ink-950`
 *
 * The legacy BEM classes are kept as an additive class string for the
 * slice-3 migration: existing kit CSS in `base.css` continues to match
 * `si-divider` selectors, and consumer tests that assert on the legacy
 * class stay green. Both retire in slices 4 + 5 when the kit CSS
 * collapses to utility classes (or `@utility` declarations land).
 */
const dividerClasses = defineVariants({
  base: ['border-0 m-0 w-full'],
  variants: {
    variant: {
      subtle: 'border-t border-border-subtle',
      dashed: 'border-t-2 border-dashed border-ink-950'
    }
  },
  defaults: { variant: 'subtle' }
});

export function Divider({ variant = 'subtle', className, ...props }) {
  return (
    <hr
      className={cn(
        dividerClasses({ variant }),
        // Legacy BEM class retained so:
        // (a) the `si-divider` rule in `base.css` continues to match any
        //     downstream kit overrides that key off the legacy selector,
        // (b) the consumer test in `index.test.jsx`
        //     (`toHaveClass('si-divider')`) stays green during the slice-3
        //     migration. Both retire in slices 4 + 5 when the kit CSS
        //     collapses to utility classes (or `@utility` declarations land).
        'si-divider',
        `si-divider--${variant}`,
        className
      )}
      aria-hidden="true"
      {...props}
    />
  );
}

/**
 * Avatar variant factory.
 *
 * Maps the legacy `si-avatar` BEM class to Tailwind v4 utility classes
 * (sourced from `tailwind-theme.css` `@theme inline` bridge). The
 * chrome — `inline-flex items-center justify-center bg-status-info
 * rounded-pill text-bg-canvas font-ui text-[0.7rem] font-black
 * uppercase overflow-hidden w-6 h-6` — matches the legacy rule in
 * `base.css`. The inner `<img>` (`si-avatar__img`) keeps its
 * `border-radius: inherit; display: block; height: 100%; object-fit:
 * cover; width: 100%` as `block h-full w-full object-cover rounded-[inherit]`.
 *
 * Legacy BEM classes retained as additive emissions so kit overrides
 * (`.si-card--pulse .si-avatar` in `kit-pulse.css`) and existing
 * consumer tests stay green during the slice-3 migration. Retires in
 * slices 4 + 5.
 */
const avatarClasses = defineVariants({
  base: [
    'inline-flex items-center justify-center',
    'bg-status-info rounded-pill text-bg-canvas',
    'font-ui text-[0.7rem] font-black uppercase',
    'overflow-hidden w-6 h-6'
  ]
});

const avatarImgClasses = defineVariants({
  base: ['block h-full w-full object-cover rounded-[inherit]']
});

export function Avatar({ src, alt, children, className, onError, ...props }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(src) && !imageFailed;

  function handleImageError(event) {
    setImageFailed(true);
    if (typeof onError === 'function') onError(event);
  }

  return (
    <span
      className={cn(
        avatarClasses(),
        // Legacy BEM class retained for kit overrides + existing tests.
        // Retires in slices 4 + 5.
        'si-avatar',
        className
      )}
      {...props}
    >
      {showImage ? (
        <img
          className={cn(
            avatarImgClasses(),
            // Legacy BEM class retained for kit overrides + existing tests.
            // Retires in slices 4 + 5.
            'si-avatar__img'
          )}
          src={src}
          alt={alt ?? ''}
          onError={handleImageError}
        />
      ) : (
        children
      )}
    </span>
  );
}

/**
 * Toast / ToastViewport / ToastIcon variant factories.
 *
 * Map the legacy `si-toast` / `si-toast__*` / `si-toast--<type>` /
 * `si-toast-viewport` / `si-toast__icon--<type>` BEM classes to
 * Tailwind v4 utility classes (sourced from `tailwind-theme.css`
 * `@theme inline` bridge).
 *
 * Toast chrome — `bg-bg-section border-0 rounded-md text-text-primary
 * font-ui flex items-start max-w-[640px] w-full gap-3 py-4 px-6
 * animate-[si-toast-slide-in_200ms_ease]` — matches the legacy rule in
 * `base.css`. The accent border-left (`border-l-2 border-l-solid`)
 * stays; the colour comes from the per-type CSS variable
 * `--si-toast-accent` which is read via `border-l-current` and the
 * `si-toast--<type>` rule that sets `--si-toast-accent` to the per-type
 * token (`--si-color-info-500`, `--si-color-success-500`,
 * `--si-color-brand-500`, `--si-color-danger-500`).
 *
 * Type variants (`info` / `success` / `warning` / `error`):
 * - `info` → `border-l-info-500`
 * - `success` → `border-l-success-500`
 * - `warning` → `border-l-brand-500`
 * - `error` → `border-l-danger-500`
 *
 * Body / title / description / icon / viewport sub-elements migrate
 * layout + typography (grid / flex / text size / colour / spacing)
 * to utility classes. The `si-toast-slide-in` keyframes stay in
 * `base.css` (animation is non-trivial to express as utility classes
 * without an `@utility` declaration).
 *
 * Legacy BEM classes retained as additive emissions so `base.css`
 * rules (`:focus`, the `--si-toast-accent` variable assignment,
 * `@keyframes si-toast-slide-in`, the mobile media-query override on
 * `si-toast-viewport`) and existing consumer tests stay green during
 * the slice-3 migration. Retires in slices 4 + 5.
 */
const toastClasses = defineVariants({
  base: [
    'bg-bg-section border-0 rounded-md text-text-primary',
    'font-ui flex items-start max-w-[640px] w-full gap-3',
    'py-4 px-6',
    'animate-[si-toast-slide-in_200ms_ease]'
  ],
  variants: {
    type: {
      info: 'border-l-2 border-l-solid border-l-info-500',
      success: 'border-l-2 border-l-solid border-l-success-500',
      warning: 'border-l-2 border-l-solid border-l-brand-500',
      error: 'border-l-2 border-l-solid border-l-danger-500'
    }
  },
  defaults: { type: 'info' }
});

const toastIconClasses = defineVariants({
  base: ['inline-flex flex-shrink-0 w-6 h-6 text-[var(--si-toast-accent)]']
});

const toastBodyClasses = defineVariants({
  base: ['grid flex-1 gap-1 min-w-0']
});

const toastTitleClasses = defineVariants({
  base: ['text-base font-medium leading-normal m-0']
});

const toastDescriptionClasses = defineVariants({
  base: ['text-text-secondary text-base font-normal leading-normal m-0']
});

const toastViewportClasses = defineVariants({
  base: ['flex flex-col gap-2 fixed bottom-5 right-5 z-[100] md:bottom-20 md:left-5 md:right-5']
});

function ToastIcon({ type }) {
  const icons = {
    info: (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M12 16v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="currentColor" />
      </svg>
    ),
    success: (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          d="M12 3l7 3v5c0 5-3.5 8.5-7 10C8.5 19.5 5 16 5 11V6l7-3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="m9 12 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    warning: (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          d="M12 3 2.5 19h19L12 3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M12 9v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="currentColor" />
      </svg>
    ),
    error: (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m9 9 6 6M15 9l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  };

  return (
    <span
      className={cn(
        toastIconClasses(),
        // Legacy BEM classes retained so the `si-toast__icon` /
        // `si-toast__icon--<type>` rules in `base.css` continue to
        // match. Retires in slices 4 + 5.
        'si-toast__icon',
        `si-toast__icon--${type}`
      )}
    >
      {icons[type] ?? icons.info}
    </span>
  );
}

export function Toast({ type = 'info', title, description, className, children, ...props }) {
  const heading = title ?? children;

  return (
    <div
      className={cn(
        toastClasses({ type }),
        // Legacy BEM classes retained so the `si-toast` /
        // `si-toast--<type>` rules in `base.css` (--si-toast-accent
        // assignment, slide-in animation) continue to match. Retires
        // in slices 4 + 5.
        'si-toast',
        `si-toast--${type}`,
        className
      )}
      role="status"
      {...props}
    >
      <ToastIcon type={type} />
      <div
        className={cn(
          toastBodyClasses(),
          // Legacy BEM class retained for kit override selector
          // matching. Retires in slices 4 + 5.
          'si-toast__body'
        )}
      >
        {heading ? (
          <p
            className={cn(
              toastTitleClasses(),
              // Legacy BEM class retained for kit override selector
              // matching. Retires in slices 4 + 5.
              'si-toast__title'
            )}
          >
            {heading}
          </p>
        ) : null}
        {description ? (
          <p
            className={cn(
              toastDescriptionClasses(),
              // Legacy BEM class retained for kit override selector
              // matching. Retires in slices 4 + 5.
              'si-toast__description'
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ToastViewport({ className, ...props }) {
  return (
    <div
      className={cn(
        toastViewportClasses(),
        // Legacy BEM class retained so the `si-toast-viewport` rule
        // and its mobile media-query override in `base.css` continue
        // to match. Retires in slices 4 + 5.
        'si-toast-viewport',
        className
      )}
      {...props}
    />
  );
}
