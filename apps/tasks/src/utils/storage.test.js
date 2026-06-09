import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getStoredTheme, getStoredView, setStoredTheme, setStoredView } from '../utils/storage.js';

const VIEW_STORAGE_KEY = 'tasks-app-view';
const THEME_STORAGE_KEY = 'tasks-app-theme';

describe('storage', () => {
  let localStorageMock;

  beforeEach(() => {
    localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    };
    vi.stubGlobal('localStorage', localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getStoredView', () => {
    it('returns "board" when nothing stored', () => {
      localStorageMock.getItem.mockReturnValue(null);
      expect(getStoredView()).toBe('board');
    });

    it('returns "board" for invalid stored value', () => {
      localStorageMock.getItem.mockReturnValue('invalid');
      expect(getStoredView()).toBe('board');
    });

    it('returns "backlog" when stored', () => {
      localStorageMock.getItem.mockReturnValue('backlog');
      expect(getStoredView()).toBe('backlog');
    });

    it('returns stored "board" value', () => {
      localStorageMock.getItem.mockReturnValue('board');
      expect(getStoredView()).toBe('board');
    });

    it('handles localStorage error gracefully', () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(getStoredView()).toBe('board');
    });
  });

  describe('setStoredView', () => {
    it('stores "backlog" view', () => {
      setStoredView('backlog');
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        VIEW_STORAGE_KEY,
        'backlog'
      );
    });

    it('stores "board" view', () => {
      setStoredView('board');
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        VIEW_STORAGE_KEY,
        'board'
      );
    });

    it('handles localStorage error gracefully', () => {
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(() => setStoredView('board')).not.toThrow();
    });
  });

  describe('getStoredTheme', () => {
    it('returns "dark" when nothing stored', () => {
      localStorageMock.getItem.mockReturnValue(null);
      expect(getStoredTheme()).toBe('dark');
    });

    it('returns "dark" for invalid stored value', () => {
      localStorageMock.getItem.mockReturnValue('system');
      expect(getStoredTheme()).toBe('dark');
    });

    it('returns stored "light" value', () => {
      localStorageMock.getItem.mockReturnValue('light');
      expect(getStoredTheme()).toBe('light');
    });

    it('handles localStorage error gracefully', () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(getStoredTheme()).toBe('dark');
    });
  });

  describe('setStoredTheme', () => {
    it('stores theme preference', () => {
      setStoredTheme('light');
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        THEME_STORAGE_KEY,
        'light'
      );
    });

    it('handles localStorage error gracefully', () => {
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(() => setStoredTheme('dark')).not.toThrow();
    });
  });
});