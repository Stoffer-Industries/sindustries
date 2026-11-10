import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth.jsx';

/**
 * Grace period before a redirect that never lands is reported to the user.
 *
 * A provider that resolves successfully has *initiated* the redirect, but
 * nothing guarantees the browser leaves the page: the SDK can resolve
 * without navigating (blocked third-party cookies, a suppressed navigation,
 * a provider-side no-op). Without a bound, that state is exactly the silent
 * no-op reported in task 7e7826c5 — the click produces no redirect and no
 * message. Five seconds is far beyond a normal provider round trip, and the
 * message is worded as a suggestion rather than a failure claim, so a slow
 * link is not told the sign-in failed.
 */
export const OAUTH_REDIRECT_FALLBACK_MS = 5000;

function providerLabel(provider) {
  const name = String(provider ?? '').trim();
  if (!name) return 'the provider';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Human-readable provider name for UI copy ("Google", "Apple").
 */
export function oauthProviderLabel(provider) {
  return providerLabel(provider);
}

function thrownErrorMessage(provider) {
  return (
    `Something went wrong starting ${providerLabel(provider)} sign-in. ` +
    'Try again, or use email + password instead.'
  );
}

function fallbackErrorMessage(provider) {
  return (
    `Could not start ${providerLabel(provider)} sign-in. ` +
    'Try again, or use email + password instead.'
  );
}

/**
 * Shared OAuth click contract for the sign-in and sign-up pages.
 *
 * `useAuth().startOAuthRedirect` is provider-agnostic, but its failure modes
 * were not: a provider that *throws* (for example an unguarded
 * `sessionStorage` write on iOS Safari) produced an unhandled promise
 * rejection in the page click handlers, so the user saw no redirect and no
 * error. This hook is the single total error boundary for the click, so
 * `/login` and `/signup` behave identically by construction rather than by
 * convention (task 7e7826c5, AC2/AC3).
 *
 * The hook never rejects. Every outcome is one of:
 *   - `providerDisabled` — the provider is not configured; the page removes
 *     the button and shows the "not available" message.
 *   - `error` — the provider refused or threw; the page shows the message.
 *   - `redirecting` — the provider accepted the request and the browser is
 *     navigating. If the page has still not navigated after
 *     `OAUTH_REDIRECT_FALLBACK_MS`, the hook surfaces an actionable error
 *     so the outcome is never silent.
 */
export function useOAuthRedirect() {
  const { startOAuthRedirect } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [providerDisabled, setProviderDisabled] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [provider, setProvider] = useState(null);
  const fallbackTimerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, []);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const startOAuth = useCallback(
    async (provider, redirectPath = '/workout') => {
      clearFallbackTimer();
      setPending(true);
      setError(null);
      setProviderDisabled(false);
      setRedirecting(false);
      setProvider(provider ?? null);

      try {
        const result = await startOAuthRedirect(provider, redirectPath);
        const data = result?.data ?? null;
        const providerError = result?.error ?? null;
        const disabled = Boolean(result?.providerDisabled);

        if (disabled) {
          if (mountedRef.current) {
            setProviderDisabled(true);
            setPending(false);
          }
          return { data, error: providerError, providerDisabled: true, redirecting: false };
        }

        if (providerError) {
          if (mountedRef.current) {
            setError(providerError);
            setPending(false);
          }
          return { data, error: providerError, providerDisabled: false, redirecting: false };
        }

        if (mountedRef.current) {
          setRedirecting(true);
          setPending(false);
          fallbackTimerRef.current = setTimeout(() => {
            fallbackTimerRef.current = null;
            if (!mountedRef.current) return;
            setRedirecting(false);
            setError(new Error(fallbackErrorMessage(provider)));
          }, OAUTH_REDIRECT_FALLBACK_MS);
        }

        return { data, error: null, providerDisabled: false, redirecting: true };
      } catch (err) {
        // A provider that throws must never produce an unhandled rejection:
        // that is the silent no-op this hook exists to remove.
        const failure = new Error(thrownErrorMessage(provider));
        if (mountedRef.current) {
          setError(failure);
          setPending(false);
        }
        return { data: null, error: failure, providerDisabled: false, redirecting: false };
      }
    },
    [startOAuthRedirect, clearFallbackTimer]
  );

  return { startOAuth, pending, error, providerDisabled, redirecting, provider };
}
