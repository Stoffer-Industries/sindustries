import React from 'react';
import { PULSE_TABS, findTabByPath, getDefaultTab } from './pulseTabs.js';
import { useLocation, navigate } from './useLocation.js';

export function App() {
  const pathname = useLocation();
  const tab = findTabByPath(pathname);
  const ActiveComponent = tab.component;

  function handleTabClick(e, path) {
    // Anchor button: let the browser update the URL via pushState; prevent
    // full page reload by calling navigate() and stopping the link.
    e.preventDefault();
    navigate(path);
  }

  return (
    <div className="pulse-shell" data-testid="pulse-shell">
      <nav className="pulse-tabbar" aria-label="Pulse tabs" data-testid="pulse-tabbar">
        {PULSE_TABS.map((t) => {
          const isActive = t.id === tab.id;
          return (
            <a
              key={t.id}
              href={t.path}
              className="pulse-tabbar__link"
              data-testid={`pulse-tab-${t.id}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={(e) => handleTabClick(e, t.path)}
            >
              {t.label}
            </a>
          );
        })}
      </nav>

      <main className="pulse-content" data-testid="pulse-content">
        <ActiveComponent />
      </main>
    </div>
  );
}

// Default initial path helper used by tests and on first load.
export function ensureDefaultPath() {
  if (window.location.pathname === '/' || window.location.pathname === '') {
    navigate(getDefaultTab().path);
    return getDefaultTab().path;
  }
  return window.location.pathname;
}
