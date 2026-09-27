import { expect, type Page, test } from '@playwright/test';
import { dashboardReady, NONSENSE, openView, visibleText } from '../pages.ts';

/**
 * Nothing on screen may read `[object Object]`, `undefined`, `NaN` or `null`.
 *
 * This exists because the Add-widget breakdown picker shipped offering
 * "[object Object]" twice — it iterated a zod UNION's `.options`, which are its
 * two member schemas rather than the 26 dimension names. `bun run ci` was green
 * for the whole life of that bug: nothing type-checks how a template
 * stringifies a value.
 *
 * One spec for a whole class of failure, over every screen and every panel that
 * opens. It cannot know what SHOULD be there — that is the other specs' job —
 * but it knows what can never be right anywhere.
 */

async function clean(page: Page, where: string): Promise<void> {
  const text = await visibleText(page);
  const bad = text.split('\n').filter((line) => NONSENSE.test(line));
  expect(bad, `${where} shows text no screen should ever show`).toEqual([]);
}

test('no screen renders a stringified nothing', async ({ page }) => {
  for (const [where, state] of [
    ['all sites', { site: 'all' as const, range: '90d' }],
    ['a site dashboard', { site: 2, range: '90d' }],
    ['content', { site: 2, range: '90d', dash: 't:content' }],
    ['acquisition', { site: 4, range: '90d', dash: 't:acquisition' }],
    ['campaigns', { site: 2, range: '90d', dash: 't:campaigns' }],
    ['journeys', { site: 2, range: '90d', view: 'journeys' as const }],
    ['realtime', { site: 2, view: 'realtime' as const }],
    ['a detail view', { site: 2, range: '90d', view: 'detail' as const, detail: 'path:/' }],
    ['a filtered dashboard', { site: 2, range: '90d', filters: ['country:neq:SG'] }],
  ] as const) {
    await openView(page, state);
    await clean(page, where);
  }
});

test('no panel that opens renders one either', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);

  await page.getByRole('button', { name: '+ Filter' }).click();
  const dialog = page.locator('dialog');
  await clean(page, 'the filter editor, empty');

  // Text mode first: an unfinished condition disables it on purpose, so this
  // order is the app's rule rather than a workaround for it.
  await dialog.getByRole('button', { name: 'Edit as text' }).click();
  await page.locator('dialog .vocab summary').click();
  await clean(page, 'the filter editor, text mode');

  await dialog.getByRole('button', { name: 'Edit as conditions' }).click();
  await dialog.getByRole('button', { name: '+ condition' }).click();
  const row = dialog.locator('.cond-row').first();
  await row.getByLabel('Dimension').fill('country');
  await row.getByLabel('Value').fill('SG');
  await clean(page, 'the filter editor, one condition');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The editor: Add-widget is where this class of bug actually shipped.
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('button', { name: 'Add widget' }).click();
  await clean(page, 'add widget');
  await page.locator('dialog').getByRole('button', { name: 'Close' }).click();
});

test('no settings panel renders one', async ({ page }) => {
  await openView(page, { view: 'settings' });
  for (const tab of ['Sites & tracking', 'Access', 'Query objects', 'Campaigns', 'Data']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await clean(page, `settings › ${tab}`);
  }
});
