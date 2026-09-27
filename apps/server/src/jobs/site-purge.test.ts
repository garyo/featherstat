import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binId, event, openTestDb, session, syncRollups } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  dataVersion,
  getSite,
  incrementBotDrops,
  insertEvents,
  listSites,
  tombstoneSite,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { requestSitePurge, runSitePurges } from './site-purge.ts';

let db: Db;

beforeEach(() => {
  db = openTestDb(2);
});

afterEach(() => {
  db.close();
});

/** Raw rows + rollups + a bot-drop counter for both seeded sites. */
function seedBothSites(rows = 3): void {
  withWriteTransaction(db, () => {
    for (const siteId of [1, 2]) {
      for (let i = 0; i < rows; i++) {
        const id = binId(siteId * 10 + i);
        insertEvents(db, [{ ...event({ site_id: siteId }), session_id: id, visitor_id: id }]);
        upsertSessions(db, [session({ id, site_id: siteId, visitor_id: id })]);
      }
      incrementBotDrops(db, siteId, '2023-11-14');
    }
  });
  syncRollups(db);
}

function tombstone(siteId: number): void {
  withWriteTransaction(db, () => {
    expect(tombstoneSite(db, siteId, Date.now())).toBe(true);
    requestSitePurge(db, siteId);
  });
}

function countFor(table: string, siteId: number): number {
  return db
    .prepare(`SELECT COUNT(*) FROM ${table} WHERE site_id = ?`)
    .pluck()
    .get(siteId) as number;
}

const ALL_TABLES = [
  'events',
  'sessions',
  'bot_drops',
  'rollup_traffic_hour',
  'rollup_dim_day',
  'rollup_sessions_day',
  'rollup_visitor_seen',
  'rollup_session_seen',
] as const;

describe('the tombstone', () => {
  it('hides the site from the directory and getSite immediately', () => {
    withWriteTransaction(db, () => tombstoneSite(db, 1, Date.now()));

    expect(listSites(db).map((site) => site.id)).toEqual([2]);
    expect(getSite(db, 1)).toBeUndefined();
    // The row itself survives for the purge job to find.
    expect(db.prepare('SELECT COUNT(*) FROM sites WHERE id = 1').pluck().get()).toBe(1);
  });

  it('refuses a repeat and an unknown id', () => {
    withWriteTransaction(db, () => {
      expect(tombstoneSite(db, 1, Date.now())).toBe(true);
      expect(tombstoneSite(db, 1, Date.now())).toBe(false);
      expect(tombstoneSite(db, 99, Date.now())).toBe(false);
    });
  });
});

describe('runSitePurges', () => {
  it('drains every table for the site, keeps its tombstone, and bumps the epoch', async () => {
    seedBothSites();
    const before = dataVersion(db);
    // The presence tables are empty for a day this old (PRESENCE_HORIZON_DAYS),
    // so the survivor assertion compares against what site 2 actually had.
    const site2Before = Object.fromEntries(ALL_TABLES.map((table) => [table, countFor(table, 2)]));
    expect(site2Before.events).toBeGreaterThan(0);
    expect(site2Before.rollup_dim_day).toBeGreaterThan(0);
    tombstone(1);

    const result = await runSitePurges(db);

    expect(result.completed).toBe(1);
    expect(result.rows).toBeGreaterThan(0);
    for (const table of ALL_TABLES) {
      expect(countFor(table, 1), table).toBe(0);
      expect(countFor(table, 2), `${table} (survivor)`).toBe(site2Before[table]);
    }
    // The tombstone outlives the purge, so the next site created cannot take id 1.
    expect(
      db
        .prepare('SELECT COUNT(*) FROM sites WHERE id = 1 AND deleted_at IS NOT NULL')
        .pluck()
        .get(),
    ).toBe(1);
    // Rewritten history: every pre-purge ETag must expire (invariant 10).
    expect(dataVersion(db)).toBeGreaterThan(before);
  });

  it('resumes from a watermark a crash left behind — the boot path', async () => {
    seedBothSites();
    tombstone(1);
    // Nothing ran before the "crash"; a fresh run finds the watermark and finishes.
    expect((await runSitePurges(db, { batchSize: 2 })).completed).toBe(1);
    expect(countFor('events', 1)).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) FROM settings WHERE key LIKE ?').pluck().get('site_purge:%'),
    ).toBe(0);
  });

  it('is a no-op without a watermark and drops an unreadable one', async () => {
    seedBothSites();
    expect(await runSitePurges(db)).toEqual({ completed: 0, rows: 0 });
    expect(countFor('events', 1)).toBeGreaterThan(0);

    withWriteTransaction(db, () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('site_purge:junk', '0');
    });
    expect((await runSitePurges(db)).completed).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) FROM settings WHERE key = ?').pluck().get('site_purge:junk'),
    ).toBe(0);
  });

  it('never hands a purged site id to the next site created', async () => {
    tombstone(2);
    await runSitePurges(db);

    const created = withWriteTransaction(db, () => createSite(db, { name: 'Next', domains: [] }));

    expect(created.id).toBe(3);
    expect(getSite(db, 2)).toBeUndefined();
  });

  it('the ingest path drops a deleted site like an unknown one — getSite is the gate', () => {
    // pipeline/index.ts drops any hit whose getSite comes back undefined; the
    // tombstone reuses exactly that path, so this assertion IS the ingest drop.
    withWriteTransaction(db, () => tombstoneSite(db, 1, Date.now()));
    expect(getSite(db, 1)).toBeUndefined();
  });
});
