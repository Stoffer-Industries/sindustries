import React from 'react';

const TASKS_APP_HOSTS = {
  '5173': 'http://localhost:5173',
  '5174': 'http://localhost:5174',
  '5175': 'http://localhost:5175',
  '5176': 'http://localhost:5176',
  '5177': 'http://localhost:5177'
};

function tasksAppUrl() {
  const port = window.location.port;
  if (TASKS_APP_HOSTS[port]) return TASKS_APP_HOSTS[port];
  // Fallback: assume the running Tasks app is on the next port.
  return 'http://localhost:5173';
}

/**
 * TasksTab embeds the existing @sindustries/tasks-app by iframe so the
 * existing tasks functionality remains accessible inside Pulse without
 * a duplicate implementation. The Tasks app is the source of truth for
 * task editing; Pulse is the entry point.
 */
export function TasksTab() {
  const src = tasksAppUrl();
  return (
    <iframe
      title="Tasks"
      src={src}
      data-testid="pulse-tasks-iframe"
      aria-label="Tasks application"
    />
  );
}
