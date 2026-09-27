import { DASHBOARD_LAYOUT_VERSION, type Dashboard } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { createSeededV1Db, V1_FIXTURE } from '../../../test/v1-fixture.ts';
import {
  countEvents,
  createSite,
  type Db,
  getSetting,
  insertEvents,
  listDashboards,
  migrate,
  openDb,
  replaceCampaignAliases,
  settingKeysWithPrefix,
  V1_IMPORT_SUBCOMMAND,
  withWriteTransaction,
} from '../../db/index.ts';
import { verifyRollupDay } from '../../rollup/verify.ts';
import { importV1 } from './importer.ts';

/**
 * The v1 → v2 importer against the generated miniature v1 fixture — a real v1
 * schema (the five historical migrations verbatim) seeded deterministically,
 * so there is no binary golden to rot.
 */

function count(db: Db, table: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

async function imported(): Promise<{ source: Db; target: Db }> {
  const source = createSeededV1Db();
  const target = openDb(':memory:');
  const report = await importV1(target, source);
  expect(report.gates?.ok).toBe(true);
  return { source, target };
}

describe('importV1', () => {
  it('imports everything, and every validation gate holds', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    const report = await importV1(target, source);

    expect(report).toMatchObject({
      dryRun: false,
      sites: V1_FIXTURE.sites,
      sitesSkipped: 0,
      events: V1_FIXTURE.events,
      sessions: V1_FIXTURE.sessions,
      botDropRows: V1_FIXTURE.botDropDays,
      pathsCleaned: V1_FIXTURE.pathsCleaned,
      attributionsSynthesized: V1_FIXTURE.attributionsSynthesized,
      dashboards: V1_FIXTURE.dashboards,
      dashboardsSkipped: 0,
      droppedShareTokens: V1_FIXTURE.shareTokens,
      droppedAdminSessions: V1_FIXTURE.adminSessions,
    });
    expect(report.gates).toEqual({ ok: true, failures: [] });

    expect(count(target, 'events')).toBe(V1_FIXTURE.events);
    expect(count(target, 'sessions')).toBe(V1_FIXTURE.sessions);
    expect(count(target, 'sites')).toBe(V1_FIXTURE.sites);
    expect(count(target, 'bot_drops')).toBe(V1_FIXTURE.botDropDays);

    // Order preserved: rowid order in, rowid order out.
    const firstEvent = target
      .prepare('SELECT path, seq, scroll_pct FROM events ORDER BY id LIMIT 1')
      .get();
    expect(firstEvent).toEqual({ path: '/', seq: 1, scroll_pct: null });
    // scroll_pct rides across (source was at schema v5, which has the column).
    expect(
      target.prepare('SELECT COUNT(*) FROM events WHERE scroll_pct IS NOT NULL').pluck().get(),
    ).toBe(2);

    target.close();
    source.close();
  });

  it('imports the salts verbatim — zero visitor discontinuity', async () => {
    const { source, target } = await imported();
    for (const [key, value] of Object.entries(V1_FIXTURE.settings)) {
      expect(getSetting(target, key), key).toBe(value);
    }
    target.close();
    source.close();
  });

  it('allowlists settings, reporting everything else skipped by name', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    const report = await importV1(target, source);

    expect(report.settingsImported.sort()).toEqual(Object.keys(V1_FIXTURE.settings).sort());
    for (const key of V1_FIXTURE.skippedSettings) {
      expect(report.settingsSkipped).toContain(key);
      expect(getSetting(target, key)).toBeUndefined();
    }
    target.close();
    source.close();
  });

  it('normalizes utm values through the shared normalizer, keeping raw only on change', async () => {
    const { source, target } = await imported();
    const row = target
      .prepare(
        "SELECT utm_source, utm_source_raw, utm_medium, utm_medium_raw FROM events WHERE utm_source_raw = 'Google ' LIMIT 1",
      )
      .get();
    expect(row).toEqual({
      utm_source: 'google',
      utm_source_raw: 'Google ',
      utm_medium: 'cpc',
      utm_medium_raw: 'CPC',
    });
    // Already-canonical values keep a NULL raw column.
    const canonical = target
      .prepare("SELECT utm_source_raw FROM events WHERE utm_source = 'newsletter'")
      .pluck()
      .get();
    expect(canonical).toBeNull();
    target.close();
    source.close();
  });

  it('heals history: cleans tracking params from paths and synthesizes click-id attribution', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    const report = await importV1(target, source);
    expect(report.gates?.ok).toBe(true);
    expect(report.pathsCleaned).toBe(V1_FIXTURE.pathsCleaned);
    expect(report.attributionsSynthesized).toBe(V1_FIXTURE.attributionsSynthesized);

    // v1 stored '/blog?fbclid=IwAR1fixture' as a distinct, direct page; the
    // import stores the clean page identity with facebook/social first-touch.
    expect(
      target.prepare("SELECT COUNT(*) FROM events WHERE path LIKE '%fbclid%'").pluck().get(),
      'events',
    ).toBe(0);
    const event = target
      .prepare(
        "SELECT path, ref_type, utm_source, utm_medium, utm_campaign, utm_source_raw FROM events WHERE path = '/blog'",
      )
      .get();
    expect(event).toEqual({
      path: '/blog',
      ref_type: 'campaign',
      utm_source: 'facebook',
      utm_medium: 'social',
      utm_campaign: null, // never invented
      utm_source_raw: null, // synthesized: nothing was normalized away
    });
    const session = target
      .prepare(
        "SELECT entry_path, exit_path, ref_type, utm_source, utm_medium FROM sessions WHERE entry_path = '/blog'",
      )
      .get();
    expect(session).toEqual({
      entry_path: '/blog',
      exit_path: '/blog',
      ref_type: 'campaign',
      utm_source: 'facebook',
      utm_medium: 'social',
    });
    target.close();
    source.close();
  });

  it('applies the TARGET alias table, so importer and live ingest agree', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    withWriteTransaction(target, () => {
      replaceCampaignAliases(target, 0, [
        { field: 'source', alias: 'adwords', canonical: 'google' },
      ]);
    });
    const report = await importV1(target, source);
    expect(report.gates?.ok).toBe(true); // per-day gates never group by utm

    const aliased = target
      .prepare("SELECT utm_source, utm_source_raw FROM events WHERE utm_source_raw = 'AdWords'")
      .get();
    expect(aliased).toEqual({ utm_source: 'google', utm_source_raw: 'AdWords' });
    const session = target
      .prepare("SELECT utm_source FROM sessions WHERE utm_source_raw = 'AdWords'")
      .pluck()
      .get();
    expect(session).toBe('google');
    expect(report.utmNormalized).toBeGreaterThan(0);
    target.close();
    source.close();
  });

  it('upgrades dashboards through the layout chain and carries their identity', async () => {
    const { source, target } = await imported();
    const rows = listDashboards(target);
    expect(rows.map((row) => row.name)).toEqual(['Overview', 'All sites']);
    expect(rows.map((row) => row.sort_order)).toEqual([1, 2]); // the v1 ids
    expect(rows.every((row) => row.template === null)).toBe(true);
    // created_at carries the v1 updated_at — the only date v1 kept.
    expect(rows.map((row) => row.created_at)).toEqual(rows.map((row) => row.updated_at));

    const overview = JSON.parse(rows[0]?.layout ?? '') as Dashboard;
    expect(overview.version).toBe(DASHBOARD_LAYOUT_VERSION);
    const kpis = overview.grid.find((spec) => spec.id === 'kpis');
    const metrics = kpis?.query !== undefined && 'metrics' in kpis.query ? kpis.query.metrics : [];
    // The upgrade chain's work: engaged_ms pulls in both companion metrics.
    expect(metrics).toContain('engaged_sessions');
    expect(metrics).toContain('avg_engagement');
    target.close();
    source.close();
  });

  it('drops share tokens and admin sessions by design', async () => {
    const { source, target } = await imported();
    expect(count(target, 'share_tokens')).toBe(0);
    expect(count(target, 'admin_sessions')).toBe(0);
    target.close();
    source.close();
  });

  it('rebuilds rollups the verifier finds clean', async () => {
    const { source, target } = await imported();
    expect(count(target, 'rollup_dim_day')).toBeGreaterThan(0);
    expect(count(target, 'rollup_sessions_day')).toBeGreaterThan(0);
    for (const day of V1_FIXTURE.days) {
      expect(verifyRollupDay(target, 1, day)).toEqual([]);
      expect(verifyRollupDay(target, 2, day)).toEqual([]);
    }
    target.close();
    source.close();
  });

  it('resumes a crashed run at its watermarks and duplicates nothing', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    // Every row lands, then the rollup rebuild dies: the state a crash leaves.
    target.exec(`CREATE TRIGGER crash BEFORE INSERT ON rollup_dim_day
      BEGIN SELECT RAISE(ABORT, 'crash mid-rebuild'); END`);
    await expect(importV1(target, source)).rejects.toThrow('crash mid-rebuild');
    expect(settingKeysWithPrefix(target, 'import:v1:').length).toBeGreaterThan(0);
    target.exec('DROP TRIGGER crash');

    const rerun = await importV1(target, source);

    expect(rerun).toMatchObject({
      sites: 0,
      sitesSkipped: V1_FIXTURE.sites,
      events: 0,
      sessions: 0,
      dashboards: 0,
    });
    expect(rerun.gates?.ok).toBe(true);
    expect(count(target, 'events')).toBe(V1_FIXTURE.events);
    expect(count(target, 'sessions')).toBe(V1_FIXTURE.sessions);
    expect(count(target, 'dashboards')).toBe(V1_FIXTURE.dashboards);
    expect(target.prepare('SELECT SUM(count) FROM bot_drops').pluck().get()).toBe(10);
    target.close();
    source.close();
  });

  it('clears its watermarks once complete, so the finished file refuses a second import', async () => {
    const { source, target } = await imported();
    expect(settingKeysWithPrefix(target, 'import:v1:')).toEqual([]);

    await expect(importV1(target, source)).rejects.toThrow(/stop v1 → import → start v2/);
    expect(count(target, 'events')).toBe(V1_FIXTURE.events);
    target.close();
    source.close();
  });

  it('streams in bounded batches without losing rows', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    const report = await importV1(target, source, { batchSize: 3 });
    expect(report.gates?.ok).toBe(true);
    expect(count(target, 'events')).toBe(V1_FIXTURE.events);
    expect(count(target, 'sessions')).toBe(V1_FIXTURE.sessions);
    target.close();
    source.close();
  });

  it('refuses a non-empty target with no import to resume', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    withWriteTransaction(target, () => {
      createSite(target, { id: 9, name: 'Live', domains: ['live.test'] });
      insertEvents(target, [
        {
          site_id: 9,
          ts: Date.UTC(2026, 6, 1),
          local_date: '2026-07-01',
          local_hour: 0,
          type: 'pageview',
          visitor_id: new Uint8Array(8).fill(7),
          session_id: new Uint8Array(8).fill(8),
          seq: 1,
        },
      ]);
    });
    await expect(importV1(target, source)).rejects.toThrow(/stop v1 → import → start v2/);
    expect(countEvents(target)).toBe(1); // untouched
    target.close();
    source.close();
  });

  it('--dry-run reads and reports but writes nothing', async () => {
    const source = createSeededV1Db();
    const target = openDb(':memory:');
    const report = await importV1(target, source, { dryRun: true });

    expect(report).toMatchObject({
      dryRun: true,
      sites: V1_FIXTURE.sites,
      events: V1_FIXTURE.events,
      sessions: V1_FIXTURE.sessions,
      dashboards: V1_FIXTURE.dashboards,
      gates: null,
    });
    expect(count(target, 'sites')).toBe(0);
    expect(count(target, 'events')).toBe(0);
    expect(count(target, 'sessions')).toBe(0);
    // No watermarks either — counting the importer's own keys, since migrating
    // a fresh target already leaves settings rows of its own behind.
    expect(settingKeysWithPrefix(target, 'import:v1:')).toEqual([]);
    target.close();
    source.close();
  });

  it('refuses a source that is not a v1 database', async () => {
    const v2 = openDb(':memory:');
    const target = openDb(':memory:');
    await expect(importV1(target, v2)).rejects.toThrow(/not a featherstat v1 database/);
    target.close();
    v2.close();
  });
});

describe('the migrate refusal and the CLI agree', () => {
  it("migrate's v1 error names exactly the subcommand the CLI registers", () => {
    const v1 = createSeededV1Db();
    // Both sides read V1_IMPORT_SUBCOMMAND, so this cannot drift — the test
    // pins the full user-facing instruction anyway, against a manual rewrite.
    expect(() => migrate(v1)).toThrow(`run \`featherstat import ${V1_IMPORT_SUBCOMMAND} <path>\``);
    expect(V1_IMPORT_SUBCOMMAND).toBe('v1');
    v1.close();
  });
});
