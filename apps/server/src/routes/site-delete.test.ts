import type { SiteInfo } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binId,
  DESKTOP_UA,
  event,
  missing,
  openTestDb,
  session,
  syncRollups,
  T0,
} from '../../test/rows.ts';
import { createSecuredApp, type SecuredApp } from '../auth/app.ts';
import {
  createDashboard,
  type Db,
  getSetting,
  insertApiToken,
  insertEvents,
  insertMissingHits,
  insertViewer,
  listApiTokens,
  setSetting,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { writeAlertRules } from '../jobs/alerts.ts';
import { requestPropScrub } from '../jobs/prop-scrub.ts';
import { runSitePurges } from '../jobs/site-purge.ts';
import { requestTimezoneBackfill } from '../jobs/timezone-backfill.ts';
import { NTFY_SETTING_KEYS } from '../notify/settings.ts';
import { uidEnabledKey } from '../pipeline/identity.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';

/**
 * Site deletion through the whole secured app (docs/04 § 5): what a deleted
 * site leaves behind must never reach whoever owns the next site created.
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';
/** Long enough that only explicit `flush()` calls ever land. */
const MANUAL_FLUSH_MS = 3_600_000;

let db: Db;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2); // sites 1 and 2 — 2 is the highest id, the one SQLite would hand out again
  pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_MS });
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

/** Every table with this column, read from the live schema — a future table is in by default. */
function tablesWith(column: string): string[] {
  const tables = stmt<string>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  )
    .pluck()
    .all() as string[];
  return tables.filter((table) =>
    stmt<string>(db, `SELECT name FROM pragma_table_info('${table}')`)
      .pluck()
      .all()
      .includes(column),
  );
}

function rowsFor(table: string, siteId: number): number {
  return stmt<number>(db, `SELECT COUNT(*) FROM ${table} WHERE site_id = ?`)
    .pluck()
    .get(siteId) as number;
}

/** Scope rows naming the site — json_each reads a bare id and an id array alike. */
function scopesNaming(table: string, siteId: number): number {
  return stmt<number>(
    db,
    `SELECT COUNT(*) FROM ${table} WHERE site_scope <> 'all'
       AND EXISTS (SELECT 1 FROM json_each(site_scope) WHERE value = ?)`,
  )
    .pluck()
    .get(siteId) as number;
}

/** One row per site-keyed table, for both sites, by whatever path writes it. */
function seedEverything(): void {
  const presence = (table: string, column: string) =>
    `INSERT INTO ${table} (site_id, local_date, dim_id, dim_value, ${column}) VALUES (?, '2026-07-27', 0, '', ?)`;
  withWriteTransaction(db, () => {
    const user = stmt(db, 'INSERT INTO users (email, created_at) VALUES (?, 0)').run(
      'o@example.com',
    );
    for (const siteId of [1, 2]) {
      const id = binId(siteId);
      insertEvents(db, [{ ...event({ site_id: siteId }), session_id: id, visitor_id: id }]);
      upsertSessions(db, [session({ id, site_id: siteId, visitor_id: id })]);
      insertMissingHits(db, [missing({ site_id: siteId })]);
      for (const sql of [
        'INSERT INTO bot_drops (site_id, local_date, count) VALUES (?, ?, 1)',
        'INSERT INTO excluded_drops (site_id, local_date, count) VALUES (?, ?, 1)',
        "INSERT INTO prop_drops (site_id, local_date, reason, count) VALUES (?, ?, 'oversize', 1)",
      ]) {
        stmt(db, sql).run(siteId, '2026-07-27');
      }
      stmt(db, presence('rollup_visitor_seen', 'visitor_id')).run(siteId, id);
      stmt(db, presence('rollup_session_seen', 'session_id')).run(siteId, id);
      stmt(
        db,
        'INSERT INTO goals (site_id, name, filters, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
      ).run(siteId, 'signup', '[]');
      stmt(db, 'INSERT INTO campaigns (site_id, name, created_at) VALUES (?, ?, 0)').run(
        siteId,
        'spring',
      );
      stmt(
        db,
        'INSERT INTO campaign_aliases (site_id, field, alias, canonical) VALUES (?, ?, ?, ?)',
      ).run(siteId, 'source', 'em', 'email');
      stmt(
        db,
        'INSERT INTO prop_keys (site_id, key, first_seen, last_seen, events, distinct_values) VALUES (?, ?, 0, 0, 1, 1)',
      ).run(siteId, 'plan');
      stmt(db, 'INSERT INTO prop_values (site_id, key, value) VALUES (?, ?, ?)').run(
        siteId,
        'plan',
        'pro',
      );
      stmt(
        db,
        'INSERT INTO annotations (site_id, ts, text, created_at, updated_at) VALUES (?, 0, ?, 0, 0)',
      ).run(siteId, 'launch');
      stmt(db, 'INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(
        user.lastInsertRowid,
        siteId,
      );
      createDashboard(db, {
        name: `Site ${siteId}`,
        site_scope: String(siteId),
        layout: '{}',
        template: null,
        updated_at: 0,
      });
      setSetting(db, uidEnabledKey(siteId), '1');
      setSetting(db, `uidsalt:${siteId}`, 'aa');
      // Jobs pending when the delete lands, and the debt one owes.
      requestTimezoneBackfill(db, siteId);
      setSetting(db, `tz_backfill_dirty:${siteId}`, '1');
      requestPropScrub(db, siteId, 'plan');
    }
    insertApiToken(db, {
      name: 'both',
      token_hash: new Uint8Array(32).fill(1),
      site_scope: '[1,2]',
      created_at: 0,
    });
    insertViewer(db, { email: 'v@example.com', site_scope: '[1]', created_at: 0 });
    writeAlertRules(db, [
      { site: 1, metric: 'pageviews', condition: 'above', threshold: 10, window: 'day' },
    ]);
    setSetting(db, NTFY_SETTING_KEYS.rules, JSON.stringify([{ site: 1 }, { site: 2 }]));
    // Site 1 alone lives in Tokyo; New York is still site 2's zone.
    stmt(db, "UPDATE sites SET timezone = 'Asia/Tokyo' WHERE id = 1").run();
    setSetting(db, 'salt:Asia/Tokyo:2026-07-28', 'bb');
    setSetting(db, 'salt:America/New_York:2026-07-27', 'cc');
  });
  syncRollups(db);
}

describe('the purge', () => {
  it('leaves no row, scope or setting naming the deleted site, and spares its neighbour', async () => {
    seedEverything();
    const tables = tablesWith('site_id');
    // A new site-keyed table must be seeded here, which is what puts it under this test.
    for (const table of tables) expect(rowsFor(table, 1), `${table} seeded`).toBeGreaterThan(0);
    const before = Object.fromEntries(tables.map((table) => [table, rowsFor(table, 2)]));
    // Scope columns store `'all'`, one id, or a JSON id array.
    const scopes = tablesWith('site_scope');
    expect(scopes).toEqual(['api_tokens', 'dashboards', 'viewers']);

    const session = await adminSession();
    expect((await admin(session, 'DELETE', '/api/admin/sites/1')).status).toBe(200);
    await runSitePurges(db);

    for (const table of tables) {
      expect(rowsFor(table, 1), table).toBe(0);
      expect(rowsFor(table, 2), `${table} (neighbour)`).toBe(before[table]);
    }
    for (const table of scopes) expect(scopesNaming(table, 1), table).toBe(0);
    expect(scopesNaming('api_tokens', 2)).toBe(1);

    const keys = stmt<string>(db, 'SELECT key FROM settings ORDER BY key').pluck().all();
    // Per-site keys carry the id as one `:`-separated segment, wherever it sits.
    expect(keys.filter((key) => /(?:^|:)1(?::|$)/.test(key))).toEqual([]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'uid_enabled:2',
        'tz_backfill:2:events',
        'tz_backfill_dirty:2',
        'prop_scrub:2:plan',
      ]),
    );
    // The abandoned zone's salt goes; the zone site 2 still lives in keeps its own.
    expect(getSetting(db, 'salt:Asia/Tokyo:2026-07-28')).toBeUndefined();
    expect(getSetting(db, 'salt:America/New_York:2026-07-27')).toBe('cc');
    expect(JSON.parse(getSetting(db, NTFY_SETTING_KEYS.rules) ?? '')).toEqual([{ site: 2 }]);
    expect(getSetting(db, 'alert_rules')).toBe('[]');
  });

  it('drops hits still queued when the delete commits, however the purge and flush interleave', async () => {
    const session = await adminSession();
    pipeline.sink([{ siteId: 2, type: 'pageview', url: 'https://two.test/' }], {
      ip: '192.0.2.10',
      userAgent: DESKTOP_UA,
      receivedAt: T0,
    });

    expect((await admin(session, 'DELETE', '/api/admin/sites/2')).status).toBe(200);
    await runSitePurges(db);
    pipeline.flush();

    for (const table of tablesWith('site_id')) expect(rowsFor(table, 2), table).toBe(0);
  });
});
