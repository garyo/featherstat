import { type Harness, startHarness } from './harness.ts';

/**
 * Boots the one harness the whole run shares and hands the workers its address
 * through the environment — Playwright's documented way, since a worker is its
 * own process and cannot see anything else set here.
 *
 * The teardown is the returned function: Playwright calls it after the last
 * spec, including when the run failed, so the server and the temp database go
 * away either way.
 */
let harness: Harness | undefined;

export default async function globalSetup(): Promise<() => Promise<void>> {
  harness = await startHarness();
  process.env.E2E_BASE_URL = harness.baseURL;
  process.env.E2E_STORAGE_STATE = harness.storageState;
  return async () => {
    await harness?.stop();
    harness = undefined;
  };
}
