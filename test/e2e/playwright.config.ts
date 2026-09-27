import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end, against the built SPA served by the real server (fixtures/
 * harness.ts). Manual for now — `bun run e2e` — and deliberately NOT part of
 * `bun run ci`: the pre-push gate stays fast, which is what keeps it being run.
 *
 * Three projects, because some specs write:
 *
 * - `read` is everything that only looks, fully parallel over one seeded
 *   database.
 * - `write` edits dashboards and settings, so it runs after `read`, one worker,
 *   in file order — and each of its specs cleans up after itself, which is what
 *   lets one seeded database serve the whole run.
 * - `fresh` boots its own server over an empty database (first-run setup has
 *   no other way to exist), so it shares nothing and runs beside `read`.
 *
 * Chromium only. Three engines would triple the time for little on an internal
 * dashboard; add one when a real defect argues for it.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8788';
const storageState = process.env.E2E_STORAGE_STATE;

export default defineConfig({
  testDir: '.',
  globalSetup: './fixtures/global-setup.ts',
  // Every wait is an `expect` poll, never a sleep; these are the ceilings.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['list']],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    // The suite starts logged in: claiming the admin is the harness's job, and
    // re-doing it per spec would test the login form 40 times and nothing else.
    ...(storageState === undefined ? {} : { storageState }),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'read', testMatch: /read\/.*\.spec\.ts$/, fullyParallel: true },
    {
      name: 'write',
      testMatch: /write\/.*\.spec\.ts$/,
      fullyParallel: false,
      workers: 1,
      dependencies: ['read'],
    },
    {
      name: 'fresh',
      testMatch: /fresh\/.*\.spec\.ts$/,
      // Cookies ignore ports: the shared harness's session would ride along.
      use: { storageState: { cookies: [], origins: [] } },
    },
  ],
});
