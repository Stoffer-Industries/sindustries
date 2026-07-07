import React from 'react';
import { PULSE_TABS, findTabByPath, getDefaultTab } from './pulseTabs.jsx';
import { useLocation, navigate } from './useLocation.js';
import { StatefulSidebar } from './Sidebar.jsx';

export function App() {
  const pathname = useLocation();
  const tab = findTabByPath(pathname);
  const ActiveComponent = tab.component;

  return (
    <div className="pulse-shell" data-testid="pulse-shell">
      <StatefulSidebar tabs={PULSE_TABS} activeTabId={tab.id} />

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
