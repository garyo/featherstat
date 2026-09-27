import { expect, test } from '@playwright/test';
import { openView, stranger } from '../pages.ts';
import { claimAccount, disableUser, inviteUser, logIn } from './accounts.ts';

/**
 * Changing a password (routes/admin.ts `/api/admin/password`): the session
 * that changed it stays, every other one ends, and only the new password logs
 * in. A user's, not the admin's — the admin's change would end the one session
 * the whole suite shares. Self-cleaning: the user is disabled at the end.
 */

const EMAIL = 'e2e-password@example.com';
const OLD_PASSWORD = 'e2e-old-password';
const NEW_PASSWORD = 'e2e-new-password';

test('a password change signs out every other session', async ({ page, browser }) => {
  const { claimUrl } = await inviteUser(page, EMAIL);
  const here = await stranger(browser);
  await claimAccount(here, claimUrl, OLD_PASSWORD);

  const elsewhere = await stranger(browser);
  await elsewhere.goto('/');
  await logIn(elsewhere, EMAIL, OLD_PASSWORD);
  await expect(elsewhere.locator('header.top')).toBeVisible();

  // --- change it from the first session -------------------------------------
  await openView(here, { view: 'settings' });
  const form = here
    .locator('.card')
    .filter({ has: here.getByRole('heading', { name: 'Change password' }) });
  const current = form.getByLabel('Current password');
  const next = form.getByLabel(/^New password/);
  const repeat = form.getByLabel('Repeat new password');
  const change = form.getByRole('button', { name: 'Change password' });

  // A wrong current password is refused, and says which field was wrong.
  await current.fill('not-the-password');
  await next.fill(NEW_PASSWORD);
  await repeat.fill(NEW_PASSWORD);
  await change.click();
  await expect(form.getByRole('alert')).toContainText('current password is wrong');

  await current.fill(OLD_PASSWORD);
  await next.fill(NEW_PASSWORD);
  await repeat.fill(NEW_PASSWORD);
  await change.click();
  await expect(form.getByText('Password changed. Other sessions were logged out.')).toBeVisible();

  // --- the other session is gone; the old password no longer works ---------
  await elsewhere.reload();
  await expect(elsewhere.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await logIn(elsewhere, EMAIL, OLD_PASSWORD);
  await expect(elsewhere.getByRole('alert')).toContainText('Wrong email or password');
  await logIn(elsewhere, EMAIL, NEW_PASSWORD);
  await expect(elsewhere.locator('header.top')).toBeVisible();

  // …and the session that changed it is still signed in.
  await here.reload();
  await expect(here.locator('header.top')).toBeVisible();
  await expect(here.getByRole('heading', { name: 'Log in' })).toHaveCount(0);

  await here.context().close();
  await elsewhere.context().close();
  await disableUser(page, EMAIL);
});
