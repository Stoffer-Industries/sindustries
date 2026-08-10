import { useEffect, useState } from 'react';
import { fetchAuthSession } from '../tasksApi.ts';

/**
 * Resolve the current browser session for ownership-based UI surfaces.
 *
 * Returns:
 *   { status: 'loading' | 'authenticated' | 'anonymous', actor: string | null }
 *
 * `actor` is the display name from the auth session (e.g. "Quinn", "Tom"),
 * which is the natural value to feed into the workflowGateOwner /
 * attentionOwner discovery filters. The hook intentionally surfaces `actor`
 * rather than the raw `username` so the chip labels and API filter values
 * stay consistent with the assignee registry.
 *
 * Anonymous sessions resolve quickly and silently — callers should treat
 * `actor === null` as "signed out, hide ownership-based affordances".
 */
export function useCurrentUser() {
  const [status, setStatus] = useState('loading');
  const [actor, setActor] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((currentActor) => {
        if (cancelled) return;
        const resolved = currentActor?.displayName || currentActor?.actor || null;
        setActor(resolved ? String(resolved) : null);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setActor(null);
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, actor };
}