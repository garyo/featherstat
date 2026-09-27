import { expect, test } from '@playwright/test';
import { openView, stranger } from '../pages.ts';

/**
 * Viewers (docs/04 § 5): a read-only principal claimed through a single-use
 * magic link. Opening the link spends nothing — a chat app unfurling it must
 * not burn it — so only the page's button claims. Self-cleaning: the viewer is
 * revoked at the end, which is also the last thing under test.
 */

const VIEWER_EMAIL = 'e2e-viewer@example.com';

test('a viewer link claims once, shows only the granted site, and dies on revoke', async ({
  page,
  browser,
}) => {
  // --- admin: invite a viewer who may read exactly the first seeded site ----
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  const viewers = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Viewers' }) });
  await viewers.getByLabel('Email').fill(VIEWER_EMAIL);
  await viewers.getByLabel('Only:').check();
  const first = viewers.locator('.check.indent').first();
  await first.locator('input[type=checkbox]').check();
  const granted = ((await first.textContent()) ?? '').trim();
  await viewers.getByRole('button', { name: 'Invite viewer' }).click();
  const inviteUrl = ((await viewers.locator('.secret code').textContent()) ?? '').trim();
  expect(inviteUrl).toContain('/invite/fsv_');

  // --- viewer: loading the page twice spends nothing -------------------------
  const viewer = await stranger(browser);
  await viewer.goto(inviteUrl);
  const open = viewer.getByRole('button', { name: 'Open the dashboards' });
  await expect(open).toBeVisible();
  await viewer.reload();
  await open.click();

  // The claim signs the viewer in, onto the one granted site and no settings.
  await expect(viewer.locator('header.top')).toBeVisible();
  await expect(viewer.getByLabel('Scope').locator('option')).toHaveText(['All sites', granted]);
  await expect(viewer.getByRole('button', { name: 'Settings' })).toHaveCount(0);

  // The link was single-use: a second claim is refused.
  const latecomer = await stranger(browser);
  await latecomer.goto(inviteUrl);
  await latecomer.getByRole('button', { name: 'Open the dashboards' }).click();
  await expect(latecomer.getByRole('alert')).toContainText('already used');
  await latecomer.context().close();

  // --- admin: revoke, and the viewer's session goes with it -----------------
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  const row = page.locator('.prow').filter({ hasText: VIEWER_EMAIL });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Revoke' }).click();
  await row.getByRole('button', { name: /^Really revoke/ }).click();
  await expect(page.locator('.prow').filter({ hasText: VIEWER_EMAIL })).toHaveCount(0);

  await viewer.reload();
  await expect(viewer.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await viewer.context().close();
});
