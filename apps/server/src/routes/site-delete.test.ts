import type { SiteInfo } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import { createSecuredApp, type SecuredApp } from '../auth/app.ts';
import { type Db, listApiTokens } from '../db/index.ts';
import { runSitePurges } from '../jobs/site-purge.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';

/**
 * Site deletion through the whole secured app (docs/04 § 5): what a deleted
 * site leaves behind must never reach whoever owns the next site created.
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';

let db: Db;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2); // sites 1 and 2 — 2 is the highest id, the one SQLite would hand out again
  pipeline = createPipeline(db);
  secured = createSecuredApp({
    db,
    sink: pipeline.sink,
    pipeline,
    auth: { now: () => T0, env: {}, setupToken: SETUP_TOKEN },
  });
});

afterEach(() => {
  pipeline.shutdown();
  db.close();
});

interface AdminSession {
  cookie: string;
  csrf: string;
}

async function adminSession(): Promise<AdminSession> {
  const res = await secured.app.request('/api/admin/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, setupToken: SETUP_TOKEN }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .join('; ');
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie, csrf };
}

async function admin(
  session: AdminSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await secured.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sitesSeenBy(token: string): Promise<number[]> {
  const res = await secured.app.request('/api/sites', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as SiteInfo[]).map((site) => site.id);
}

describe('deleting a site', () => {
  it('never lets an old grant read the next site created', async () => {
    const session = await adminSession();
    const minted = await admin(session, 'POST', '/api/admin/tokens', {
      name: 'old tenant',
      sites: [1, 2],
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    expect(await sitesSeenBy(token)).toEqual([1, 2]);

    expect((await admin(session, 'DELETE', '/api/admin/sites/2')).status).toBe(200);
    await runSitePurges(db);
    const created = await admin(session, 'POST', '/api/admin/sites', { name: 'New tenant' });
    expect(created.status).toBe(201);
    const site = (await created.json()) as SiteInfo;

    // Two independent walls: the id is fresh, and the grant no longer names the dead one.
    expect(site.id).toBe(3);
    expect(listApiTokens(db).map((row) => row.site_scope)).toEqual(['[1]']);
    expect(await sitesSeenBy(token)).toEqual([1]);
  });
});
