// Pulse tab registry.
//
// Each tab describes how to render a slice of the Pulse shell. The shell
// matches the active URL path to a tab's `path` and renders its `component`.
// Adding a new tab requires:
//   1. creating a new component (e.g. tabs/MyTab.jsx)
//   2. adding an entry below with `id`, `label`, `path`, `icon`, and `component`
// No shell changes needed.
//
// Icons are inline SVGs and are marked `aria-hidden="true"` by the shell so
// they are decorative — the tab's accessible name is its `label`. This
// avoids a runtime icon font dependency and keeps the iconography surface
// owned by the shell until the Design System grows an icon primitive.

import React from 'react';
import { FlowMetricsTab } from './tabs/FlowMetricsTab.jsx';
import { TasksTab } from './tabs/TasksTab.jsx';
import { BookmarksTab } from './tabs/BookmarksTab.jsx';

function IconClipboard() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4h6v3H9z" fill="currentColor" stroke="none" />
      <path d="M9 11h6M9 15h6M9 19h4" strokeLinecap="round" />
    </svg>
  );
}

function IconBookmark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M7 4h10v17l-5-3-5 3z" />
      <path d="M11 8h2" strokeLinecap="round" />
    </svg>
  );
}

function IconBarChart() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M5 20V4M5 20h14" strokeLinecap="round" />
      <rect x="8" y="11" width="3" height="7" />
      <rect x="13" y="7" width="3" height="11" />
    </svg>
  );
}

export const PULSE_TABS = [
  {
    id: 'tasks',
    label: 'Tasks',
    path: '/tasks',
    icon: <IconClipboard />,
    component: TasksTab
  },
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    path: '/bookmarks',
    icon: <IconBookmark />,
    component: BookmarksTab
  },
  {
    id: 'flow-metrics',
    label: 'Flow metrics',
    path: '/flow-metrics',
    icon: <IconBarChart />,
    component: FlowMetricsTab
  }
];

export function getDefaultTab() {
  return PULSE_TABS[0];
}

export function findTabByPath(pathname) {
  // Strip trailing slash and any hash/query; match against tab.path.
  const cleaned = (pathname || '/').replace(/\/+$/, '') || '/';
  return (
    PULSE_TABS.find((t) => t.path === cleaned) ?? getDefaultTab()
  );
}

export function findTabById(id) {
  return PULSE_TABS.find((t) => t.id === id) ?? null;
}
