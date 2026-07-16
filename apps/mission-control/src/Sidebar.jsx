import React, { useEffect, useState } from 'react';
import { Button } from '@sindustries/ui/react';
import { navigate } from './useLocation.js';
import { readStoredTheme, writeStoredTheme, nextTheme, THEME_MESSAGE } from './theme.js';

// localStorage key for the sidebar collapse state. Stored as the string
// "true" / "false" so it round-trips cleanly via JSON.stringify and
// survives private-mode quirks where setItem throws.
const STORAGE_KEY = 'pulse.sidebar.collapsed';

function readStoredCollapsed() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredCollapsed(value) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // localStorage unavailable (private mode). Toggle still works for the
    // session; we deliberately swallow the failure so the UI does not
    // throw during render.
  }
}

function handleTabClick(e, path) {
  // Let the anchor's default click behaviour push history so the URL
  // updates as a real navigation; prevent full reload by stopping the
  // event after our explicit navigate() below.
  e.preventDefault();
  navigate(path);
}

/**
 * ThemeToggle — Day/Night theme switcher owned by the shell.
 *
 * Stateless w.r.t. theme value: the canonical state lives in
 * localStorage. The component reads the latest value on every render,
 * so a sibling tab that updates the storage key triggers a re-render
 * via the `storage` event (see `useThemeSync` below).
 *
 * On click: computes the next theme, writes it to localStorage, sets
 * `data-si-theme` on <html>, and broadcasts a `pulse:theme` postMessage
 * to every iframe in the document so iframe-based tabs follow along.
 */
function ThemeToggle({ collapsed }) {
  // Tick forces a re-render after each click so `readStoredTheme()` picks
  // up the newly-written value and `target` is computed fresh. Without this,
  // clicking twice in the same tab applies the same transition both times.
  const [, setTick] = useState(0);
  const theme = readStoredTheme();
  const target = nextTheme(theme);
  const label = `Switch to ${target} theme`;
  const glyph = theme === 'dark' ? '☾' : '☀';

  // Defensive: ensure <html data-si-theme> reflects the stored value
  // on every render. In normal boot `main.jsx` already does this, but
  // tests render <Sidebar> in isolation, and a stale value (e.g. a
  // user clicked the toggle in a sibling tab) should still be applied
  // when the shell mounts.
  if (typeof document !== 'undefined') {
    const current = document.documentElement.getAttribute('data-si-theme');
    if (current !== theme) {
      document.documentElement.setAttribute('data-si-theme', theme);
    }
  }

  function handleClick() {
    writeStoredTheme(target);
    document.documentElement.setAttribute('data-si-theme', target);
    setTick((t) => t + 1);
    if (typeof window !== 'undefined') {
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          // Use '*' so cross-origin iframes (e.g. Tasks on a different port)
          // receive the broadcast. The theme value is non-sensitive; the
          // receiver validates event.origin before acting.
          frame.contentWindow?.postMessage({ type: THEME_MESSAGE, theme: target }, '*');
        } catch {
          // Detached iframe — ignore.
        }
      }
    }
  }

  return (
    <Button
      as="button"
      type="button"
      variant="ghost"
      size="md"
      className={cx('pulse-sidebar__theme-toggle', collapsed && 'pulse-sidebar__theme-toggle--collapsed')}
      data-testid="pulse-sidebar-theme-toggle"
      data-theme={theme}
      aria-label={label}
      onClick={handleClick}
    >
      <span aria-hidden="true" className="pulse-sidebar__theme-toggle-glyph">{glyph}</span>
      <span
        className={cx('pulse-sidebar__theme-toggle-label', collapsed && 'pulse-sidebar--sr-only')}
      >
        {label}
      </span>
    </Button>
  );
}

/**
 * Tiny hook that re-renders the consuming component when the canonical
 * theme key changes in another browser tab (storage event) or via an
 * echoed postMessage from an iframe (defensive, the shell is the
 * source of truth). Returns nothing; the consumer should re-read the
 * theme on each render via `readStoredTheme()`.
 */
function useThemeSync() {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event) => {
      if (event.key !== 'pulse-theme') return;
      setTick((t) => t + 1);
    };
    const onMessage = (event) => {
      // Defensive: the shell never acts on theme messages from
      // iframes, but the listener makes echoes visible in devtools and
      // keeps multi-tab behaviour consistent.
      if (event?.data?.type === THEME_MESSAGE) setTick((t) => t + 1);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
    };
  }, []);
}

// AC8: brand mark shown in place of the expand button when the sidebar is
// collapsed. Kept as a simple inline SVG so there's no external asset
// dependency. The "SI" monogram fits inside the 48 px collapsed rail.
function SILogo() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      width="24"
      height="24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="6" fill="currentColor" fillOpacity="0.15" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="14"
        fontWeight="700"
        fill="currentColor"
        letterSpacing="-0.5"
      >
        SI
      </text>
    </svg>
  );
}
export function Sidebar({ tabs, activeTabId, onToggleCollapsed, collapsed }) {
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const toggleGlyph = collapsed ? '▶' : '◀';

  // Keep the theme toggle in sync when the canonical key changes in
  // another browser tab (storage event) or an iframe echoes a theme
  // message (defensive — the shell is the source of truth).
  useThemeSync();

  return (
    <aside
      className={cx('pulse-sidebar', collapsed && 'pulse-sidebar--collapsed')}
      data-testid="pulse-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Pulse navigation"
    >
      <Button
        as="button"
        type="button"
        variant="ghost"
        size="md"
        className="pulse-sidebar__toggle"
        data-testid="pulse-sidebar-toggle"
        aria-label={toggleLabel}
        aria-pressed={collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? (
          /* AC8: collapsed state — show only the SI logo mark, no text */
          <SILogo />
        ) : (
          /* Expanded state — show chevron glyph + label */
          <>
            <span aria-hidden="true" className="pulse-sidebar__toggle-glyph">{toggleGlyph}</span>
            <span className="pulse-sidebar__toggle-label">
              {toggleLabel}
            </span>
          </>
        )}
      </Button>

      <nav
        className="pulse-sidebar__items"
        aria-label="Pulse tabs"
        data-testid="pulse-sidebar-items"
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          return (
            <Button
              key={t.id}
              as="a"
              href={t.path}
              variant="nav"
              active={isActive}
              className="pulse-sidebar__item"
              data-testid={`pulse-sidebar-tab-${t.id}`}
              aria-current={isActive ? 'page' : undefined}
              aria-label={t.label}
              onClick={(e) => handleTabClick(e, t.path)}
            >
              <span aria-hidden="true" className="pulse-sidebar__icon">
                {t.icon}
              </span>
              <span
                className={cx('pulse-sidebar__label', collapsed && 'pulse-sidebar--sr-only')}
              >
                {t.label}
              </span>
            </Button>
          );
        })}
      </nav>

      <div className="pulse-sidebar__divider" aria-hidden="true" />
      <ThemeToggle collapsed={collapsed} />
    </aside>
  );
}

/**
 * Stateful wrapper that owns the collapsed state, persists it to
 * localStorage, and renders <Sidebar> with the resolved values. Tests
 * render the inner <Sidebar> directly with explicit props so they don't
 * need a localStorage stub.
 */
export function StatefulSidebar({ tabs, activeTabId }) {
  // Lazy initializer reads localStorage on mount so SSR / private-mode
  // quirks fall back to the default expanded view without leaking a
  // window reference into the initial state.
  const [collapsed, setCollapsed] = useState(() => readStoredCollapsed());

  // Keep multiple tabs of Mission Control in sync if a user opens the
  // shell in two browser tabs and toggles in one.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event) => {
      if (event.key !== STORAGE_KEY) return;
      setCollapsed(event.newValue === 'true');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Re-render on cross-tab theme changes so the toggle's label
  // reflects the latest committed value. (useThemeSync is already
  // attached inside the bare <Sidebar> component, so the effect here
  // is intentionally a no-op for the theme key.)

  // Persist every toggle.
  useEffect(() => {
    writeStoredCollapsed(collapsed);
  }, [collapsed]);

  return (
    <Sidebar
      tabs={tabs}
      activeTabId={activeTabId}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((prev) => !prev)}
    />
  );
}

// Local classnames helper to avoid pulling in the design-system cx() —
// the sidebar lives inside Mission Control and the helper here is
// trivially correct for our two-class needs.
function cx(...values) {
  return values.filter(Boolean).join(' ');
}
