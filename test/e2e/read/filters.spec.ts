import { expect, test } from '@playwright/test';
import { card, chips, dashboardReady, openView } from '../pages.ts';

/**
 * Filters, where most of this file's reason for existing came from: a stale
 * prop clobbering the row being typed into, a reading that printed
 * "A and B or C" for "A and (B or C)", a chip clipped with no way to read it.
 * Every one of those is type-correct and unit-tested and wrong on screen.
 */

/** Fills one condition row, one field at a time — the sequence that raced. */
async function condition(
  page: import('@playwright/test').Page,
  index: number,
  dim: string,
  op: string,
  value: string,
): Promise<void> {
  const row = page.locator('dialog .cond-row').nth(index);
  await row.getByLabel('Dimension').fill(dim);
  await row.getByLabel('Operator').selectOption(op);
  await row.getByLabel('Value').fill(value);
}

test('click-to-filter adds a chip and puts it in the URL', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);

  const row = card(page, /Top pages/)
    .locator('.bar-row')
    .first();
  const value = ((await row.locator('.name').textContent()) ?? '').trim();
  await row.getByRole('button', { name: /^Filter to/ }).click();

  await expect(page).toHaveURL(/[?&]f=/);
  expect((await chips(page)).join()).toContain(value);
});

test('an old-style link still parses', async ({ page }) => {
  // The flat `dim:op:value` spelling predates the expression editor. Every
  // shared link and shipped template still uses it.
  await openView(page, { site: 2, range: '90d', filters: ['country:neq:SG'] });
  expect(await chips(page)).toEqual(['Country not SG']);
  await dashboardReady(page);
});

test('the editor builds a nested expression and reads it back unambiguously', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);
  await page.getByRole('button', { name: '+ Filter' }).click();

  const dialog = page.locator('dialog');
  await dialog.getByRole('button', { name: '+ condition' }).click();
  await condition(page, 0, 'country', 'neq', 'SG');
  // The race: three fields set in sequence must not overwrite each other.
  await expect(dialog.locator('.reading')).toHaveText('Country not SG');

  await dialog.getByRole('button', { name: '+ group' }).last().click();
  await condition(page, 1, 'path', 'contains', '/blog');
  await dialog.getByRole('button', { name: '+ condition' }).first().click();
  await condition(page, 2, 'path', 'starts', '/docs');

  // The parentheses are the assertion: "A and B or C" would be a different filter.
  await expect(dialog.locator('.reading')).toHaveText(
    'Country not SG and (Page contains /blog or Page starts with /docs)',
  );

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/f=country%3Aneq%3ASG/);
  await expect(page).toHaveURL(/f=%7E/); // the group takes the base64url spelling
  expect(await chips(page)).toEqual([
    'Country not SG',
    'Page contains /blog or Page starts with /docs',
  ]);
  await dashboardReady(page);
});

test('a chip that will not fit still says what it is', async ({ page }) => {
  await openView(page, { site: 2, range: '90d', filters: ['country:neq:SG'] });
  const chip = page.locator('.filters .fchip').first();
  // The whole expression lives in `title`, because the pill truncates.
  await expect(chip).toHaveAttribute('title', /Country not SG/);
});

test('text mode round-trips with the visual editor', async ({ page }) => {
  await openView(page, { site: 2, range: '90d', filters: ['country:neq:SG'] });
  await page.getByRole('button', { name: 'Edit filter' }).click();

  const dialog = page.locator('dialog');
  await dialog.getByRole('button', { name: 'Edit as text' }).click();
  const box = dialog.getByLabel('Filter expression');
  await expect(box).toHaveValue('country != "SG"');

  await box.fill('country != SG and (path contains /blog or path starts /docs)');
  await dialog.getByRole('button', { name: 'Edit as conditions' }).click();
  await expect(dialog.locator('.cond-row')).toHaveCount(3);

  await dialog.getByRole('button', { name: 'Apply' }).click();
  expect(await chips(page)).toEqual([
    'Country not SG',
    'Page contains /blog or Page starts with /docs',
  ]);
});

test('a typo is refused with its position, and the text is kept', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await page.getByRole('button', { name: '+ Filter' }).click();

  const dialog = page.locator('dialog');
  await dialog.getByRole('button', { name: 'Edit as text' }).click();
  const typed = 'country != SG and nonsense = 1';
  await dialog.getByLabel('Filter expression').fill(typed);
  await dialog.getByRole('button', { name: 'Edit as conditions' }).click();

  await expect(dialog.getByRole('alert')).toContainText("'nonsense' is not a dimension");
  await expect(dialog.getByRole('alert')).toContainText('character 19');
  // Losing what someone typed to a typo is the failure a text box invites.
  await expect(dialog.getByLabel('Filter expression')).toHaveValue(typed);
});

test('the whole-visit box is offered only where it changes the answer', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await page.getByRole('button', { name: '+ Filter' }).click();
  const dialog = page.locator('dialog');
  await dialog.getByRole('button', { name: '+ condition' }).click();
  const row = dialog.locator('.cond-row').first();

  // `path` can differ between hits of one visit; `country` cannot.
  await row.getByLabel('Dimension').fill('path');
  await expect(row.locator('.scope')).toHaveText(/whole visit/);
  await row.getByLabel('Dimension').fill('country');
  await expect(row.locator('.scope')).toHaveCount(0);
});
