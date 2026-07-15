import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount any React trees rendered during the test so the next test
// starts from a clean DOM. Matches the pattern used by
// apps/mission-control/test/setup.js.
afterEach(() => {
  cleanup();
});