import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TasksTab, tasksAppUrl } from './TasksTab.jsx';

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

describe('TasksTab', () => {
  it('uses the least-privilege iframe contract', () => {
    render(<TasksTab />);
    const frame = screen.getByTitle('Tasks');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    expect(frame).toHaveAttribute('allow', 'clipboard-write');
    expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  });
});
