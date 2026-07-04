// Pulse tab registry.
//
// Each tab describes how to render a slice of the Pulse shell. The shell
// matches the active URL path to a tab's `path` and renders its `component`.
// Adding a new tab requires:
//   1. creating a new component (e.g. tabs/MyTab.jsx)
//   2. adding an entry below with `id`, `label`, `path`, and `component`
// No shell changes needed.

import { FlowMetricsTab } from './tabs/FlowMetricsTab.jsx';
import { TasksTab } from './tabs/TasksTab.jsx';
import { BookmarksTab } from './tabs/BookmarksTab.jsx';

export const PULSE_TABS = [
  {
    id: 'tasks',
    label: 'Tasks',
    path: '/tasks',
    component: TasksTab
  },
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    path: '/bookmarks',
    component: BookmarksTab
  },
  {
    id: 'flow-metrics',
    label: 'Flow metrics',
    path: '/flow-metrics',
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
