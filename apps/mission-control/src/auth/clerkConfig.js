export function clerkConfig(env = import.meta.env) {
  const publishableKey = env.VITE_CLERK_PUBLISHABLE_KEY;
  const domain = env.VITE_CLERK_SATELLITE_DOMAIN;
  const signInUrl = env.VITE_CLERK_SIGN_IN_URL;
  if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');
  if (!domain) throw new Error('VITE_CLERK_SATELLITE_DOMAIN is required');
  if (!signInUrl) throw new Error('VITE_CLERK_SIGN_IN_URL is required');
  return {
    publishableKey,
    domain,
    signInUrl,
    isSatellite: true,
    satelliteAutoSync: true,
    afterSignOutUrl: window.location.origin
  };
}
