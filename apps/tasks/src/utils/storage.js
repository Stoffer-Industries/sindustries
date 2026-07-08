const VIEW_STORAGE_KEY = 'tasks-app-view';
const THEME_STORAGE_KEY = 'tasks-app-theme';
const PULSE_THEME_STORAGE_KEY = 'pulse-theme';
const DEFAULT_THEME = 'dark';

/**
 * Get stored view preference from localStorage
 * @returns {'backlog' | 'board'}
 */
export function getStoredView() {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'backlog' || stored === 'board') return stored;
  } catch {}
  return 'board';
}

/**
 * Save view preference to localStorage
 * @param {'backlog' | 'board'} view
 */
export function setStoredView(view) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Read the legacy tasks-app-local theme value (key: `tasks-app-theme`).
 * Kept so the boot path can perform a one-time migration to the new
 * canonical `pulse-theme` key without throwing away the user's prior
 * preference.
 *
 * @returns {'dark' | 'light'}
 */
export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {}
  return DEFAULT_THEME;
}

/**
 * Persist the legacy tasks-app-local theme value. Still exported so
 * the boot path can write through the legacy key during the one-time
 * migration in `main.jsx`.
 *
 * @param {'dark' | 'light'} theme
 */
export function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Read the canonical pulse-theme value (key: `pulse-theme`). Returns
 * `null` when nothing is stored so the caller can fall back to the
 * legacy `tasks-app-theme` key (one-time migration) and then to the
 * default.
 *
 * @returns {'dark' | 'light' | null}
 */
export function getStoredPulseTheme() {
  try {
    const stored = localStorage.getItem(PULSE_THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the canonical pulse-theme value. Accepts only 'dark' |
 * 'light'; anything else is ignored (matches the legacy contract).
 *
 * @param {'dark' | 'light'} theme
 */
export function setStoredPulseTheme(theme) {
  if (theme !== 'dark' && theme !== 'light') return;
  try {
    localStorage.setItem(PULSE_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}
