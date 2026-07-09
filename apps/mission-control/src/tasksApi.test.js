import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tasksApiBaseUrl } from './tasksApi.js';

describe('tasksApiBaseUrl', () => {
  const originalPort = window.location.port;

  beforeEach(() => {
    delete import.meta.env.VITE_TASKS_API_BASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: { port: originalPort },
      configurable: true
    });
  });

  function setPort(port) {
    Object.defineProperty(window, 'location', {
      value: { port },
      configurable: true
    });
  }

  it('returns the build-time env override when set', () => {
    import.meta.env.VITE_TASKS_API_BASE_URL = 'https://api.example.com/api/v1';
    setPort('5173');
    expect(tasksApiBaseUrl()).toBe('https://api.example.com/api/v1');
  });

  it('returns the port-mapped URL for known dev ports', () => {
    setPort('5173');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4000/api/v1');
    setPort('5174');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4001/api/v1');
  });

  it('falls back to the tasks-api default port (4000) on unknown ports', () => {
    setPort('9999');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4000/api/v1');
  });
});
