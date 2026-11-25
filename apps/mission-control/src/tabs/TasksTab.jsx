import React from 'react';

export function tasksAppUrl(env = import.meta.env) {
  // Prefer the explicit build-time value. Deployed builds must fail closed:
  // a missing Vercel variable must never point staging at production or
  // compile a localhost iframe into a deployed Mission Control bundle.
  if (env.VITE_TASKS_APP_URL) return env.VITE_TASKS_APP_URL;
  if (env.PROD) {
    throw new Error('VITE_TASKS_APP_URL is required for production builds');
  }
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
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="clipboard-write"
      referrerPolicy="strict-origin-when-cross-origin"
      data-testid="pulse-tasks-iframe"
      aria-label="Tasks application"
    />
  );
}
