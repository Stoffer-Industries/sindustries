/**
 * Clerk configuration helpers — single source of truth for the publishable
 * key, JWT template name, and provider-flag resolution that main.jsx and
 * ClerkAuthProvider share.
 *
 * Reads VITE_CLERK_PUBLISHABLE_KEY + VITE_AUTH_PROVIDER from Vite's
 * import.meta.env (these are the PUBLIC-by-design values Vite inlines into
 * the JS bundle at build time).
 *
 * The Clerk secret key is intentionally NOT exposed to the browser bundle.
 * It lives only on the server side (env/.env.local for `fly secrets set`
 * on the deploy side, and tasks-api's pre-merge contract tests). The MCP
 * service uses the secret key for any future Clerk-issued token
 * introspection that needs server-side verification, but the SPA never
 * touches it.
 */

const PUBLISHABLE_KEY_ENV = 'VITE_CLERK_PUBLISHABLE_KEY';
const PROVIDER_ENV = 'VITE_AUTH_PROVIDER';
const VALID_PROVIDERS = new Set(['supabase', 'clerk']);

/**
 * Resolve the active provider flag. Defaults to 'supabase' so existing
 * deployments keep working without an env-var flip. Quinn flips this to
 * 'clerk' in Vercel once Clerk keys are provisioned and verified.
 *
 * Treats the env var as unset when it is the empty string or whitespace,
 * so a stubEnv value of '' falls back to the 'supabase' default instead
 * of throwing on a deliberate "blank" config (e.g. a `.env.local` that
 * left the line in but did not fill it in).
 */
export function getActiveProvider() {
  const raw = (import.meta.env[PROVIDER_ENV] ?? '').trim().toLowerCase();
  if (!raw) return 'supabase';
  if (!VALID_PROVIDERS.has(raw)) {
    throw new Error(
      `GymTrack: invalid ${PROVIDER_ENV}=${raw}. Expected one of ${[...VALID_PROVIDERS].join(', ')}.`
    );
  }
  return raw;
}

/**
 * Return the Clerk publishable key. Throws if the key is missing AND the
 * active provider is Clerk, so a misconfigured production deploy surfaces
 * at app start rather than during the first auth attempt.
 *
 * Returns the empty string when the provider is Supabase so main.jsx can
 * pass the value to ClerkProvider unconditionally without branching on
 * the flag at every render — ClerkProvider accepts an empty publishable
 * key only when it is not actually mounted (which the dispatcher in
 * main.jsx guarantees).
 */
export function getClerkPublishableKey() {
  const provider = getActiveProvider();
  const key = (import.meta.env[PUBLISHABLE_KEY_ENV] ?? '').trim();

  if (provider === 'clerk' && !key) {
    throw new Error(
      `GymTrack: VITE_AUTH_PROVIDER=clerk but ${PUBLISHABLE_KEY_ENV} is not set. ` +
        'See apps/gymtrack/.env.example and ask Quinn to wire the value into Vercel for live deploys.'
    );
  }

  return key;
}

/**
 * Return the JWT template name configured in the Clerk dashboard for
 * Supabase Third-Party Auth. Defaults to 'supabase' which is the
 * convention documented at
 * https://clerk.com/docs/integrations/databases/supabase — Quinn should
 * create a JWT template named 'supabase' in the Clerk dashboard that
 * maps the Clerk session claims to Supabase's expected `sub` / `role`
 * shape.
 *
 * Surfaced as a constant (not an env var) because the template name is
 * a Clerk dashboard configuration, not a deploy-time value. Override here
 * only if Quinn adopts a different template name.
 */
export const SUPABASE_JWT_TEMPLATE = 'supabase';
