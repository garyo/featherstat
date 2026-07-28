import { isSecureWebhookUrl, type NtfySettingsView, NtfyUrlSchema } from '@analytics/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, getSetting } from '../db/index.ts';
import {
  createNtfyRoutes,
  NTFY_ADMIN_PATH,
  NTFY_SETTING_KEYS,
  NTFY_TEST_PATH,
  type NtfyTestResult,
} from './index.ts';

const PASSWORD = 'a-decent-password';
const SETTINGS = {
  url: 'https://ntfy.example.com',
  topic: 'analytics',
  rules: [{ site: 1, eventCategory: 'signup' }],
};

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;
/** How often the router asked the notifier to reload. */
let reloads: number;
/** What the stubbed notifier answers a test send with, and how often it was asked. */
let testResult: NtfyTestResult;
let testSends: number;

beforeEach(async () => {
  db = openTestDb(1);
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  reloads = 0;
  testResult = { ok: true };
  testSends = 0;
  const onChange = (): void => {
    reloads += 1;
  };
  const onTest = (): Promise<NtfyTestResult> => {
    testSends += 1;
    return Promise.resolve(testResult);
  };
  app = new Hono<AuthEnv>().route('/', createNtfyRoutes(db, auth, { onChange, onTest }));
  await auth.setPassword(PASSWORD);
});

afterEach(() => {
  db.close();
});

interface Session {
  cookie: string;
  csrf: string;
}

/** This router mounts no login route (it is not the auth surface); issue directly. */
async function openSession(): Promise<Session> {
  let csrf = '';
  const issuer = new Hono();
  issuer.get('/issue', (c) => {
    csrf = auth.login(c).csrfToken;
    return c.json({ ok: true });
  });
  const res = await issuer.request('/issue');
  const cookie = res.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .join('; ');
  return { cookie, csrf };
}

async function get(session?: Session): Promise<Response> {
  const headers: Record<string, string> = {};
  if (session !== undefined) headers.cookie = session.cookie;
  return await app.request(NTFY_ADMIN_PATH, { headers });
}

async function put(body: unknown, session?: Session): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session !== undefined) {
    headers.cookie = session.cookie;
    headers['x-csrf-token'] = session.csrf;
  }
  return await app.request(NTFY_ADMIN_PATH, {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const viewOf = async (res: Response): Promise<NtfySettingsView> =>
  (await res.json()) as NtfySettingsView;

describe('ntfy settings routes', () => {
  it('needs a session, and a CSRF token to write', async () => {
    expect((await get()).status).toBe(401);
    expect((await put(SETTINGS)).status).toBe(401);

    const session = await openSession();
    const res = await app.request(NTFY_ADMIN_PATH, {
      method: 'PUT',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(SETTINGS),
    });
    expect(res.status).toBe(403);
    expect(reloads).toBe(0);
  });

  it('reports an unconfigured install and never caches', async () => {
    const session = await openSession();
    const res = await get(session);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await viewOf(res)).toEqual({ tokenSet: false, rules: [] });
  });

  it('round-trips url, topic and rules through the settings table', async () => {
    const session = await openSession();
    const saved = await put({ ...SETTINGS, token: 'tk_secret' }, session);
    expect(saved.status).toBe(200);
    expect(reloads).toBe(1);

    const view = await viewOf(await get(session));
    expect(view).toEqual({ ...SETTINGS, tokenSet: true });
    // The token is stored, but a read never hands it back out.
    expect(JSON.stringify(view)).not.toContain('tk_secret');
    expect(getSetting(db, NTFY_SETTING_KEYS.token)).toBe('tk_secret');
    expect(getSetting(db, NTFY_SETTING_KEYS.rules)).toBe(JSON.stringify(SETTINGS.rules));
  });

  it('keeps the stored token when the body omits it, clears it on null', async () => {
    const session = await openSession();
    await put({ ...SETTINGS, token: 'tk_secret' }, session);

    await put({ ...SETTINGS, rules: [{ eventCategory: 'purchase' }] }, session);
    expect(getSetting(db, NTFY_SETTING_KEYS.token)).toBe('tk_secret');
    expect((await viewOf(await get(session))).tokenSet).toBe(true);

    const cleared = await put({ ...SETTINGS, token: null }, session);
    expect((await viewOf(cleared)).tokenSet).toBe(false);
    expect(getSetting(db, NTFY_SETTING_KEYS.token)).toBeUndefined();
  });

  it('DELETE turns notifications off entirely and reloads the notifier', async () => {
    const session = await openSession();
    await put({ ...SETTINGS, token: 'tk_secret' }, session);
    expect(reloads).toBe(1);

    const res = await app.request(NTFY_ADMIN_PATH, {
      method: 'DELETE',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(res.status).toBe(200);
    expect(await viewOf(res)).toEqual({ tokenSet: false, rules: [] });
    expect(reloads).toBe(2);
    for (const key of Object.values(NTFY_SETTING_KEYS)) {
      expect(getSetting(db, key), key).toBeUndefined();
    }
    // And it is gated like every other verb here.
    expect((await app.request(NTFY_ADMIN_PATH, { method: 'DELETE' })).status).toBe(401);
  });

  it('rejects a url that is neither https nor loopback, and writes nothing', async () => {
    const session = await openSession();
    const res = await put({ ...SETTINGS, url: 'http://ntfy.example.com' }, session);

    expect(res.status).toBe(400);
    expect(getSetting(db, NTFY_SETTING_KEYS.url)).toBeUndefined();
    expect(reloads).toBe(0);
  });

  it('accepts a loopback endpoint over plain http', async () => {
    const session = await openSession();
    const res = await put({ ...SETTINGS, url: 'http://127.0.0.1:8080' }, session);

    expect(res.status).toBe(200);
    expect((await viewOf(res)).url).toBe('http://127.0.0.1:8080');
  });

  it('rejects malformed rules, topics and bodies', async () => {
    const session = await openSession();
    const bad = [
      { ...SETTINGS, rules: [{}] }, // constrains nothing: would fire on every hit
      { ...SETTINGS, rules: [{ site: 0 }] },
      { ...SETTINGS, topic: 'analytics/../admin' },
      { ...SETTINGS, topic: '' },
      { url: SETTINGS.url }, // no topic
    ];
    for (const body of bad) {
      expect((await put(body, session)).status).toBe(400);
    }
    expect((await put('not json at all', session)).status).toBe(400);
    expect(getSetting(db, NTFY_SETTING_KEYS.topic)).toBeUndefined();
  });
});

describe('test notification', () => {
  async function sendTest(session?: Session): Promise<Response> {
    const headers: Record<string, string> = {};
    if (session !== undefined) {
      headers.cookie = session.cookie;
      headers['x-csrf-token'] = session.csrf;
    }
    return await app.request(NTFY_TEST_PATH, { method: 'POST', headers });
  }

  it('is gated exactly like the settings row it belongs to', async () => {
    expect((await sendTest()).status).toBe(401);

    const session = await openSession();
    const noToken = await app.request(NTFY_TEST_PATH, {
      method: 'POST',
      headers: { cookie: session.cookie },
    });
    expect(noToken.status).toBe(403);
    expect(testSends).toBe(0);
  });

  it('answers what the delivery did, and never caches it', async () => {
    const session = await openSession();
    const ok = await sendTest(session);

    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ ok: true });
    expect(testSends).toBe(1);
  });

  it('separates "not configured yet" from "ntfy refused it"', async () => {
    const session = await openSession();
    testResult = { ok: false, unconfigured: true, error: 'set the ntfy server and topic first' };
    const unconfigured = await sendTest(session);
    expect(unconfigured.status).toBe(400);
    expect(await unconfigured.json()).toEqual({ error: 'set the ntfy server and topic first' });

    testResult = { ok: false, error: 'the ntfy server refused it (HTTP 403)' };
    const refused = await sendTest(session);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'the ntfy server refused it (HTTP 403)' });
  });

  it('reports the feature unavailable when no notifier is wired', async () => {
    const session = await openSession();
    const settingsOnly = new Hono<AuthEnv>().route('/', createNtfyRoutes(db, auth));
    const res = await settingsOnly.request(NTFY_TEST_PATH, {
      method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });

    expect(res.status).toBe(501);
  });
});

describe('webhook url validation', () => {
  it('allows https anywhere and http only on loopback', () => {
    for (const url of ['https://ntfy.example.com/', 'http://localhost:2586', 'http://[::1]/x']) {
      expect(isSecureWebhookUrl(url)).toBe(true);
      expect(NtfyUrlSchema.safeParse(url).success).toBe(true);
    }
    for (const url of ['http://ntfy.example.com', 'javascript:alert(1)', 'ntfy.example.com', '']) {
      expect(isSecureWebhookUrl(url)).toBe(false);
      expect(NtfyUrlSchema.safeParse(url).success).toBe(false);
    }
  });
});
