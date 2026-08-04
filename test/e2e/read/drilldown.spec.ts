import { expect, test } from '@playwright/test';
import { card, dashboardReady, openView } from '../pages.ts';

/**
 * The drill: a breakdown row opens that entity's detail view. This is the flow
 * that shipped blank across a deploy — the view is code-split, so "the chunk
 * did not load" and "the data is empty" look identical from outside unless a
 * test asserts the content is actually there.
 */

test('a page row opens its detail view, and Back returns', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);

  const rows = card(page, /Top pages/).locator('.bar-row');
  const label = ((await rows.first().locator('.name').textContent()) ?? '').trim();
  expect(label).not.toBe('');
  await rows.first().click();

  // The URL is the state: the drill must be linkable, not just visible.
  await expect(page).toHaveURL(/view=detail/);
  await expect(page.getByRole('heading', { name: /Page detail/ })).toBeVisible();
  // The locked chip names the entity — the view says what it is about.
  await expect(page.locator('.fchip.locked')).toContainText(label);
  // And the grid actually painted, which a dead chunk would not have.
  await dashboardReady(page);

  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).not.toHaveURL(/view=detail/);
});

test('a detail URL loads cold, chunk and all', async ({ page }) => {
  await openView(page, {
    site: 2,
    range: '90d',
    view: 'detail',
    detail: 'ref_domain:bsky.app',
  });

  await expect(page.getByRole('heading', { name: /Referrer detail/ })).toBeVisible();
  await expect(page.locator('.fchip.locked')).toContainText('bsky.app');
  await dashboardReady(page);
});

test('an unparseable detail link opens the dashboard instead of nothing', async ({ page }) => {
  // `parseViewState` drops a detail view with no entity — a mangled link must
  // land somewhere, never on a blank page.
  await openView(page, { site: 2, view: 'detail', detail: 'not_a_dimension:x' });
  await expect(page.getByRole('heading', { name: /detail/ })).toHaveCount(0);
  await dashboardReady(page);
});
