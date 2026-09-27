import { expect, test } from '@playwright/test';
import { type Server, startServer } from '../fixtures/harness.ts';
import { expectNoNonsense } from '../pages.ts';

/**
 * First-run setup through the screen an operator actually sees. The shared
 * harness claims its admin through the API — it has to, before any spec runs —
 * so this spec boots its own server over an empty database, which is the only
 * state in which the setup screen exists at all.
 */

const PASSWORD = 'e2e-fresh-password';

let server: Server;
test.beforeAll(async () => {
  server = await startServer({ seed: false });
});
test.afterAll(async () => {
  await server.stop();
});

test('the setup screen sets the admin password, once', async ({ page }) => {
  await page.goto(server.baseURL);
  await expect(
    page.getByRole('heading', { name: 'Welcome — set the admin password' }),
  ).toBeVisible();

  const password = page.getByLabel(/^Password \(at least/);
  const repeat = page.getByLabel('Repeat password');
  const token = page.getByLabel(/^Setup token/);
  const start = page.getByRole('button', { name: 'Set password & start' });
  await expect(start).toBeDisabled();

  // The form says what it is waiting for before it lets anything through.
  await password.fill('short');
  await expect(page.getByText('Needs at least 8 characters.')).toBeVisible();
  await password.fill(PASSWORD);
  await repeat.fill(`${PASSWORD}-not`);
  await expect(page.getByText("Passwords don't match.")).toBeVisible();
  await repeat.fill(PASSWORD);

  // Only the token from the server log claims the instance.
  await token.fill('not-the-setup-token');
  await start.click();
  await expect(page.getByRole('alert')).toContainText('wrong setup token');

  await token.fill(server.setupToken);
  await start.click();
  await expect(page.locator('header.top')).toBeVisible();
  // An instance with no sites yet is a screen too.
  await expectNoNonsense(page, 'a fresh install');

  // Setup is spent: signing out leads to the login form, not back to setup.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('header.top')).toBeVisible();
});
