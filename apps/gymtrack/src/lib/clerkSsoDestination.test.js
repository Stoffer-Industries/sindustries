import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearClerkSsoDestination,
  consumeClerkSsoDestination,
  rememberClerkSsoDestination
} from './clerkSsoDestination.js';

/**
 * `sessionStorage` access throws a `SecurityError` on iOS Safari when
 * cookies are blocked, and in some private-browsing states. That throw used
 * to escape `rememberClerkSsoDestination()` before the provider's own
 * `try` block, which made the Google sign-in button a silent no-op
 * (task 7e7826c5). These tests pin the never-throw contract.
 */
function breakStorage(method) {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  try {
    window.sessionStorage.clear();
  } catch {
    // storage may still be broken in the test that broke it
  }
  clearClerkSsoDestination();
});

describe('clerkSsoDestination', () => {
  it('remembers an internal destination and consumes it once', () => {
    rememberClerkSsoDestination('/history?tab=logs');
    expect(consumeClerkSsoDestination()).toBe('/history?tab=logs');
    expect(consumeClerkSsoDestination()).toBe('/workout');
  });

  it('rejects an off-site destination', () => {
    rememberClerkSsoDestination('https://evil.example/steal');
    expect(consumeClerkSsoDestination()).toBe('/workout');
  });

  it('does not throw when sessionStorage.setItem is unavailable', () => {
    breakStorage('setItem');
    expect(() => rememberClerkSsoDestination('/history')).not.toThrow();
  });

  it('falls back to the in-memory destination when storage is unavailable', () => {
    rememberClerkSsoDestination('/history');
    breakStorage('getItem');
    expect(consumeClerkSsoDestination()).toBe('/history');
  });

  it('does not throw when sessionStorage.getItem is unavailable and no memory value exists', () => {
    breakStorage('getItem');
    expect(() => consumeClerkSsoDestination()).not.toThrow();
    expect(consumeClerkSsoDestination()).toBe('/workout');
  });

  it('does not throw when sessionStorage.removeItem is unavailable', () => {
    breakStorage('removeItem');
    expect(() => clearClerkSsoDestination()).not.toThrow();
  });
});
