import { expect, test } from '@playwright/test';
import { answerConfirm, dashboardReady, expectNoNonsense, openView, stranger } from '../pages.ts';

/**
 * Share links (docs/04 § 5), end to end: the admin mints one, a reader with no
 * session opens it and sees real numbers, and revoking it kills it. Sharing a
 * built-in saves it as a row first, so the spec deletes that row at the end.
 */

test('a share link opens the dashboard without a login, until it is revoked', async ({
  page,
  browser,
}) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();

  const dialog = page.locator('dialog');
  await dialog.getByRole('button', { name: 'Create share link' }).click();
  const link = dialog.getByLabel('Share link');
  await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]{43}$/);
  const url = await link.inputValue();

  // The link is shown once, so closing before it was copied asks — and "no"
  // keeps it on screen.
  const close = dialog.getByRole('button', { name: 'Close' });
  expect(await answerConfirm(page, 'dismiss', () => close.click())).toContain(
    'cannot be shown again',
  );
  await expect(link).toHaveValue(url);
  await answerConfirm(page, 'accept', () => close.click());
  await expect(page.locator('dialog')).toHaveCount(0);

  // --- a reader with no session opens it ------------------------------------
  const reader = await stranger(browser);
  await reader.goto(url);
  await expect(reader.getByText('Shared dashboard · read-only')).toBeVisible();
  await dashboardReady(reader);
  await expect(reader.locator('.kpis .tile .value').first()).toHaveText(/\d/);
  // No session came with it, so none of the app's own controls did either.
  await expect(reader.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  await expectNoNonsense(reader, 'a shared dashboard');

  // --- revoke, and the same link fails cleanly -------------------------------
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const revoke = dialog.getByRole('button', { name: /Revoke all links|Really revoke/ });
  await revoke.click(); // arms
  await revoke.click(); // confirms
  await expect(dialog.getByText('1 link(s) revoked.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await reader.reload();
  await expect(reader.getByText('This share link is no longer valid')).toBeVisible();
  await expect(reader.locator('.kpis')).toHaveCount(0);
  await expectNoNonsense(reader, 'a revoked share link');
  await reader.context().close();

  // --- clean up the row the first share saved -------------------------------
  await page.reload();
  await page.getByLabel('Dashboard').selectOption({ label: 'Manage dashboards…' });
  const manage = page.locator('dialog');
  const remove = manage
    .locator('.mrow')
    .filter({ hasText: 'Delete' })
    .getByRole('button', { name: /Delete|Really/ });
  await remove.click(); // arms
  await remove.click(); // confirms
  await expect(manage.locator('.mrow').filter({ hasText: 'Delete' })).toHaveCount(0);
});
