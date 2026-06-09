const VIEW_STORAGE_KEY = 'tasks-app-view';
const THEME_STORAGE_KEY = 'tasks-app-theme';

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
 * Get stored theme preference from localStorage
 * @returns {'dark' | 'light'}
 */
export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {}
  return 'dark';
}

/**
 * Save theme preference to localStorage
 * @param {'dark' | 'light'} theme
 */
export function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}
