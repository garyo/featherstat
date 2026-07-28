import { NtfySettingsSchema, type NtfySettingsView } from '@featherstat/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { type Db, withWriteTransaction } from '../db/index.ts';
import type { NtfyTestResult } from './ntfy.ts';
import {
  clearNtfySettings,
  type NtfySettings,
  readNtfySettings,
  writeNtfySettings,
} from './settings.ts';

/**
 * `GET`/`PUT /api/admin/ntfy` and `POST /api/admin/ntfy/test` (docs/04 § 5):
 * the notification settings pane. Self-gating — the session gate and the CSRF
 * guard are registered here, so the router is safe wherever it is mounted.
 */

export const NTFY_ADMIN_PATH = '/api/admin/ntfy';
/** Delivers one notification with the SAVED settings, so the pane can prove them. */
export const NTFY_TEST_PATH = `${NTFY_ADMIN_PATH}/test`;
/** A rule list, nothing more (the shared schema caps it far below this). */
const MAX_BODY_BYTES = 64 * 1024;

export interface NtfyRoutesOptions {
  /** Called after a successful save — wire it to the notifier's `reload`. */
  onChange?: () => void;
  /** Wire it to the notifier's `test`; absent, the test endpoint reports it unavailable. */
  onTest?: () => Promise<NtfyTestResult>;
}

export function createNtfyRoutes(
  db: Db,
  auth: Auth,
  options: NtfyRoutesOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // The settings row and everything under it, so a subpath added later is born
  // gated rather than silently open.
  for (const path of [NTFY_ADMIN_PATH, `${NTFY_ADMIN_PATH}/*`]) {
    app.use(path, bodyLimit({ maxSize: MAX_BODY_BYTES }));
    app.use(path, auth.gate);
    app.use(path, auth.csrfGuard);
    // The row behind this holds a bearer token; nothing about it may be cached.
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.set('Cache-Control', 'no-store');
    });
  }

  app.get(NTFY_ADMIN_PATH, (c) => c.json(viewOf(readNtfySettings(db))));

  app.put(NTFY_ADMIN_PATH, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    // The url must be https (or loopback) and the rules well-formed — validated
    // server-side, whatever the UI checked (packages/shared NtfySettingsSchema).
    const parsed = NtfySettingsSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
    }
    withWriteTransaction(db, () => writeNtfySettings(db, parsed.data));
    options.onChange?.();
    return c.json(viewOf(readNtfySettings(db)));
  });

  // The off switch: a PUT cannot express "unconfigured" (its schema rightly
  // demands a url and topic), so turning notifications off is its own verb.
  app.delete(NTFY_ADMIN_PATH, (c) => {
    withWriteTransaction(db, () => clearNtfySettings(db));
    options.onChange?.();
    return c.json(viewOf(readNtfySettings(db)));
  });

  // Proving the endpoint works is worth one real delivery: what fails here —
  // wrong topic, stale token, unreachable host — is exactly what would fail
  // silently at 3am otherwise.
  app.post(NTFY_TEST_PATH, async (c) => {
    if (options.onTest === undefined) {
      return c.json({ error: 'notifications are not wired up on this server' }, 501);
    }
    const result = await options.onTest();
    if (result.ok) return c.json({ ok: true });
    const error = result.error ?? 'the notification could not be delivered';
    return c.json({ error }, result.unconfigured === true ? 400 : 502);
  });

  return app;
}

function viewOf(settings: NtfySettings): NtfySettingsView {
  const view: NtfySettingsView = { tokenSet: settings.token !== undefined, rules: settings.rules };
  if (settings.url !== undefined) view.url = settings.url;
  if (settings.topic !== undefined) view.topic = settings.topic;
  return view;
}
