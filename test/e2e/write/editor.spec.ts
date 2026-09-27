import { expect, test } from '@playwright/test';
import { answerConfirm, card, dashboardReady, openView } from '../pages.ts';

/**
 * The dashboard editor, which writes. Serial and self-cleaning (see
 * playwright.config.ts), so the one seeded database survives the run: whatever
 * a spec here creates, it deletes.
 */

const WIDGET_TITLE = 'E2E channels';

test('the breakdown picker offers real dimension names', async ({ page }) => {
  // The bug this suite was built for: it offered "(none)" and "[object Object]"
  // twice, because it iterated a zod UNION's `.options`.
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('button', { name: 'Add widget' }).click();

  const breakdown = page.locator('dialog').getByLabel('Breakdown');
  await expect(breakdown.locator('option')).toContainText([
    '(none)',
    'Page',
    'Hostname',
    'Title',
    'Outbound link',
    'Referrer',
    'Referrer type',
  ]);
  // 26 dimensions plus "(none)": the union bug offered three entries in total.
  await expect(breakdown.locator('option')).toHaveCount(27);

  await page.locator('dialog').getByRole('button', { name: 'Close' }).click();
});

test('a widget can be added, survives a reload, and can be removed', async ({ page }) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('button', { name: 'Add widget' }).click();

  const dialog = page.locator('dialog');
  await dialog.getByLabel('Visualization').selectOption('bar-list');
  // By role, not by label: the Breakdown select's accessible name contains
  // "Title" too, since one of its options is the Title dimension.
  await dialog.getByRole('textbox', { name: 'Title' }).fill(WIDGET_TITLE);
  await dialog.getByRole('checkbox', { name: 'Visits', exact: true }).check();
  await dialog.getByLabel('Breakdown').selectOption('ref_type');
  await dialog.getByRole('button', { name: 'Add widget' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);

  const added = card(page, WIDGET_TITLE);
  await expect(added).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Saved means stored: a reload is the only honest check.
  await page.reload();
  await dashboardReady(page);
  await expect(card(page, WIDGET_TITLE)).toBeVisible();
  // …and it answered, rather than rendering an empty frame.
  await expect(card(page, WIDGET_TITLE)).toContainText(/direct|search|social|referral/);

  // Clean up. Saving a built-in does not edit it — it creates YOUR COPY
  // (SiteView's tooltip says so), so removing the widget is not enough: the
  // copy itself has to go, or the next run opens a dashboard this one made and
  // the button it looks for reads "Edit" instead of "Customize".
  await page.getByLabel('Dashboard').selectOption({ label: 'Manage dashboards…' });
  const manage = page.locator('dialog');
  // Only a stored dashboard offers Delete; the built-ins offer Open alone. So
  // this finds the copy without depending on what it got named.
  const remove = manage
    .locator('.mrow')
    .filter({ hasText: 'Delete' })
    .getByRole('button', {
      name: /Delete|Really/i,
    });
  await remove.click(); // arms
  await remove.click(); // confirms — the same button asks and then does it
  await expect(manage.locator('.mrow').filter({ hasText: 'Delete' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.reload();
  await dashboardReady(page);
  await expect(card(page, WIDGET_TITLE)).toHaveCount(0);
  // Back to the shipped built-in, which is what "Customize" implies.
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible();
});

test('leaving a changed draft asks first, and "no" keeps the draft and the URL', async ({
  page,
}) => {
  await openView(page, { site: 2, range: '90d' });
  await dashboardReady(page);
  // In-app, so Back has a same-document entry to return to.
  await page.getByLabel('Dashboard').selectOption({ label: 'Content (built-in)' });
  await expect(page).toHaveURL(/dash=t%3Acontent/);
  await dashboardReady(page);

  await page.getByRole('button', { name: 'Customize' }).click();
  await page.locator('.ew').filter({ hasText: 'Scroll depth' }).getByTitle('Remove widget').click();
  const editing = page.getByText('Editing', { exact: true });
  const removed = page.locator('.ew').filter({ hasText: 'Scroll depth' });
  await expect(removed).toHaveCount(0);

  // Back: a history move cannot be cancelled, only undone — the URL returns.
  const asked = await answerConfirm(page, 'dismiss', () => page.goBack());
  expect(asked).toContain('Discard unsaved changes to Content');
  await expect(page).toHaveURL(/dash=t%3Acontent/);
  await expect(editing).toBeVisible();
  await expect(removed).toHaveCount(0);

  // A header button asks the same question; "no" stays put…
  const realtime = page.getByRole('button', { name: 'Realtime' });
  await answerConfirm(page, 'dismiss', () => realtime.click());
  await expect(page).toHaveURL(/dash=t%3Acontent/);
  await expect(editing).toBeVisible();

  // …and "yes" leaves, discarding the draft rather than saving it.
  await answerConfirm(page, 'accept', () => realtime.click());
  await expect(page).toHaveURL(/view=realtime/);
  await page.goBack();
  await dashboardReady(page);
  await expect(editing).toHaveCount(0);
  await expect(card(page, 'Scroll depth')).toBeVisible();
});

test('the drag handle moves a card with the arrow keys', async ({ page }) => {
  await openView(page, { site: 2, range: '90d', dash: 't:content' });
  await dashboardReady(page);
  await page.getByRole('button', { name: 'Customize' }).click();

  const titles = page.locator('.ew .etitle');
  const before = await titles.allTextContents();
  const at = before.indexOf('Top pages');
  expect(at).toBeGreaterThanOrEqual(0);

  const handle = page.getByRole('button', { name: 'Reorder Top pages' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');

  const after = [...before];
  after.splice(at, 2, before[at + 1] as string, 'Top pages');
  await expect(titles).toHaveText(after);
  await expect(page.getByText(`Top pages moved to position ${at + 2} of`)).toBeAttached();

  // Focus follows the card it moved, so the next press moves it again.
  await expect(handle).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(titles).toHaveText(before);

  // Nothing is saved: cancelling leaves the built-in as it was.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible();
});
