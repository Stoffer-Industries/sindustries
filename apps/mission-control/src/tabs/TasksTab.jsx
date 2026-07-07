import React from 'react';

function tasksAppUrl() {
  // Prefer build-time env var (set by Tiltfile / CI). Falls back to the
  // dev default where tasks-app runs on 5173 and mission-control on 5174.
  return import.meta.env.VITE_TASKS_APP_URL ?? 'http://localhost:5173';
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
