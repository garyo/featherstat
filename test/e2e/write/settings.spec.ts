import { expect, test } from '@playwright/test';
import { openView } from '../pages.ts';

/**
 * Settings, which writes. Serial and self-cleaning, like the editor specs.
 */

const SEGMENT_NAME = 'E2E blog readers';

test('the UTM builder says what it is waiting for, then builds the link', async ({ page }) => {
  // It used to render nothing at all until domain, campaign and source were
  // present — no box, no prompt, so it read as a feature that did not work.
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Campaigns', exact: true }).click();

  const url = page.locator('.utm-url');
  await expect(url).toContainText('Add the domain, campaign and source');

  await page.getByLabel('Domain', { exact: true }).fill('blog.example.com');
  await expect(url).toContainText('Add the campaign and source');
  await page.getByLabel('Campaign', { exact: true }).fill('launch');
  await expect(url).toContainText('Add the source');
  await page.getByLabel('Path', { exact: true }).fill('/post');
  await page.getByLabel('Source', { exact: true }).fill('bluesky');

  await expect(url).toHaveText(
    'https://blog.example.com/post?utm_campaign=launch&utm_source=bluesky',
  );
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeEnabled();
});

test('a segment saved from the filter editor becomes usable on a dashboard', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await page.getByRole('button', { name: '+ Filter' }).click();

  const dialog = page.locator('[role=dialog]');
  await dialog.getByRole('button', { name: '+ condition' }).click();
  const row = dialog.locator('.cond-row').first();
  await row.getByLabel('Dimension').fill('path');
  await row.getByLabel('Operator').selectOption('contains');
  await row.getByLabel('Value').fill('/blog');

  await dialog.getByLabel('Segment name').fill(SEGMENT_NAME);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0); // no refusal
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Reopening offers it as a condition, which is the point of saving one.
  await page.reload();
  await page.getByRole('button', { name: '+ Filter' }).click();
  await expect(
    page.locator('[role=dialog]').getByRole('button', { name: '+ saved segment' }),
  ).toBeVisible();

  // Clean up through Settings, where segments are managed.
  await openView(page, { view: 'settings' });
  await page.getByRole('button', { name: 'Query objects', exact: true }).click();
  const seg = page.locator('.prow').filter({ hasText: SEGMENT_NAME });
  await expect(seg).toHaveCount(1);
  await seg.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.prow').filter({ hasText: SEGMENT_NAME })).toHaveCount(0);
});
