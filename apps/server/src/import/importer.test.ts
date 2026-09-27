import { describe, expect, it } from 'vitest';
import { createSite, type Db, getSetting, openDb, withWriteTransaction } from '../db/index.ts';
import { importMatomo, parseSiteMap, type SourceQuery } from './importer.ts';
import type { MatomoActionRow, MatomoSiteRow, MatomoVisitRow } from './mappers.ts';

/**
 * Integration tests: the streaming adapter against an injected fake query
 * function (no live MySQL) that honors the importer's keyset pagination and
 * `--since` filters, into a real in-memory SQLite database.
 */

interface FakeData {
  sites: MatomoSiteRow[];
  siteUrls: Array<{ idsite: number; url: string }>;
  visits: MatomoVisitRow[];
  actions: MatomoActionRow[];
}

function fakeSource(data: FakeData): { source: SourceQuery; queries: string[] } {
  const queries: string[] = [];
  const source: SourceQuery = async (sql, params) => {
    queries.push(sql);
    if (sql.includes('matomo_site_url')) {
      const ids = params[0] as number[];
      return data.siteUrls.filter((row) => ids.includes(row.idsite)) as unknown as Array<
        Record<string, unknown>
      >;
    }
    if (sql.includes('matomo_log_link_visit_action')) {
      return page(data.actions, 'idlink_va', 'server_time', 'server_time', sql, params);
    }
    if (sql.includes('matomo_log_visit')) {
      // Matches the real SQL: since bounds the LAST action, until the FIRST.
      return page(
        data.visits,
        'idvisit',
        'visit_last_action_time',
        'visit_first_action_time',
        sql,
        params,
      );
    }
    return page(data.sites, 'idsite', null, null, sql, params);
  };
  return { source, queries };
}

/** `WHERE id > ? [AND since >= ?] [AND until < ?] ORDER BY id LIMIT ?`, in memory. */
function page(
  rows: ReadonlyArray<object>,
  idColumn: string,
  sinceColumn: string | null,
  untilColumn: string | null,
  sql: string,
  params: readonly unknown[],
): Array<Record<string, unknown>> {
  const after = params[0] as number;
  const hasSince = sql.includes('>= ?') && sinceColumn !== null;
  const hasUntil = sql.includes('< ?') && untilColumn !== null;
  const since = hasSince ? (params[1] as string) : undefined;
  const until = hasUntil ? (params[hasSince ? 2 : 1] as string) : undefined;
  const limit = params[params.length - 1] as number;
  return (rows as ReadonlyArray<Record<string, unknown>>)
    .filter(
      (row) =>
        (row[idColumn] as number) > after &&
        (since === undefined || String(row[sinceColumn ?? '']) >= since) &&
        (until === undefined || String(row[untilColumn ?? '']) < until),
    )
    .sort((a, b) => (a[idColumn] as number) - (b[idColumn] as number))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Fixtures — two sites, two visits, three actions
// ---------------------------------------------------------------------------

const VISITOR_A = Buffer.from('0123456789abcdef', 'hex');
const VISITOR_B = Buffer.from('fedcba9876543210', 'hex');

function siteRow(overrides: Partial<MatomoSiteRow> = {}): MatomoSiteRow {
  return {
    idsite: 1,
    name: 'One',
    main_url: 'https://one.test',
    ts_created: '2013-04-01 12:00:00',
    timezone: 'America/New_York',
    ...overrides,
  };
}

function visitRow(overrides: Partial<MatomoVisitRow> = {}): MatomoVisitRow {
  return {
    idvisit: 501,
    idsite: 1,
    idvisitor: VISITOR_A,
    // 02:00 UTC on Jul 2 = the evening of Jul 1 in New York
    visit_first_action_time: '2026-07-02 02:00:00',
    visit_last_action_time: '2026-07-02 02:05:00',
    visit_total_time: 300,
    visit_total_actions: 2,
    visit_total_events: 1,
    referer_type: 1,
    referer_name: null,
    referer_url: null,
    campaign_name: null,
    campaign_source: null,
    campaign_medium: null,
    config_browser_name: 'FF',
    config_browser_version: '128.0',
    config_os: 'MAC',
    config_device_type: 0,
    config_resolution: '2560x1440',
    location_browser_lang: 'en-us',
    location_country: 'us',
    location_region: 'MA',
    location_city: 'Boston',
    location_latitude: '42.36',
    location_longitude: '-71.06',
    entry_url_name: 'one.test/',
    entry_url_prefix: 2,
    exit_url_name: 'one.test/about',
    exit_url_prefix: 2,
    ...overrides,
  };
}

function actionRow(overrides: Partial<MatomoActionRow> = {}): MatomoActionRow {
  const visit = visitRow();
  const {
    idvisit,
    idsite,
    idvisitor,
    entry_url_name: _entry,
    entry_url_prefix: _entryPrefix,
    exit_url_name: _exit,
    exit_url_prefix: _exitPrefix,
    visit_first_action_time: _first,
    visit_last_action_time: _last,
    visit_total_time: _time,
    visit_total_actions: _actions,
    visit_total_events: _events,
    ...context
  } = visit;
  return {
    ...context,
    idlink_va: 9001,
    idvisit,
    idsite,
    idvisitor,
    server_time: '2026-07-02 02:00:00',
    custom_float: null,
    url_type: 1,
    url_name: 'one.test/',
    url_prefix: 2,
    name_type: 4,
    name_name: 'Home',
    event_category: null,
    event_action: null,
    ...overrides,
  };
}

function fixtures(): FakeData {
  return {
    sites: [
      siteRow(),
      siteRow({ idsite: 2, name: 'Two', main_url: 'https://two.test', timezone: 'UTC' }),
    ],
    siteUrls: [{ idsite: 1, url: 'https://www.one-alias.test' }],
    visits: [
      visitRow(),
      visitRow({
        idvisit: 502,
        idsite: 2,
        idvisitor: VISITOR_B,
        visit_first_action_time: '2026-07-02 09:00:00',
        visit_last_action_time: '2026-07-02 09:01:00',
        visit_total_actions: 1,
        visit_total_events: 0,
      }),
    ],
    actions: [
      actionRow(),
      actionRow({
        idlink_va: 9002,
        server_time: '2026-07-02 02:02:00',
        event_category: 'Video',
        event_action: 'play',
        name_type: 12,
        name_name: 'intro',
        custom_float: 2.5,
      }),
      actionRow({
        idlink_va: 9003,
        idvisit: 502,
        idsite: 2,
        idvisitor: VISITOR_B,
        server_time: '2026-07-02 09:00:00',
        url_name: 'two.test/page',
        name_name: 'Page',
      }),
    ],
  };
}

function count(db: Db, table: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

describe('importMatomo', () => {
  it('imports sites, sessions and events, recomputing local dates per site tz', async () => {
    const db = openDb(':memory:');
    const { source } = fakeSource(fixtures());
    const report = await importMatomo(db, source);

    expect(report).toMatchObject({ sites: 2, sitesSkipped: 0, sessions: 2, events: 3, skipped: 0 });

    const sites = db.prepare('SELECT id, name, domains FROM sites ORDER BY id').all() as Array<{
      id: number;
      name: string;
      domains: string;
    }>;
    expect(sites.map((s) => s.id)).toEqual([1, 2]);
    expect(JSON.parse(sites[0]?.domains ?? '')).toEqual(['one.test', 'www.one-alias.test']);

    const sessions = db
      .prepare('SELECT site_id, local_date, engaged_ms, pageviews FROM sessions ORDER BY site_id')
      .all();
    expect(sessions).toEqual([
      { site_id: 1, local_date: '2026-07-01', engaged_ms: 300_000, pageviews: 2 },
      { site_id: 2, local_date: '2026-07-02', engaged_ms: 300_000, pageviews: 1 },
    ]);

    const events = db
      .prepare('SELECT site_id, type, seq, local_date FROM events ORDER BY id')
      .all();
    expect(events).toEqual([
      { site_id: 1, type: 'pageview', seq: 1, local_date: '2026-07-01' },
      { site_id: 1, type: 'event', seq: 2, local_date: '2026-07-01' },
      { site_id: 2, type: 'pageview', seq: 1, local_date: '2026-07-02' },
    ]);

    expect(getSetting(db, 'import:matomo:log_visit')).toBe('502');
    expect(getSetting(db, 'import:matomo:log_link_visit_action')).toBe('9003');
    db.close();
  });

  it('is idempotent: a re-run against the same source imports nothing new', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    await importMatomo(db, fakeSource(data).source, { batchSize: 2 });
    const rerun = await importMatomo(db, fakeSource(data).source, { batchSize: 2 });

    expect(rerun).toMatchObject({ sites: 0, sitesSkipped: 2, sessions: 0, events: 0 });
    expect(count(db, 'sessions')).toBe(2);
    expect(count(db, 'events')).toBe(3);
    db.close();
  });

  it('tops up: new rows import, and a mid-visit boundary continues seq from the db', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    await importMatomo(db, fakeSource(data).source);

    // A later action for an already-imported visit, plus a whole new visit.
    data.actions.push(
      actionRow({
        idlink_va: 9004,
        server_time: '2026-07-02 02:04:00',
        url_name: 'one.test/about',
        name_name: 'About',
      }),
      actionRow({
        idlink_va: 9005,
        idvisit: 503,
        server_time: '2026-07-03 12:00:00',
        url_name: 'one.test/new',
        name_name: 'New',
      }),
    );
    data.visits.push(
      visitRow({
        idvisit: 503,
        visit_first_action_time: '2026-07-03 12:00:00',
        visit_last_action_time: '2026-07-03 12:00:30',
        visit_total_actions: 1,
        visit_total_events: 0,
      }),
    );

    const report = await importMatomo(db, fakeSource(data).source);
    expect(report).toMatchObject({ sessions: 1, events: 2 });
    expect(count(db, 'sessions')).toBe(3);
    expect(count(db, 'events')).toBe(5);

    const seqs = db
      .prepare('SELECT seq FROM events WHERE site_id = 1 AND local_date = ? ORDER BY id')
      .pluck()
      .all('2026-07-01');
    expect(seqs).toEqual([1, 2, 3]); // 9004 continued the stored sequence, not restarted
    db.close();
  });

  it('--dry-run maps and reports per-site/day totals without writing anything', async () => {
    const db = openDb(':memory:');
    const report = await importMatomo(db, fakeSource(fixtures()).source, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report).toMatchObject({ sites: 2, sessions: 2, events: 3 });
    expect(report.days).toEqual([
      { site_id: 1, local_date: '2026-07-01', visits: 1, pageviews: 1 },
      { site_id: 2, local_date: '2026-07-02', visits: 1, pageviews: 1 },
    ]);

    expect(count(db, 'sites')).toBe(0);
    expect(count(db, 'sessions')).toBe(0);
    expect(count(db, 'events')).toBe(0);
    expect(getSetting(db, 'import:matomo:log_visit')).toBeUndefined();
    db.close();
  });

  it('--since narrows the scan to visits and actions at or after the date', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    data.visits.push(
      visitRow({
        idvisit: 400,
        visit_first_action_time: '2026-06-01 10:00:00',
        visit_last_action_time: '2026-06-01 10:01:00',
      }),
    );
    data.actions.push(
      actionRow({ idlink_va: 8000, idvisit: 400, server_time: '2026-06-01 10:00:00' }),
    );

    const report = await importMatomo(db, fakeSource(data).source, { since: '2026-07-01' });
    expect(report).toMatchObject({ sessions: 2, events: 3 }); // June rows excluded
    expect(count(db, 'sessions')).toBe(2);
    db.close();
  });

  it('--until excludes the tee period, so live-ingested traffic is never imported twice', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    // Traffic recorded by Matomo AFTER the tee started (already ingested live here).
    data.visits.push(
      visitRow({
        idvisit: 700,
        visit_first_action_time: '2026-07-10 08:00:00',
        visit_last_action_time: '2026-07-10 08:05:00',
      }),
    );
    data.actions.push(
      actionRow({ idlink_va: 9900, idvisit: 700, server_time: '2026-07-10 08:00:00' }),
    );

    const report = await importMatomo(db, fakeSource(data).source, { until: '2026-07-10' });
    expect(report).toMatchObject({ sessions: 2, events: 3 }); // bake-period rows excluded
    expect(count(db, 'sessions')).toBe(2);
    expect(count(db, 'events')).toBe(3);
    db.close();
  });

  it('--since re-reads window visits: a session Matomo mutated mid-visit upserts to final state', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    await importMatomo(db, fakeSource(data).source);

    // Matomo mutates log_visit in place as the visit accrues actions.
    const visit = data.visits.find((v) => v.idvisit === 501);
    if (visit === undefined) throw new Error('fixture visit missing');
    visit.visit_total_time = 900;
    visit.visit_total_actions = 3;
    visit.visit_last_action_time = '2026-07-02 02:15:00';
    data.actions.push(
      actionRow({
        idlink_va: 9004,
        server_time: '2026-07-02 02:14:00',
        url_name: 'one.test/late',
        name_name: 'Late',
      }),
    );

    await importMatomo(db, fakeSource(data).source, { since: '2026-07-01' });
    expect(count(db, 'sessions')).toBe(2); // upserted in place, no duplicate
    expect(count(db, 'events')).toBe(4); // only the new action landed (watermark held)
    const engaged = db
      .prepare('SELECT engaged_ms FROM sessions WHERE site_id = 1')
      .pluck()
      .get() as number;
    expect(engaged).toBe(900_000); // the stale mid-visit 300s got repaired
    // The re-scan paged from 0 but must never lower the stored watermark.
    expect(getSetting(db, 'import:matomo:log_visit')).toBe('502');
    db.close();
  });

  it('streams in bounded batches without losing rows', async () => {
    const db = openDb(':memory:');
    const { source, queries } = fakeSource(fixtures());
    await importMatomo(db, source, { batchSize: 1 });

    expect(count(db, 'sessions')).toBe(2);
    expect(count(db, 'events')).toBe(3);
    const actionQueries = queries.filter((sql) => sql.includes('matomo_log_link_visit_action'));
    expect(actionQueries.length).toBeGreaterThanOrEqual(3); // 3 rows, one per batch
    db.close();
  });

  it('imports a manual-offset Matomo site on its mapped zone, local clocks included', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    data.sites[0] = siteRow({ timezone: 'UTC-3.5' });
    await importMatomo(db, fakeSource(data).source);

    expect(db.prepare('SELECT timezone FROM sites WHERE id = 1').pluck().get()).toBe('-0330');
    // 02:00 UTC on Jul 2, three and a half hours west: 22:30 on Jul 1.
    expect(
      db.prepare('SELECT local_date, local_hour FROM sessions WHERE site_id = 1').get(),
    ).toEqual({ local_date: '2026-07-01', local_hour: 22 });
    db.close();
  });

  it('refuses a Matomo timezone that maps to no zone, before writing any site', async () => {
    const db = openDb(':memory:');
    const data = fixtures();
    data.sites[1] = siteRow({ idsite: 2, timezone: 'Mars/Olympus_Mons' });
    await expect(importMatomo(db, fakeSource(data).source)).rejects.toThrow(/Matomo site 2/);
    expect(count(db, 'sites')).toBe(0);
    db.close();
  });

  it('keeps pre-existing sites untouched and skips visits for unknown sites', async () => {
    const db = openDb(':memory:');
    withWriteTransaction(db, () => {
      createSite(db, { id: 1, name: 'Local name', domains: ['one.test'] });
    });
    const data = fixtures();
    data.visits.push(visitRow({ idvisit: 600, idsite: 99 }));

    const report = await importMatomo(db, fakeSource(data).source);
    expect(report.sitesSkipped).toBe(1);
    expect(report.sites).toBe(1); // only site 2 created
    expect(report.skipped).toBe(1); // the idsite-99 visit
    expect(db.prepare('SELECT name FROM sites WHERE id = 1').pluck().get()).toBe('Local name');
    expect(count(db, 'sessions')).toBe(2);
    db.close();
  });

  describe('site id collisions', () => {
    function withUnrelatedSiteOne(): Db {
      const db = openDb(':memory:');
      withWriteTransaction(db, () => {
        createSite(db, { id: 1, name: 'Unrelated', domains: ['other.test'], timezone: 'UTC' });
      });
      return db;
    }

    it('refuses a Matomo id held by a local site sharing none of its domains', async () => {
      const db = withUnrelatedSiteOne();
      await expect(importMatomo(db, fakeSource(fixtures()).source)).rejects.toThrow(
        /Matomo site 1 'One' .* collides with local site 1 'Unrelated' \(other\.test\)/,
      );
      // All or nothing: not even the uncontested site 2 was created.
      expect(count(db, 'sites')).toBe(1);
      expect(count(db, 'sessions')).toBe(0);
      db.close();
    });

    it('--site-map moves the Matomo site to a free local id, and remembers it', async () => {
      const db = withUnrelatedSiteOne();
      const data = fixtures();
      await importMatomo(db, fakeSource(data).source, { siteMap: new Map([[1, 7]]) });

      expect(db.prepare('SELECT name FROM sites WHERE id = 7').pluck().get()).toBe('One');
      expect(db.prepare('SELECT DISTINCT site_id FROM events ORDER BY 1').pluck().all()).toEqual([
        2, 7,
      ]);
      expect(getSetting(db, 'import:matomo:site-map')).toBe('1:7');

      // A top-up without the flag still lands site 1's new visit on 7.
      data.visits.push(visitRow({ idvisit: 503, visit_first_action_time: '2026-07-03 12:00:00' }));
      await importMatomo(db, fakeSource(data).source);
      expect(db.prepare('SELECT site_id FROM sessions WHERE rowid = 3').pluck().get()).toBe(7);
      expect(db.prepare('SELECT COUNT(*) FROM sessions WHERE site_id = 1').pluck().get()).toBe(0);
      db.close();
    });

    it('n:n vouches for the same site: rows land on it, in its own zone', async () => {
      const db = withUnrelatedSiteOne();
      await importMatomo(db, fakeSource(fixtures()).source, { siteMap: new Map([[1, 1]]) });
      // 02:00 UTC stays Jul 2 in the local site's UTC, not Jul 1 as in New York.
      expect(db.prepare('SELECT local_date FROM sessions WHERE site_id = 1').pluck().get()).toBe(
        '2026-07-02',
      );
      expect(db.prepare('SELECT name FROM sites WHERE id = 1').pluck().get()).toBe('Unrelated');
      db.close();
    });

    it('refuses a map that contradicts the recorded one, or merges two sites', async () => {
      const db = withUnrelatedSiteOne();
      const { source } = fakeSource(fixtures());
      await importMatomo(db, source, { siteMap: new Map([[1, 7]]) });
      await expect(importMatomo(db, source, { siteMap: new Map([[1, 8]]) })).rejects.toThrow(
        /imported into local site 7/,
      );

      const fresh = openDb(':memory:');
      await expect(
        importMatomo(fresh, fakeSource(fixtures()).source, { siteMap: new Map([[1, 2]]) }),
      ).rejects.toThrow(/Matomo sites 1 and 2 both map to local site 2/);
      await expect(
        importMatomo(fresh, fakeSource(fixtures()).source, { siteMap: new Map([[9, 10]]) }),
      ).rejects.toThrow(/names Matomo site 9, which the source lacks/);
      fresh.close();
      db.close();
    });
  });
});

describe('parseSiteMap', () => {
  it('reads comma-separated matomo:local pairs', () => {
    expect(parseSiteMap('3:7, 4:8')).toEqual(
      new Map([
        [3, 7],
        [4, 8],
      ]),
    );
  });

  it('refuses malformed, zero and repeated entries', () => {
    expect(() => parseSiteMap('3-7')).toThrow(/<matomo id>:<local id>/);
    expect(() => parseSiteMap('0:7')).toThrow(/<matomo id>:<local id>/);
    expect(() => parseSiteMap('3:7,3:8')).toThrow(/Matomo site 3 twice/);
  });
});
