import { type AnnotationInfo, type QueryResponse, QueryResponseSchema } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb, session, syncRollups, T0 } from '../../test/rows.ts';
import { type Auth, type AuthEnv, createAuth } from '../auth/auth.ts';
import { type Db, insertEvents, upsertSessions, withWriteTransaction } from '../db/index.ts';
import { createAdminRoutes } from './admin.ts';
import { createAnnotationRoutes } from './annotations.ts';
import { createQueryRoutes } from './query.ts';

/**
 * Annotations (docs/04 § 3, § 5): admin CRUD behind the wall, delivery as
 * opt-in `meta.annotations` on the query batch, and the versioned-ETag
 * contract — an annotation edit expires exactly the cached answers that opted
 * in, and no others.
 */

const PASSWORD = 'a-decent-password';

/** Noon UTC on the seeded local date (2023-11-14, site tz America/New_York). */
const NOTE_TS = Date.parse('2023-11-14T17:00:00Z');

let db: Db;
let auth: Auth;
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = openTestDb(2);
  withWriteTransaction(db, () => {
    insertEvents(db, [event()]);
    upsertSessions(db, [session()]);
  });
  syncRollups(db);
  auth = createAuth(db, { now: () => T0, env: {}, log: () => {} });
  app = new Hono<AuthEnv>()
    .route('/', createAdminRoutes(db, auth))
    .route('/', createAnnotationRoutes(db, auth))
    .route('/', createQueryRoutes(db));
  await auth.setPassword(PASSWORD);
});

afterEach(() => {
  db.close();
});

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .join('; ');
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(): Promise<Session> {
  const res = await app.request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

async function mutate(
  who: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: {
      cookie: who.cookie,
      'x-csrf-token': who.csrf,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(
  who: Session,
  body: { siteId: number | null; ts: number; text: string },
): Promise<AnnotationInfo> {
  const res = await mutate(who, 'POST', '/api/admin/annotations', body);
  expect(res.status).toBe(201);
  return (await res.json()) as AnnotationInfo;
}

async function query(body: unknown, etag?: string): Promise<Response> {
  return await app.request('/api/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(etag === undefined ? {} : { 'if-none-match': etag }),
    },
    body: JSON.stringify(body),
  });
}

const QUERY_BODY = {
  site: 1,
  range: { from: '2023-11-14', to: '2023-11-14' },
  queries: [{ id: 'kpis', metrics: ['pageviews'] }],
};

describe('auth boundary', () => {
  it('401s every admin annotation route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/annotations'],
      ['POST', '/api/admin/annotations'],
      ['PUT', '/api/admin/annotations/1'],
      ['DELETE', '/api/admin/annotations/1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('CRUD', () => {
  it('creates, lists, updates and deletes', async () => {
    const who = await login();
    const made = await create(who, { siteId: 1, ts: NOTE_TS, text: 'deployed v2' });
    expect(made).toMatchObject({ siteId: 1, ts: NOTE_TS, text: 'deployed v2' });

    const listed = await app.request('/api/admin/annotations', {
      headers: { cookie: who.cookie },
    });
    expect(await listed.json()).toEqual([made]);

    const updated = await mutate(who, 'PUT', `/api/admin/annotations/${made.id}`, {
      siteId: null,
      ts: NOTE_TS + 1,
      text: 'deployed v2.0.1',
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      id: made.id,
      siteId: null,
      ts: NOTE_TS + 1,
      text: 'deployed v2.0.1',
    });

    const deleted = await mutate(who, 'DELETE', `/api/admin/annotations/${made.id}`);
    expect(deleted.status).toBe(200);
    expect((await mutate(who, 'DELETE', `/api/admin/annotations/${made.id}`)).status).toBe(404);
  });

  it('filters the listing by ?site=, keeping install-wide notes', async () => {
    const who = await login();
    const one = await create(who, { siteId: 1, ts: NOTE_TS, text: 'site one' });
    await create(who, { siteId: 2, ts: NOTE_TS, text: 'site two' });
    const global = await create(who, { siteId: null, ts: NOTE_TS, text: 'everywhere' });

    const listed = await app.request('/api/admin/annotations?site=1', {
      headers: { cookie: who.cookie },
    });
    const rows = (await listed.json()) as AnnotationInfo[];
    expect(rows.map((row) => row.id).sort()).toEqual([one.id, global.id].sort());
  });

  it('refuses malformed bodies and unknown sites', async () => {
    const who = await login();
    const bad = await mutate(who, 'POST', '/api/admin/annotations', {
      siteId: 1,
      ts: NOTE_TS,
      text: 'x'.repeat(301),
    });
    expect(bad.status).toBe(400);
    const ghost = await mutate(who, 'POST', '/api/admin/annotations', {
      siteId: 99,
      ts: NOTE_TS,
      text: 'nope',
    });
    expect(ghost.status).toBe(404);
  });
});

describe('delivery on the query batch', () => {
  it('attaches meta.annotations only when the request opts in', async () => {
    const who = await login();
    await create(who, { siteId: 1, ts: NOTE_TS, text: 'deployed' });

    const plain = (await (await query(QUERY_BODY)).json()) as QueryResponse;
    expect(plain.meta.annotations).toBeUndefined();

    const body: unknown = await (await query({ ...QUERY_BODY, annotations: true })).json();
    // Through the schema the web reads it with, and back unchanged.
    const opted = QueryResponseSchema.parse(body);
    expect(opted).toEqual(body);
    expect(opted.meta.annotations).toMatchObject([{ ts: NOTE_TS, text: 'deployed', siteId: 1 }]);
  });

  it('filters by the request’s sites and resolved window', async () => {
    const who = await login();
    await create(who, { siteId: 2, ts: NOTE_TS, text: 'other site' });
    await create(who, { siteId: 1, ts: Date.parse('2023-12-25T12:00:00Z'), text: 'outside' });
    await create(who, { siteId: null, ts: NOTE_TS, text: 'install-wide' });

    const res = (await (await query({ ...QUERY_BODY, annotations: true })).json()) as QueryResponse;
    expect(res.meta.annotations?.map((note) => note.text)).toEqual(['install-wide']);
  });

  it('expires the opted-in ETag on an annotation write — and no other', async () => {
    const who = await login();
    const optedBody = { ...QUERY_BODY, annotations: true };

    const plainTag = (await query(QUERY_BODY)).headers.get('etag') ?? '';
    const optedTag = (await query(optedBody)).headers.get('etag') ?? '';
    expect((await query(QUERY_BODY, plainTag)).status).toBe(304);
    expect((await query(optedBody, optedTag)).status).toBe(304);

    await create(who, { siteId: 1, ts: NOTE_TS, text: 'new note' });

    // The version bump expires the annotation-opted tag…
    const refreshed = await query(optedBody, optedTag);
    expect(refreshed.status).toBe(200);
    expect(
      ((await refreshed.json()) as QueryResponse).meta.annotations?.map((n) => n.text),
    ).toEqual(['new note']);
    // …and leaves every batch that never shows annotations untouched.
    expect((await query(QUERY_BODY, plainTag)).status).toBe(304);
  });
});
