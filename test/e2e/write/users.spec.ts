import { expect, test } from '@playwright/test';
import { stranger } from '../pages.ts';
import { claimAccount, disableUser, inviteUser, logIn } from './accounts.ts';

/**
 * Multi-user (docs/04 § 5), end to end: the admin invites a user with one
 * site, the invite link claims an account, and the user's whole app is that
 * one site — the switcher, the settings sections, everything. Self-cleaning:
 * the user is disabled at the end, so the seeded database serves the next run.
 */

const USER_EMAIL = 'e2e-user@example.com';
const USER_PASSWORD = 'e2e-user-password';

test('an invited user sees and manages only their own site', async ({ page, browser }) => {
  const { claimUrl, site: ownedSite } = await inviteUser(page, USER_EMAIL);

  // The claim signs the user in and lands on the app.
  const userPage = await stranger(browser);
  await claimAccount(userPage, claimUrl, USER_PASSWORD);

  // The switcher offers "All sites" plus exactly the one owned site.
  const options = userPage.locator('header .site-switch').first().locator('option');
  await expect(options).toHaveText(['All sites', ownedSite]);

  // Settings shows the per-site sections and none of the admin-only ones.
  await userPage.getByRole('button', { name: 'Settings' }).click();
  const nav = userPage.getByLabel('Settings sections');
  await expect(nav.getByRole('button', { name: 'Sites & tracking' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'Data', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'Notifications' })).toHaveCount(0);

  // The sites card lists only the owned site.
  await expect(userPage.locator('.site-row')).toHaveCount(1);
  await expect(userPage.locator('.site-row')).toContainText(ownedSite);

  // And logging back in works with email + password.
  await userPage.getByRole('button', { name: 'Log out' }).click();
  await logIn(userPage, USER_EMAIL, USER_PASSWORD);
  await expect(userPage.locator('header.top')).toBeVisible();
  await userPage.context().close();

  await disableUser(page, USER_EMAIL);
});
