import { expect, test } from '@playwright/test';
import { dashboardReady, openView } from '../pages.ts';

/**
 * The harness itself: a built SPA, served by the real server, over a seeded
 * database, already logged in. If this fails nothing else in the suite means
 * anything, so it asserts the three things that make the rest possible.
 */
test('serves the built app, authenticated, with the seeded data behind it', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });

  // Authenticated: the login form is what an unclaimed session would show.
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Log in' })).toHaveCount(0);

  // The seed is behind it: the site directory came from the database, not a stub.
  // By accessible name, not by class — the dashboard picker wears the same one.
  await expect(page.getByLabel('Scope').locator('option')).toHaveCount(7); // 6 sites + All
  await dashboardReady(page);
});
