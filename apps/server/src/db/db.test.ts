import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, SESSION, session, VISITOR } from '../../test/rows.ts';
import {
  countEvents,
  createDashboard,
  createSite,
  type Db,
  databaseSizeBytes,
  deleteDashboard,
  deleteSetting,
  getBotDrops,
  getDashboard,
  getSetting,
  getShareToken,
  getSite,
  incrementBotDrops,
  insertEvents,
  insertShareToken,
  listBotDrops,
  listDashboards,
  listSites,
  migrate,
  type NewDashboard,
  observeWriteTransactions,
  openDb,
  revokeShareTokens,
  schemaVersion,
  setSetting,
  settingKeysWithPrefix,
  updateDashboard,
  updateSite,
  upsertSessions,
  withWriteTransaction,
} from './index.ts';
import { MIGRATIONS } from './migrations/index.ts';

/**
 * The shipped migrations as no-ops, plus the version after them. `openDb` has
 * already applied the real list, so a fake migration must sit past its tail or
 * `migrate` skips it — and hard-coding that number is what made these tests
 * fail on every schema bump.
 */
const alreadyApplied = MIGRATIONS.map((m) => ({ ...m, sql: 'SELECT 1' }));
const NEXT_VERSION = MIGRATIONS.length + 1;

function tableNames(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

describe('migrate', () => {
  it('brings an empty database up to the latest schema', () => {
    const db = openDb(':memory:');
    expect(tableNames(db)).toEqual([
      'admin_sessions',
      'bot_drops',
      'dashboards',
      'events',
      'schema_migrations',
      'sessions',
      'settings',
      'share_tokens',
      'sites',
    ]);
    // Spelled from MIGRATIONS rather than repeated: the list is the fact, and
    // this asserts they were all applied in order, not what the newest one is.
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, name: m.name })),
    );
    db.close();
  });

  it('creates every index from docs/03', () => {
    const db = openDb(':memory:');
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_%' ORDER BY name",
      )
      .pluck()
      .all();
    expect(indexes).toEqual([
      'ix_admin_sessions_expiry',
      'ix_events_session',
      'ix_events_site_date_visitor',
      'ix_events_site_ts',
      'ix_sessions_open',
      'ix_sessions_site_date',
      'ix_share_tokens_dashboard',
    ]);
    db.close();
  });

  it('is a no-op when re-run on an already-migrated database', () => {
    const db = openDb(':memory:');
    const applied = db.prepare('SELECT applied_at FROM schema_migrations').pluck().all();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT applied_at FROM schema_migrations').pluck().all()).toEqual(applied);
    db.close();
  });

  it('refuses a database migrated by a newer build', () => {
    const db = openDb(':memory:');
    db.exec('PRAGMA user_version = 99');
    expect(() => migrate(db)).toThrow(/newer than this build/);
    db.close();
  });

  it('rejects a non-increasing migration list', () => {
    const db = openDb(':memory:');
    const bogus = [
      { version: 2, name: 'b', sql: 'SELECT 1' },
      { version: 2, name: 'c', sql: 'SELECT 1' },
    ];
    expect(() => migrate(db, bogus)).toThrow(/increasing/);
    db.close();
  });

  it('applies pending migrations to an existing database and leaves earlier ones alone', () => {
    const db = openDb(':memory:');
    expect(
      migrate(db, [
        ...alreadyApplied,
        { version: NEXT_VERSION, name: 'later', sql: 'CREATE TABLE later (a INTEGER)' },
      ]),
    ).toBe(NEXT_VERSION);
    expect(tableNames(db)).toContain('later');
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY version').pluck().all()).toEqual(
      [...MIGRATIONS.map((m) => m.name), 'later'],
    );
    db.close();
  });

  it('rolls the whole migration back when its SQL fails', () => {
    const db = openDb(':memory:');
    expect(() =>
      migrate(db, [
        ...alreadyApplied,
        { version: NEXT_VERSION, name: 'broken', sql: 'CREATE TABLE half (a INTEGER); NOT SQL;' },
      ]),
    ).toThrow();
    expect(tableNames(db)).not.toContain('half');
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
  });
});

describe('openDb on a file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analytics-db-'));
    path = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets WAL + synchronous=NORMAL and re-opens idempotently', () => {
    const first = openDb(path);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    const site = withWriteTransaction(first, () =>
      createSite(first, { name: 'Example', domains: ['example.com'] }),
    );
    first.close();

    const second = openDb(path);
    expect(schemaVersion(second)).toBe(MIGRATIONS.length);
    expect(second.prepare('SELECT count(*) FROM schema_migrations').pluck().get()).toBe(
      MIGRATIONS.length,
    );
    expect(getSite(second, site.id)).toEqual(site);
    second.close();
  });
});

describe('helpers', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const write = <T>(fn: () => T): T => withWriteTransaction(db, fn);

  describe('sites', () => {
    it('round-trips a site with its domains JSON array', () => {
      const created = write(() =>
        createSite(db, {
          id: 3,
          name: 'Example',
          domains: ['example.com', 'www.example.com'],
          timezone: 'Europe/Berlin',
          created_at: 1_700_000_000_000,
        }),
      );
      expect(created).toEqual({
        id: 3,
        name: 'Example',
        domains: ['example.com', 'www.example.com'],
        timezone: 'Europe/Berlin',
        created_at: 1_700_000_000_000,
      });
      expect(getSite(db, 3)).toEqual(created);
      expect(db.prepare('SELECT domains FROM sites WHERE id = 3').pluck().get()).toBe(
        '["example.com","www.example.com"]',
      );
    });

    it('assigns an id and the default timezone when omitted', () => {
      const created = write(() => createSite(db, { name: 'Auto', domains: ['auto.test'] }));
      expect(created.id).toBeGreaterThan(0);
      expect(created.timezone).toBe('America/New_York');
      expect(getSite(db, created.id)?.timezone).toBe('America/New_York');
    });

    it('lists sites by id and returns undefined for a missing one', () => {
      write(() => {
        createSite(db, { id: 2, name: 'Two', domains: ['two.test'] });
        createSite(db, { id: 1, name: 'One', domains: ['one.test'] });
      });
      expect(listSites(db).map((s) => s.id)).toEqual([1, 2]);
      expect(getSite(db, 99)).toBeUndefined();
    });

    it('updates only the patched columns; id and created_at never move', () => {
      const created = write(() =>
        createSite(db, { id: 1, name: 'One', domains: ['one.test'], created_at: 123 }),
      );
      const renamed = write(() => updateSite(db, 1, { name: 'Renamed' }));
      expect(renamed).toEqual({ ...created, name: 'Renamed' });

      const moved = write(() =>
        updateSite(db, 1, { domains: ['one.test', 'alias.test'], timezone: 'UTC' }),
      );
      expect(moved).toEqual({
        ...created,
        name: 'Renamed',
        domains: ['one.test', 'alias.test'],
        timezone: 'UTC',
      });
      expect(write(() => updateSite(db, 99, { name: 'Ghost' }))).toBeUndefined();
    });
  });

  describe('events', () => {
    it('round-trips a fully populated row', () => {
      const row = event({
        type: 'event',
        seq: 4,
        hostname: 'example.com',
        path: '/pricing',
        title: 'Pricing',
        target_url: 'https://elsewhere.test/x',
        ref_domain: 'google.com',
        ref_type: 'search',
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'launch',
        event_category: 'video',
        event_action: 'play',
        event_name: 'intro',
        event_value: 12.5,
        browser: 'Firefox',
        browser_version: '129.0',
        os: 'macOS',
        device_type: 'desktop',
        screen: '2560x1440',
        lang: 'en-us',
        country: 'US',
        region: 'MA',
        city: 'Boston',
        lat: 42.36,
        lon: -71.06,
      });
      write(() => insertEvents(db, [row]));

      const stored = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
      expect(stored.id).toBe(1);
      expect(stored.visitor_id).toEqual(Buffer.from(VISITOR));
      expect(stored.session_id).toEqual(Buffer.from(SESSION));
      const { visitor_id, session_id, ...scalars } = row;
      expect(stored).toMatchObject(scalars);
    });

    it('stores NULL for every column a row omits', () => {
      write(() => insertEvents(db, [event()]));
      const stored = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
      expect(stored.path).toBeNull();
      expect(stored.event_value).toBeNull();
      expect(stored.lat).toBeNull();
      expect(stored.country).toBeNull();
    });

    it('inserts a batch in one call and keeps rowid order', () => {
      write(() => insertEvents(db, [event({ path: '/a', seq: 1 }), event({ path: '/b', seq: 2 })]));
      expect(db.prepare('SELECT path FROM events ORDER BY id').pluck().all()).toEqual(['/a', '/b']);
    });
  });

  describe('sessions', () => {
    it('inserts then updates only the mutable columns', () => {
      write(() =>
        upsertSessions(db, [
          session({
            entry_path: '/landing',
            exit_path: '/landing',
            ref_type: 'search',
            ref_domain: 'google.com',
            browser: 'Firefox',
            country: 'US',
          }),
        ]),
      );

      write(() =>
        upsertSessions(db, [
          session({
            started_at: 0,
            last_seen_at: 1_700_000_060_000,
            entry_path: '/ignored',
            exit_path: '/pricing',
            pageviews: 3,
            events: 2,
            engaged_ms: 45_000,
            ref_type: 'ignored',
            browser: 'ignored',
          }),
        ]),
      );

      const stored = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
      expect(db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(1);
      expect(stored).toMatchObject({
        started_at: 1_700_000_000_000,
        last_seen_at: 1_700_000_060_000,
        entry_path: '/landing',
        exit_path: '/pricing',
        pageviews: 3,
        events: 2,
        engaged_ms: 45_000,
        ref_type: 'search',
        ref_domain: 'google.com',
        browser: 'Firefox',
        country: 'US',
      });
      expect(stored.id).toEqual(Buffer.from(SESSION));
    });
  });

  describe('settings', () => {
    it('round-trips, overwrites and deletes', () => {
      expect(getSetting(db, 'day_salt')).toBeUndefined();
      write(() => setSetting(db, 'day_salt', 'abc'));
      expect(getSetting(db, 'day_salt')).toBe('abc');
      write(() => setSetting(db, 'day_salt', 'def'));
      expect(getSetting(db, 'day_salt')).toBe('def');
      write(() => deleteSetting(db, 'day_salt'));
      expect(getSetting(db, 'day_salt')).toBeUndefined();
      expect(() => write(() => deleteSetting(db, 'missing'))).not.toThrow();
    });

    it('lists keys by prefix, sorted, treating the prefix literally', () => {
      write(() => {
        setSetting(db, 'salt:2026-07-27', 'b');
        setSetting(db, 'salt:2026-07-26', 'a');
        setSetting(db, 'uid_enabled:1', 'c');
        setSetting(db, 'uidXenabled:2', 'd'); // must not match via the `_` wildcard
      });
      expect(settingKeysWithPrefix(db, 'salt:')).toEqual(['salt:2026-07-26', 'salt:2026-07-27']);
      expect(settingKeysWithPrefix(db, 'uid_enabled:')).toEqual(['uid_enabled:1']);
      expect(settingKeysWithPrefix(db, 'nope:')).toEqual([]);
    });
  });

  describe('bot drops', () => {
    it('counts per site per day, by any increment', () => {
      expect(getBotDrops(db, 1, '2023-11-14')).toBe(0);
      write(() => {
        incrementBotDrops(db, 1, '2023-11-14');
        incrementBotDrops(db, 1, '2023-11-14', 4);
        incrementBotDrops(db, 1, '2023-11-15');
        incrementBotDrops(db, 2, '2023-11-14');
      });
      expect(getBotDrops(db, 1, '2023-11-14')).toBe(5);
      expect(getBotDrops(db, 1, '2023-11-15')).toBe(1);
      expect(getBotDrops(db, 2, '2023-11-14')).toBe(1);
    });

    it('lists counters since a local date, newest first', () => {
      write(() => {
        incrementBotDrops(db, 1, '2023-11-14', 2);
        incrementBotDrops(db, 1, '2023-11-15', 3);
        incrementBotDrops(db, 2, '2023-11-15', 1);
        incrementBotDrops(db, 1, '2023-10-01', 9);
      });
      expect(listBotDrops(db, '2023-11-14')).toEqual([
        { site_id: 1, local_date: '2023-11-15', count: 3 },
        { site_id: 2, local_date: '2023-11-15', count: 1 },
        { site_id: 1, local_date: '2023-11-14', count: 2 },
      ]);
    });
  });

  describe('dashboards', () => {
    const layout = (name: string): NewDashboard => ({
      name,
      site_scope: '1',
      layout: JSON.stringify({ name, site: 1, grid: [] }),
      updated_at: 1_700_000_000_000,
    });

    it('creates, lists, gets, updates and deletes', () => {
      const created = write(() => createDashboard(db, layout('Overview')));
      expect(created.id).toBeGreaterThan(0);
      expect(getDashboard(db, created.id)).toEqual(created);
      expect(listDashboards(db)).toEqual([created]);

      const updated = write(() =>
        updateDashboard(db, created.id, { ...layout('Renamed'), updated_at: 2 }),
      );
      expect(updated).toEqual({ ...layout('Renamed'), id: created.id, updated_at: 2 });
      expect(write(() => updateDashboard(db, 99, layout('Ghost')))).toBeUndefined();

      expect(write(() => deleteDashboard(db, created.id))).toBe(true);
      expect(getDashboard(db, created.id)).toBeUndefined();
      expect(write(() => deleteDashboard(db, created.id))).toBe(false);
    });

    it('deleting a dashboard removes its share tokens', () => {
      const created = write(() => createDashboard(db, layout('Shared')));
      const hash = new Uint8Array(32).fill(7);
      write(() =>
        insertShareToken(db, { token_hash: hash, dashboard_id: created.id, created_at: 1 }),
      );
      expect(getShareToken(db, hash)).toBeDefined();
      write(() => deleteDashboard(db, created.id));
      expect(getShareToken(db, hash)).toBeUndefined();
    });
  });

  describe('share tokens', () => {
    const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);

    it('round-trips and revokes per dashboard, only once', () => {
      write(() => {
        insertShareToken(db, { token_hash: hash(1), dashboard_id: 1, created_at: 10 });
        insertShareToken(db, { token_hash: hash(2), dashboard_id: 1, created_at: 20 });
        insertShareToken(db, { token_hash: hash(3), dashboard_id: 2, created_at: 30 });
      });
      expect(getShareToken(db, hash(1))).toEqual({
        token_hash: Buffer.from(hash(1)),
        dashboard_id: 1,
        created_at: 10,
        revoked_at: null,
      });
      expect(getShareToken(db, hash(9))).toBeUndefined();

      expect(write(() => revokeShareTokens(db, 1, 99))).toBe(2);
      expect(getShareToken(db, hash(1))?.revoked_at).toBe(99);
      expect(getShareToken(db, hash(2))?.revoked_at).toBe(99);
      expect(getShareToken(db, hash(3))?.revoked_at).toBeNull();
      // Already-revoked tokens keep their original revocation time.
      expect(write(() => revokeShareTokens(db, 1, 123))).toBe(0);
      expect(getShareToken(db, hash(1))?.revoked_at).toBe(99);
    });
  });

  describe('diagnostics gauges', () => {
    it('counts event rows and reports a positive page-math size', () => {
      expect(countEvents(db)).toBe(0);
      write(() => insertEvents(db, [event(), event({ seq: 2 })]));
      expect(countEvents(db)).toBe(2);
      expect(databaseSizeBytes(db)).toBeGreaterThan(0);
    });
  });

  describe('observeWriteTransactions', () => {
    it('times top-level write transactions only, until unsubscribed', () => {
      const seen: number[] = [];
      const unsubscribe = observeWriteTransactions(db, (ms) => seen.push(ms));

      write(() => withWriteTransaction(db, () => setSetting(db, 'k', 'v')));
      expect(seen).toHaveLength(1); // the nested transaction is not re-observed
      expect(seen[0]).toBeGreaterThanOrEqual(0);

      unsubscribe();
      write(() => setSetting(db, 'k', 'w'));
      expect(seen).toHaveLength(1);
    });
  });

  describe('withWriteTransaction', () => {
    it('rolls every write back when the body throws', () => {
      write(() => setSetting(db, 'keep', 'yes'));

      expect(() =>
        write(() => {
          createSite(db, { id: 1, name: 'Doomed', domains: ['doomed.test'] });
          insertEvents(db, [event()]);
          upsertSessions(db, [session()]);
          setSetting(db, 'keep', 'no');
          incrementBotDrops(db, 1, '2023-11-14');
          throw new Error('boom');
        }),
      ).toThrow('boom');

      expect(listSites(db)).toEqual([]);
      expect(db.prepare('SELECT count(*) FROM events').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(0);
      expect(getSetting(db, 'keep')).toBe('yes');
      expect(getBotDrops(db, 1, '2023-11-14')).toBe(0);
    });

    it('returns the body result and nests', () => {
      const result = write(() =>
        withWriteTransaction(db, () => {
          setSetting(db, 'nested', 'ok');
          return 42;
        }),
      );
      expect(result).toBe(42);
      expect(getSetting(db, 'nested')).toBe('ok');
    });

    it('rejects writes made outside it', () => {
      expect(() => setSetting(db, 'loose', 'nope')).toThrow(/withWriteTransaction/);
      expect(() => insertEvents(db, [event()])).toThrow(/withWriteTransaction/);
      expect(() => upsertSessions(db, [session()])).toThrow(/withWriteTransaction/);
      expect(() => createSite(db, { name: 'x', domains: [] })).toThrow(/withWriteTransaction/);
      expect(() => deleteSetting(db, 'loose')).toThrow(/withWriteTransaction/);
      expect(() => incrementBotDrops(db, 1, '2023-11-14')).toThrow(/withWriteTransaction/);
      expect(() =>
        createDashboard(db, { name: 'x', site_scope: 'all', layout: '{}', updated_at: 0 }),
      ).toThrow(/withWriteTransaction/);
      expect(() =>
        insertShareToken(db, { token_hash: new Uint8Array(32), dashboard_id: 1, created_at: 0 }),
      ).toThrow(/withWriteTransaction/);
      expect(() => revokeShareTokens(db, 1, 0)).toThrow(/withWriteTransaction/);
    });
  });
});
