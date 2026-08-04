import { expect, test } from '@playwright/test';
import { card, dashboardReady, openView } from '../pages.ts';

/**
 * The four top-level views render over real data. Shallow on purpose — each
 * asserts the thing that would be missing if the view were broken, not every
 * number on it, because a spec that restates the seed breaks whenever the seed
 * grows a row.
 */

test('all-sites shows a card per site with real numbers', async ({ page }) => {
  await openView(page, { site: 'all', range: '90d' });
  await dashboardReady(page);

  const cards = page.locator('.site-card');
  await expect(cards).toHaveCount(6);
  for (const name of ['pcons.org', 'oberbrunner.com', 'deep-timeline.org']) {
    await expect(cards.filter({ hasText: name })).toHaveCount(1);
  }
  // A card with no number is the failure this catches — a rendered zero reads
  // the same as a rendered nothing until you look for a digit.
  await expect(cards.first()).toContainText(/\d/);
});

test('a site dashboard carries its KPI row and the built-in library', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);

  for (const kpi of ['Visitors', 'Pageviews']) {
    await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
  }
  const library = page.getByLabel('Dashboard');
  await expect(library.locator('option')).toContainText([
    'Site overview (built-in)',
    'Content (built-in)',
    'Acquisition (built-in)',
    'Campaigns (built-in)',
  ]);
});

test('the acquisition dashboard breaks traffic down by channel', async ({ page }) => {
  await openView(page, { site: 4, range: '90d', dash: 't:acquisition' });
  await dashboardReady(page);

  const channels = card(page, /Channels/);
  await expect(channels).toBeVisible();
  // `search` is a `ref_type`, so this proves the dimension reached the widget.
  await expect(channels).toContainText(/search|direct|social/);
});

test('journeys draws its sankey and its table', async ({ page }) => {
  await openView(page, { site: 2, range: '90d', view: 'journeys' });
  await expect(page.locator('svg').first()).toBeVisible();
  await expect(page.getByText(/sessions/i).first()).toBeVisible();
});

/**
 * Deliberately shallow: this asserts the page mounts and the stream is live,
 * NOT that a hit arrives. Waiting for real traffic would make it the flakiest
 * spec here and it would fail for reasons that are not defects.
 */
test('realtime mounts and the stream connects', async ({ page }) => {
  await openView(page, { site: 2, view: 'realtime' });
  await expect(page.getByRole('button', { name: 'Realtime' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The header says so whenever the SSE stream is down; it must not say so.
  await expect(page.getByText('Live updates reconnecting…')).toHaveCount(0);
});
