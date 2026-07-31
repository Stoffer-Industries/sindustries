import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for task `2306125e` (GymTrack Workouts Tab with "Connect
 * to Your Agent" CTA) — WS1 covering AC1, AC2, AC5.
 *
 * Requires:
 * - Live Supabase project (env vars wired into the dev server).
 * - Pre-seeded Tom account (same email/password pair as `log-workout.spec.ts`).
 * - At least two pending planned workouts for Tom: one scheduled for today,
 *   and at least one scheduled for a later date. Cards display in the order
 *   Supabase returns them (soonest-first); today's card carries the "Today"
 *   badge and overdue cards (if any) carry "Overdue".
 */
test.describe('GymTrack — browse planned workouts (task 2306125e WS1)', () => {
  test('lists pending workouts, badges today/overdue, and taps into the log screen with the date pre-selected', async ({
    page
  }) => {
    // AC5 — sign in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByTestId('login-email').fill(process.env.GT_TEST_EMAIL ?? 'tom@example.com');
    await page.getByTestId('login-password').fill(process.env.GT_TEST_PASSWORD ?? 'password');
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/\/workout$/);

    // AC1 — Workouts tab reachable from the app's main nav.
    await page.getByTestId('tab-workouts').click();
    await expect(page).toHaveURL(/\/workouts$/);
    await expect(page.getByTestId('workouts-tab')).toBeVisible();

    // Cards rendered (seed data dependent). At least one card with a "Today"
    // badge is expected because the seed includes a workout scheduled for today.
    const cards = page.getByTestId(/^workout-card-(?!.*badge)/);
    await expect(cards.first()).toBeVisible();

    // AC2 — at least one today badge; optionally an overdue badge if the seed
    // includes a past pending workout.
    const todayBadge = page.locator('[data-testid$="-badge"]', { hasText: 'Today' });
    await expect(todayBadge.first()).toBeVisible();

    // AC5 — tap the first card and land on /workout?date=YYYY-MM-DD with the
    // log screen rendered for that date.
    const firstCard = cards.first();
    const href = await firstCard.getAttribute('href');
    expect(href).toMatch(/\/workout\?date=\d{4}-\d{2}-\d{2}/);

    await firstCard.click();
    await expect(page).toHaveURL(/\/workout\?date=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId('date-input')).toBeVisible();
  });
});
