import { describe, expect, it } from 'vitest';
import { tasksAppUrl } from './TasksTab.jsx';

describe('tasksAppUrl', () => {
  it('uses the configured Tasks URL when provided', () => {
    expect(tasksAppUrl({ VITE_TASKS_APP_URL: 'https://tasks.example.test', PROD: true }))
      .toBe('https://tasks.example.test');
  });

  it('uses the production Tasks hostname when the build variable is missing', () => {
    expect(tasksAppUrl({ PROD: true })).toBe('https://tasks.sindustries.co.nz');
  });

  it('keeps localhost as the local development default', () => {
    expect(tasksAppUrl({ PROD: false })).toBe('http://localhost:5173');
  });
});
