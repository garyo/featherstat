import type { Hono } from 'hono';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import type { Db } from '../db/index.ts';
import type { Pipeline } from '../pipeline/index.ts';
import { createNtfyNotifier, type NtfyNotifier, type NtfyNotifierOptions } from './ntfy.ts';
import { createNtfyRoutes } from './routes.ts';

export type {
  NtfyNotifier,
  NtfyNotifierOptions,
  NtfyTestResult,
} from './ntfy.ts';
export { createNtfyRoutes, NTFY_ADMIN_PATH, NTFY_TEST_PATH } from './routes.ts';
export { NTFY_SETTING_KEYS, readNtfySettings } from './settings.ts';

export interface NtfyIntegration {
  notifier: NtfyNotifier;
  /** Admin settings routes, already reloading the notifier on save. Mount behind auth. */
  routes: Hono<AuthEnv>;
}

/**
 * The whole feature in one hook (docs/01 R16): subscribe to the pipeline, hand
 * back the admin routes. Nothing is mounted here — the integrator decides.
 * Without a pipeline (a read-only app) the settings pane still works; only
 * delivery is idle.
 */
export function createNtfyIntegration(
  db: Db,
  pipeline: Pick<Pipeline, 'onHit'> | undefined,
  auth: Auth,
  options: NtfyNotifierOptions = {},
): NtfyIntegration {
  const notifier = createNtfyNotifier(db, options);
  pipeline?.onHit((event) => notifier.record(event));
  const routes = createNtfyRoutes(db, auth, {
    onChange: () => notifier.reload(),
    onTest: () => notifier.test(),
  });
  return { notifier, routes };
}
