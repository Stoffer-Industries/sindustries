// Day/Night theme helpers for the Mission Control shell.
//
// Single source of truth: the shell owns the canonical localStorage key
// (`pulse-theme`). Iframe-based tabs follow along via the postMessage
// `pulse:theme` event broadcast in `Sidebar.jsx`. The helpers here are
// tiny and pure so they can be unit-tested without React.

export const THEME_STORAGE_KEY = 'pulse-theme';
export const THEME_MESSAGE = 'pulse:theme';
export const DEFAULT_THEME = 'dark';

/**
 * Read the stored theme from localStorage. Returns 'dark' | 'light' with
 * 'dark' as the default. Wrapped in try/catch so private-mode browsers
 * (where localStorage.setItem throws) don't break the boot path.
 *
 * @returns {'dark' | 'light'}
 */
export function readStoredTheme() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Persist a theme value to localStorage under the canonical key.
 * Accepts only 'dark' | 'light'; anything else is ignored.
 *
 * @param {'dark' | 'light'} theme
 */
export function writeStoredTheme(theme) {
  if (theme !== 'dark' && theme !== 'light') return;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable (private mode). The toggle still works
    // for the session because <html data-si-theme> is set in-memory.
  }
}

/**
 * Compute the next theme given the current one.
 *
 * @param {'dark' | 'light'} current
 * @returns {'dark' | 'light'}
 */
export function nextTheme(current) {
  return current === 'dark' ? 'light' : 'dark';
}
