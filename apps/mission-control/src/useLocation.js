import { useEffect, useState } from 'react';

/**
 * Custom event fired by `navigate()` after a programmatic pushState.
 * Listeners that want to react to programmatic navigation should subscribe to
 * this event instead of `'popstate'`, so real browser back/forward gestures
 * and programmatic navigation are not conflated.
 */
export const PULSE_NAVIGATE_EVENT = 'pulse:navigate';

/**
 * Minimal history-based location hook for Pulse.
 * Tracks window.location.pathname and reflects both browser back/forward
 * gestures (`popstate`) and programmatic navigation (the custom event).
 */
export function useLocation() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(PULSE_NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(PULSE_NAVIGATE_EVENT, sync);
    };
  }, []);

  return pathname;
}

export function navigate(path) {
  if (path === window.location.pathname) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(PULSE_NAVIGATE_EVENT));
}
