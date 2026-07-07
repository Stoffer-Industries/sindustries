import React, { useEffect, useState } from 'react';
import { Button } from '@sindustries/ui/react';
import { navigate } from './useLocation.js';

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

export function Sidebar({ tabs, activeTabId, onToggleCollapsed, collapsed }) {
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const toggleGlyph = collapsed ? '▶' : '◀';

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
        <span aria-hidden="true" className="pulse-sidebar__toggle-glyph">{toggleGlyph}</span>
        <span className={cx('pulse-sidebar__toggle-label', collapsed && 'pulse-sidebar--sr-only')}>
          {toggleLabel}
        </span>
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
