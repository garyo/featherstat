import { expect, type Page } from '@playwright/test';
import { openView } from '../pages.ts';

/**
 * The user-account round trip the write specs share: invite from Settings ›
 * Users, claim from the link, log in, and disable again to clean up.
 */

export interface Invited {
  /** The one-time `/welcome/fsu_…` link, exactly as the panel shows it. */
  claimUrl: string;
  /** The seeded site the user was given — the first one listed. */
  site: string;
}

/** Invites `email` as a user owning the first seeded site. */
export async function inviteUser(admin: Page, email: string): Promise<Invited> {
  await openView(admin, { view: 'settings' });
  await admin.getByRole('button', { name: 'Users', exact: true }).click();
  const users = admin.locator('.card').filter({ hasText: 'Invite user' });
  await users.getByLabel('Email').fill(email);
  const first = users.locator('fieldset .check').first();
  await first.locator('input[type=checkbox]').check();
  const site = ((await first.textContent()) ?? '').trim();
  await users.getByRole('button', { name: 'Invite user' }).click();
  const claimUrl = ((await users.locator('.secret code').textContent()) ?? '').trim();
  expect(claimUrl).toContain('/welcome/fsu_');
  return { claimUrl, site };
}

/** Claims an invite by choosing its password; the claim signs the page in. */
export async function claimAccount(page: Page, claimUrl: string, password: string): Promise<void> {
  await page.goto(claimUrl);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Claim account' }).click();
  await expect(page.locator('header.top')).toBeVisible();
}

/** Fills and submits the login form, wherever the page is showing it. */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Disables `email` — the row leaves the active list, and its sessions end. */
export async function disableUser(admin: Page, email: string): Promise<void> {
  await openView(admin, { view: 'settings' });
  await admin.getByRole('button', { name: 'Users', exact: true }).click();
  const row = admin.locator('.prow').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Disable' }).click();
  await row.getByRole('button', { name: /^Really disable/ }).click();
  await expect(admin.locator('.prow').filter({ hasText: email })).toHaveCount(0);
}
