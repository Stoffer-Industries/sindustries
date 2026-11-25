import { describe, expect, it } from 'vitest';

import { e2eSession } from './e2eSession.js';

describe('tasks e2e session seam', () => {
  it('stays disabled when the harness token is absent', () => {
    expect(e2eSession({ DEV: true })).toBeNull();
  });

  it('stays disabled in a production build even if a token leaks into the bundle', () => {
    expect(e2eSession({ DEV: false, VITE_TASKS_E2E_AUTH_TOKEN: 'leaked' })).toBeNull();
  });

  it('activates on a dev server that sets the harness token', () => {
    expect(e2eSession({ DEV: true, VITE_TASKS_E2E_AUTH_TOKEN: 'e2e' })).toEqual({ token: 'e2e' });
  });
});
