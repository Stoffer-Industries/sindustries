import React from 'react';

export function tasksAppUrl(env = import.meta.env) {
  // Prefer the explicit build-time value. Production must never fall back to
  // localhost: a missing Vercel variable would otherwise compile a broken
  // iframe into the deployed Mission Control bundle.
  if (env.VITE_TASKS_APP_URL) return env.VITE_TASKS_APP_URL;
  if (env.PROD) return 'https://tasks.sindustries.co.nz';
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
      allow="clipboard-write"
      data-testid="pulse-tasks-iframe"
      aria-label="Tasks application"
    />
  );
}
