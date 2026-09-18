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

export function Tooltip({ className, ...props }) {
  return <span className={cx('si-tooltip', className)} {...props} />;
}

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
      className={cx(
        'si-card',
        `si-card--${variant}`,
        dataStateClass('si-card', state),
        interactive && 'si-card--interactive',
        typeof tilt === 'number' ? PULSE_TILT_CLASSES[tilt % PULSE_TILT_CLASSES.length] : tilt,
        className
      )}
      {...props}
    />
  );
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
      className={cx('si-card-container', variant && `si-card-container--${variant}`, className)}
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
    <Component className={cx('si-card-container__header', className)} {...props}>
      {title ? <TitleComponent className="si-card-container__title">{title}</TitleComponent> : children}
    </Component>
  );
}

function CardContainerContent({ className, ...props }) {
  return <div className={cx('si-card-container__content', className)} {...props} />;
}

function CardContainerActions({ className, ...props }) {
  return <div className={cx('si-card-container__actions', className)} {...props} />;
}

CardContainer.Header = CardContainerHeader;
CardContainer.Content = CardContainerContent;
CardContainer.Actions = CardContainerActions;

export function Field({ label, className, children, ...props }) {
  return (
    <label className={cx('si-field', className)} {...props}>
      {label ? <span className="si-field__label">{label}</span> : null}
      {children}
    </label>
  );
}

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx('si-input', className)} {...props} />;
});

export const Select = React.forwardRef(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cx('si-input', 'si-select', className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx('si-input', 'si-textarea', className)} {...props} />;
});

export const SearchInput = React.forwardRef(function SearchInput({
  label = 'Search',
  icon = '⌕',
  className,
  inputClassName,
  ...props
}, ref) {
  return (
    <label className={cx('si-search', className)}>
      <span className="si-search__icon" aria-hidden="true">{icon}</span>
      <Input ref={ref} className={cx('si-search__input', inputClassName)} aria-label={label} {...props} />
    </label>
  );
});

export function Dropdown({ className, ...props }) {
  return <div className={cx('si-dropdown', className)} {...props} />;
}

export function DropdownOption({ as: Component = 'button', className, ...props }) {
  return <Component className={cx('si-dropdown__option', className)} {...props} />;
}

export function DropdownDivider(props) {
  return <div className="si-dropdown__divider" aria-hidden="true" {...props} />;
}

export function Divider({ variant = 'subtle', className, ...props }) {
  return <hr className={cx('si-divider', `si-divider--${variant}`, className)} aria-hidden="true" {...props} />;
}

export function Avatar({ src, alt, children, className, onError, ...props }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(src) && !imageFailed;

  function handleImageError(event) {
    setImageFailed(true);
    if (typeof onError === 'function') onError(event);
  }

  return (
    <span className={cx('si-avatar', className)} {...props}>
      {showImage ? (
        <img
          className="si-avatar__img"
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

  return <span className={cx('si-toast__icon', `si-toast__icon--${type}`)}>{icons[type] ?? icons.info}</span>;
}

export function Toast({ type = 'info', title, description, className, children, ...props }) {
  const heading = title ?? children;

  return (
    <div className={cx('si-toast', `si-toast--${type}`, className)} role="status" {...props}>
      <ToastIcon type={type} />
      <div className="si-toast__body">
        {heading ? <p className="si-toast__title">{heading}</p> : null}
        {description ? <p className="si-toast__description">{description}</p> : null}
      </div>
    </div>
  );
}

export function ToastViewport({ className, ...props }) {
  return <div className={cx('si-toast-viewport', className)} {...props} />;
}
