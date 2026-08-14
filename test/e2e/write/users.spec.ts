import { expect, test } from '@playwright/test';
import { openView } from '../pages.ts';

/**
 * Multi-user (docs/04 § 5), end to end: the admin invites a user with one
 * site, the invite link claims an account, and the user's whole app is that
 * one site — the switcher, the settings sections, everything. Self-cleaning:
 * the user is disabled at the end, so the seeded database serves the next run.
 */

const USER_EMAIL = 'e2e-user@example.com';
const USER_PASSWORD = 'e2e-user-password';

test('an invited user sees and manages only their own site', async ({ page, browser }) => {
  // --- admin: invite a user owning exactly the first seeded site ------------
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  const usersCard = page.locator('.card').filter({ hasText: 'Invite user' });
  await usersCard.getByLabel('Email').fill(USER_EMAIL);
  await usersCard.locator('fieldset .check input[type=checkbox]').first().check();
  const ownedSite = (
    await usersCard.locator('fieldset .check').first().textContent()
  )?.trim() as string;
  await usersCard.getByRole('button', { name: 'Invite user' }).click();
  const claimUrl = (await usersCard.locator('.secret code').textContent())?.trim() as string;
  expect(claimUrl).toContain('/welcome/fsu_');

  // --- invitee: claim the account in a fresh, sessionless context -----------
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await userPage.goto(claimUrl);
  await userPage.getByLabel('Password', { exact: true }).fill(USER_PASSWORD);
  await userPage.getByLabel('Confirm password').fill(USER_PASSWORD);
  await userPage.getByRole('button', { name: 'Claim account' }).click();

  // The claim signs the user in and lands on the app.
  await expect(userPage.locator('header.top')).toBeVisible();

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
  await userPage.getByLabel('Email').fill(USER_EMAIL);
  await userPage.getByLabel('Password', { exact: true }).fill(USER_PASSWORD);
  await userPage.getByRole('button', { name: 'Log in' }).click();
  await expect(userPage.locator('header.top')).toBeVisible();
  await userContext.close();

  // --- cleanup: disable the user; the row leaves the active list ------------
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  const row = page.locator('.prow').filter({ hasText: USER_EMAIL });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(page.locator('.prow').filter({ hasText: USER_EMAIL })).toHaveCount(0);
});
