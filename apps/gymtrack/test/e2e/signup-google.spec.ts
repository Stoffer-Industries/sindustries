import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for the OAuth (Google) sign-up path (task 72d7cc3b, AC2).
 *
 * Gated on `process.env.SUPABASE_TEST_URL` — the OAuth redirect needs a
 * Supabase test project that has the Google provider enabled with a
 * configured OAuth client. Production projects don't expose this; the
 * dev/staging projects do. CI runs this only when the env var is set.
 *
 * Skipped (not failed) when the env var is missing so the default
 * local-run path stays clean.
 */

const RUN_OAUTH = Boolean(process.env.SUPABASE_TEST_URL);

test.describe('GymTrack — OAuth (Google) sign-up', () => {
  test.skip(!RUN_OAUTH, 'SUPABASE_TEST_URL not set — OAuth path skipped');

  test('AC2: "Continue with Google" button starts the OAuth redirect flow', async ({ page }) => {
    await page.goto('/signup');

    // Apple may or may not be enabled — only the Google button is asserted.
    const googleButton = page.getByTestId('signup-google');
    await expect(googleButton).toBeVisible();

    // Click Google. The page will navigate off-site to accounts.google.com
    // (Supabase path) or to the Clerk hosted account portal (Clerk path —
    // task bb09eaed Phase 3 cutover); we don't try to complete the
    // redirect end-to-end here (that would require a live OAuth client +
    // interactive consent in CI). The test verifies the wiring: the button
    // calls startOAuthRedirect and the URL it receives is one we recognise.
    //
    // URL pattern matchers:
    //   - accounts.google.com      → Supabase path's eventual consent screen
    //   - supabase.co/auth/v1/authorize → Supabase path's intermediate redirect
    //   - clerk.<instance>.com     → Clerk path's hosted account portal
    //                                 (instance host is per-deployment —
    //                                 the wildcard covers test + prod)
    const navigationPromise = page.waitForURL(
      /accounts\.google\.com|supabase\.co\/auth\/v1\/authorize|clerk\.[a-z0-9-]+\.com/i,
      {
        timeout: 10_000
      }
    ).catch(() => null);
    await googleButton.click();
    const matched = await navigationPromise;
    expect(
      matched,
      'Expected navigation to Google OAuth, Supabase authorize URL, or Clerk hosted account portal after clicking Continue with Google'
    ).not.toBeNull();
  });
});