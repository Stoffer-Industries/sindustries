import { describe, expect, it } from 'vitest';
import { tasksAppUrl } from './TasksTab.jsx';

describe('tasksAppUrl', () => {
  it('uses the configured Tasks URL when provided', () => {
    expect(tasksAppUrl({ VITE_TASKS_APP_URL: 'https://tasks.example.test', PROD: true }))
      .toBe('https://tasks.example.test');
  });

  it('fails closed when a deployed build is missing the build variable', () => {
    expect(() => tasksAppUrl({ PROD: true })).toThrow(
      'VITE_TASKS_APP_URL is required for production builds',
    );
  });

  it('keeps localhost as the local development default', () => {
    expect(tasksAppUrl({ PROD: false })).toBe('http://localhost:5173');
  });
});
