import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for AC1 (log a workout from mobile Safari) and AC2
 * (history view). Requires a live Supabase project (env vars wired into the
 * dev server) and a pre-seeded Tom account.
 */
test.describe('GymTrack — log a workout', () => {
  test('Tom can sign in, log a workout, and see it in history', async ({ page }) => {
    // AC5 — sign in
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByTestId('login-email').fill(process.env.GT_TEST_EMAIL ?? 'tom@example.com');
    await page.getByTestId('login-password').fill(process.env.GT_TEST_PASSWORD ?? 'password');
    await page.getByTestId('login-submit').click();

    // AC1 — land on /workout
    await expect(page).toHaveURL(/\/workout$/);
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();

    // Add two sets of Bench Press at 80 kg × 5 reps.
    await page.getByTestId('exercise-select').selectOption('Bench Press');
    await page.getByTestId('reps-input').fill('5');
    await page.getByTestId('weight-input').fill('80');
    await page.getByTestId('add-set').click();

    await page.getByTestId('reps-input').fill('5');
    await page.getByTestId('weight-input').fill('82.5');
    await page.getByTestId('add-set').click();

    // Save
    await page.getByTestId('save-workout').click();
    await expect(page.getByTestId('save-status')).toHaveText(/Workout saved/i);

    // AC2 — view in history
    await page.getByTestId('tab-history').click();
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByTestId('history-days').getByText(/Bench Press/).first()).toBeVisible();
  });
});