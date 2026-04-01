import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

function createMemoryLocalStorage() {
  let store = new Map();
  return {
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
    key(index) {
      const keys = [...store.keys()];
      return keys[index] ?? null;
    },
    get length() {
      return store.size;
    }
  };
}

beforeEach(() => {
  const ls = globalThis?.window?.localStorage;
  if (!ls || typeof ls.clear !== 'function') {
    Object.defineProperty(window, 'localStorage', {
      value: createMemoryLocalStorage(),
      configurable: true
    });
  }
});

afterEach(() => {
  cleanup();
});
