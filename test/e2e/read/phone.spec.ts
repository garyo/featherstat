import { expect, type Page, test } from '@playwright/test';
import { dashboardReady, openView, type ViewState } from '../pages.ts';

/**
 * No screen may scroll sideways on a phone. One element that refuses to shrink
 * (it was the live feed's single-line row, nine items wide) drags the whole
 * page off the side, and nothing type-checks a layout — so this opens every
 * view at phone width and measures.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const { scroll, client } = await page
    .locator('html')
    .evaluate((root) => ({ scroll: root.scrollWidth, client: root.clientWidth }));
  expect(scroll, `${where} is wider than the phone`).toBeLessThanOrEqual(client);
}

test('no view scrolls sideways on a phone', async ({ page }) => {
  const views: readonly (readonly [string, ViewState])[] = [
    ['all sites', { site: 'all', range: '90d' }],
    ['a site dashboard', { site: 2, range: '90d' }],
    ['journeys', { site: 2, range: '90d', view: 'journeys' }],
    ['realtime', { site: 2, view: 'realtime' }],
    ['a detail view', { site: 2, range: '90d', view: 'detail', detail: 'path:/' }],
    ['settings', { view: 'settings' }],
  ];
  for (const [where, state] of views) {
    await openView(page, state);
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await expectNoSidewaysScroll(page, where);
  }
});

test('the all-sites feed fits a phone, site ahead of page', async ({ page }) => {
  await openView(page, { site: 'all', range: '90d' });
  await dashboardReady(page);
  const row = page.locator('.feed-row').first();
  await expect(row).toBeVisible();
  // Stacked: what happened (site › page) sits above who did it.
  const what = await row.locator('.what').boundingBox();
  const who = await row.locator('.who').boundingBox();
  expect(what && who && who.y >= what.y + what.height - 1).toBe(true);
  await expect(row.locator('.what .fsite')).toBeVisible();
  await expectNoSidewaysScroll(page, 'the all-sites feed');
});
