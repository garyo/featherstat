import { expect, test } from '@playwright/test';
import { card, dashboardReady, openView } from '../pages.ts';

/**
 * Manage dashboards (docs/05 § The dashboard library): Reset and Delete both
 * destroy a layout, so both take a second click. Self-cleaning — the delete
 * under test removes the one row the spec creates.
 */

const REMOVED = 'Scroll depth';

test('a customized dashboard resets to its built-in, then deletes', async ({ page }) => {
  // A stored row with a template behind it: customize a built-in and save.
  await openView(page, { site: 2, range: '90d', dash: 't:content' });
  await dashboardReady(page);
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.locator('.ew').filter({ hasText: REMOVED }).getByTitle('Remove widget').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTitle('Edit dashboard')).toBeVisible();
  await expect(card(page, REMOVED)).toHaveCount(0);

  await page.getByLabel('Dashboard').selectOption({ label: 'Manage dashboards…' });
  const manage = page.locator('dialog');
  const row = manage.locator('.mrow').filter({ hasText: 'from content' });
  await expect(row).toHaveCount(1);

  // --- reset: the first click only asks --------------------------------------
  const reset = row.getByRole('button', { name: /^Reset|Really reset/ });
  await reset.click();
  await expect(reset).toHaveText('Really reset to the built-in layout?');
  await expect(card(page, REMOVED)).toHaveCount(0);
  await reset.click();
  // The row survives a reset; its layout is the built-in's again.
  await expect(reset).toHaveText('Reset');
  await expect(card(page, REMOVED)).toBeVisible();

  // --- delete: likewise, and the row is gone --------------------------------
  const remove = row.getByRole('button', { name: /^Delete|Really delete/ });
  await remove.click();
  await expect(remove).toHaveText(/^Really delete/);
  await expect(row).toHaveCount(1);
  await remove.click();
  await expect(row).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Deleting the dashboard on screen moves the view off it, to the built-in.
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible();
});
