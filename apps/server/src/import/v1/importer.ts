import {
  type CampaignField,
  localClock,
  type QueryRequest,
  readStoredDashboard,
} from '@featherstat/shared';
import {
  countEvents,
  createSite,
  type Db,
  deleteSetting,
  type EventRow,
  getSetting,
  insertEvents,
  listSites,
  type SessionRow,
  schemaVersion,
  setSetting,
  settingKeysWithPrefix,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../../db/index.ts';
import { RETENTION_DAYS_KEY } from '../../jobs/retention.ts';
import { NTFY_SETTING_KEYS } from '../../notify/settings.ts';
import { AliasCache, type UtmNormalizer } from '../../pipeline/campaigns.ts';
import {
  cleanStoredPath,
  clickIdSource,
  parseStoredPath,
  type SynthesizedCampaign,
  synthesizedCampaign,
} from '../../pipeline/page-url.ts';
import { executeQueryRequest } from '../../query/executor.ts';
import { rebuildAllRollups } from '../../rollup/rebuild.ts';

/**
 * One-shot v1 → v2 importer (docs/06 § v1 → v2). Reads a featherstat v1 file
 * (schema versions 1–5) opened READONLY by the CLI and rewrites it into a
 * fresh v2 target — the counterpart of migrate.ts's refusal to migrate the v1
 * line in place. Mirrors the Matomo importer architecturally: streamed
 * batches, per-table watermarks in the target's `settings` for crash resume,
 * `--dry-run`, injected source.
 *
 * Runbook rule (docs/06): **stop v1 → import → start v2**. A still-writing v1
 * would fork history, which is why a non-empty target without a resume
 * watermark is refused rather than topped up — and why a completed import
 * clears its watermarks.
 *
 * What transfers: sites/events/sessions/bot_drops 1:1 (utm values through the
 * shared campaign normalizer — the importer and live ingest must not disagree
 * about what `utm_source = 'google'` means; stored paths and click-id
 * attribution through the shared page-url helpers for the same reason,
 * docs/03 § Page identity), the salt/uid/ntfy/retention
 * settings (salts imported = zero visitor discontinuity), and dashboards
 * (layouts carried through the `upgradeDashboard` chain). Dropped by design:
 * share_tokens (re-mint) and admin_sessions (re-login).
 */

const WATERMARK_PREFIX = 'import:v1:';
const DEFAULT_BATCH_SIZE = 5000;

// ---------------------------------------------------------------------------
// Source shape
// ---------------------------------------------------------------------------

/** Every v1 schema version has these; dashboards/share_tokens arrive at v3. */
const V1_REQUIRED_TABLES = ['sites', 'events', 'sessions', 'settings', 'bot_drops'] as const;
const V1_VERSION_MIN = 1;
const V1_VERSION_MAX = 5;

const SQL_HAS_TABLE = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?";

function hasTable(db: Db, name: string): boolean {
  return (stmt(db, SQL_HAS_TABLE).pluck().get(name) as number) > 0;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** Throws unless `source` looks like a featherstat v1 database. */
function assertV1Source(source: Db): void {
  const version = schemaVersion(source);
  if (version < V1_VERSION_MIN || version > V1_VERSION_MAX) {
    throw new Error(
      `source is not a featherstat v1 database: schema version ${version} ` +
        `(expected ${V1_VERSION_MIN}–${V1_VERSION_MAX})`,
    );
  }
  for (const table of V1_REQUIRED_TABLES) {
    if (!hasTable(source, table)) {
      throw new Error(`source is not a featherstat v1 database: missing table '${table}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface V1GateReport {
  ok: boolean;
  /** One line per mismatch — empty means every gate held. */
  failures: string[];
}

export interface V1ImportReport {
  dryRun: boolean;
  sites: number;
  /** Sites already present in the target (ids preserved, so a resume skips them). */
  sitesSkipped: number;
  events: number;
  sessions: number;
  botDropRows: number;
  /** Rows (events + sessions) where the campaign normalizer changed a utm value.
   * Per-day totals still hold — the gates never group by utm — but utm-grouped
   * numbers may differ from v1's by design when this is nonzero. */
  utmNormalized: number;
  /** Stored path values (event paths + session entry/exit paths) a tracking
   * param left at import (docs/03 § Page identity). Per-day totals still hold —
   * the gates never group by path — but path-grouped numbers merge v1's
   * per-click variants onto one page by design when this is nonzero. */
  pathsCleaned: number;
  /** Rows (events + sessions) with no utm whose stored path carried a click id,
   * so source/medium were synthesized from it (docs/03 § Attribution) — v1
   * booked these as direct/referral, v2 knows the platform. */
  attributionsSynthesized: number;
  settingsImported: string[];
  /** Settings outside the allowlist, reported by name and left behind. */
  settingsSkipped: string[];
  dashboards: number;
  /** Rows whose layout no vocabulary this build knows could carry forward. */
  dashboardsSkipped: number;
  /** Dropped by design: shares are re-minted, admins re-log-in. */
  droppedShareTokens: number;
  droppedAdminSessions: number;
  rollupDays: number;
  /** null on --dry-run (there is no target to validate). */
  gates: V1GateReport | null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface V1ImportOptions {
  /** Read + validate + report, write nothing (docs/06). */
  dryRun?: boolean;
  batchSize?: number;
  /** Per-step progress lines. */
  log?: (line: string) => void;
}

/** Whether a previous run left resume watermarks in `target`. */
function hasV1ImportWatermarks(target: Db): boolean {
  return settingKeysWithPrefix(target, WATERMARK_PREFIX).length > 0;
}

export async function importV1(
  target: Db,
  source: Db,
  options: V1ImportOptions = {},
): Promise<V1ImportReport> {
  assertV1Source(source);
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = options.log ?? (() => {});

  if (!dryRun && countEvents(target) > 0 && !hasV1ImportWatermarks(target)) {
    throw new Error(
      'target already has events and no v1 import to resume — import into a fresh ' +
        'file instead (runbook: stop v1 → import → start v2, docs/06)',
    );
  }

  // The TARGET's alias table (typically empty on a fresh import), so the
  // importer and live ingest share one normalizer and one alias source.
  const normalizer = new AliasCache(target).normalizer;

  const report: V1ImportReport = {
    dryRun,
    sites: 0,
    sitesSkipped: 0,
    events: 0,
    sessions: 0,
    botDropRows: 0,
    utmNormalized: 0,
    pathsCleaned: 0,
    attributionsSynthesized: 0,
    settingsImported: [],
    settingsSkipped: [],
    dashboards: 0,
    dashboardsSkipped: 0,
    droppedShareTokens: 0,
    droppedAdminSessions: 0,
    rollupDays: 0,
    gates: null,
  };

  importSites(target, source, report, dryRun);
  log(`sites: ${report.sites} imported, ${report.sitesSkipped} already present`);
  importEvents(target, source, report, normalizer, dryRun, batchSize);
  log(`events: ${report.events} imported`);
  importSessions(target, source, report, normalizer, dryRun, batchSize);
  log(`sessions: ${report.sessions} imported`);
  importBotDrops(target, source, report, dryRun);
  importSettings(target, source, report, dryRun);
  log(
    `settings: ${report.settingsImported.length} imported, ` +
      `${report.settingsSkipped.length} outside the allowlist`,
  );
  importDashboards(target, source, report, dryRun);
  log(`dashboards: ${report.dashboards} imported, ${report.dashboardsSkipped} unreadable`);

  report.droppedShareTokens = hasTable(source, 'share_tokens')
    ? (stmt(source, 'SELECT COUNT(*) FROM share_tokens').pluck().get() as number)
    : 0;
  report.droppedAdminSessions = hasTable(source, 'admin_sessions')
    ? (stmt(source, 'SELECT COUNT(*) FROM admin_sessions').pluck().get() as number)
    : 0;

  if (!dryRun) {
    // The importer inserts raw only; rollups are rebuilt from it wholesale.
    report.rollupDays = (await rebuildAllRollups(target)).days;
    log(`rollups: ${report.rollupDays} site-days rebuilt`);
    report.gates = runValidationGates(source, target);
    log(report.gates.ok ? 'validation gates: all held' : 'validation gates: FAILED');
    // Done: from here the file is a live v2 database, and the watermarks would
    // otherwise disarm the fresh-target refusal above forever. A failed gate
    // keeps them, so a re-run after investigating is a resume, not a refusal.
    if (report.gates.ok) {
      withWriteTransaction(target, () => {
        for (const key of settingKeysWithPrefix(target, WATERMARK_PREFIX)) {
          deleteSetting(target, key);
        }
      });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function watermark(db: Db, table: string): number {
  return Number(getSetting(db, WATERMARK_PREFIX + table) ?? 0);
}

function importSites(target: Db, source: Db, report: V1ImportReport, dryRun: boolean): void {
  const existing = new Set(listSites(target).map((site) => site.id));
  const rows = stmt<{
    id: number;
    name: string;
    domains: string;
    timezone: string;
    created_at: number;
  }>(
    source,
    'SELECT id, name, domains, timezone, created_at FROM sites ORDER BY id',
  ).all() as Array<{
    id: number;
    name: string;
    domains: string;
    timezone: string;
    created_at: number;
  }>;
  const created = rows.filter((row) => !existing.has(row.id));
  report.sites = created.length;
  report.sitesSkipped = rows.length - created.length;
  if (dryRun) return;
  withWriteTransaction(target, () => {
    for (const row of created) {
      createSite(target, { ...row, domains: JSON.parse(row.domains) as string[] });
    }
    setSetting(target, `${WATERMARK_PREFIX}sites`, String(rows.at(-1)?.id ?? 0));
  });
}

/** The three utm columns through the shared normalizer; raw kept only on change. */
function normalizedUtm(
  normalizer: UtmNormalizer,
  siteId: number,
  values: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null },
): {
  fields: Pick<
    EventRow,
    | 'utm_source'
    | 'utm_medium'
    | 'utm_campaign'
    | 'utm_source_raw'
    | 'utm_medium_raw'
    | 'utm_campaign_raw'
  >;
  changed: boolean;
} {
  const fields: ReturnType<typeof normalizedUtm>['fields'] = {
    utm_source: values.utm_source,
    utm_medium: values.utm_medium,
    utm_campaign: values.utm_campaign,
    utm_source_raw: null,
    utm_medium_raw: null,
    utm_campaign_raw: null,
  };
  let changed = false;
  const apply = (field: CampaignField, value: string | null) => {
    if (value === null) return { normalized: null, raw: null };
    const result = normalizer(siteId, field, value);
    if (result.raw !== undefined) changed = true;
    return { normalized: result.normalized, raw: result.raw ?? null };
  };
  const source = apply('source', values.utm_source);
  const medium = apply('medium', values.utm_medium);
  const campaign = apply('campaign', values.utm_campaign);
  fields.utm_source = source.normalized;
  fields.utm_source_raw = source.raw;
  fields.utm_medium = medium.normalized;
  fields.utm_medium_raw = medium.raw;
  fields.utm_campaign = campaign.normalized;
  fields.utm_campaign_raw = campaign.raw;
  return { fields, changed };
}

/**
 * The importer heals history the way live ingest now records it (docs/03
 * § Page identity): tracking params leave a stored path, and a row that has no
 * utm but carried a click id gets the same synthesized attribution live
 * ingest would give it — through the shared helpers, so the two cannot drift.
 */
function healedPath(stored: string | number | null, report: V1ImportReport): string | null {
  if (typeof stored !== 'string') return null;
  const cleaned = cleanStoredPath(stored);
  if (cleaned !== stored) report.pathsCleaned += 1;
  return cleaned;
}

/** Click-id attribution for a row with no utm at all, read from its stored path. */
function healedAttribution(
  stored: string | number | null,
  siteId: number,
  normalizer: UtmNormalizer,
  report: V1ImportReport,
): SynthesizedCampaign | undefined {
  if (typeof stored !== 'string') return undefined;
  const url = parseStoredPath(stored);
  const clicked = url === undefined ? undefined : clickIdSource(url.searchParams);
  if (clicked === undefined) return undefined;
  report.attributionsSynthesized += 1;
  return synthesizedCampaign(clicked, siteId, normalizer);
}

/** Every v1 events column; scroll_pct joined in when the source reached v5. */
const V1_EVENT_COLUMNS = [
  'site_id',
  'ts',
  'local_date',
  'local_hour',
  'type',
  'visitor_id',
  'session_id',
  'seq',
  'hostname',
  'path',
  'title',
  'target_url',
  'ref_domain',
  'ref_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'event_category',
  'event_action',
  'event_name',
  'event_value',
  'browser',
  'browser_version',
  'os',
  'device_type',
  'screen',
  'lang',
  'country',
  'region',
  'city',
  'lat',
  'lon',
] as const;

type V1EventSourceRow = { rid: number; scroll_pct: number | null } & {
  [K in (typeof V1_EVENT_COLUMNS)[number]]: K extends 'visitor_id' | 'session_id'
    ? Uint8Array
    : string | number | null;
};

function importEvents(
  target: Db,
  source: Db,
  report: V1ImportReport,
  normalizer: UtmNormalizer,
  dryRun: boolean,
  batchSize: number,
): void {
  const scroll = hasColumn(source, 'events', 'scroll_pct') ? 'scroll_pct' : 'NULL AS scroll_pct';
  // rowid order: new target rowids, source order preserved.
  const sql = `SELECT id AS rid, ${V1_EVENT_COLUMNS.join(', ')}, ${scroll}
FROM events WHERE id > ? ORDER BY id LIMIT ?`;
  let cursor = dryRun ? 0 : watermark(target, 'events');
  for (;;) {
    const rows = stmt<V1EventSourceRow>(source, sql).all(cursor, batchSize) as V1EventSourceRow[];
    const last = rows.at(-1);
    if (last === undefined) return;
    const mapped: EventRow[] = rows.map((row) => {
      const { rid: _rid, utm_source, utm_medium, utm_campaign, ...shared } = row;
      const path = healedPath(row.path, report);
      const noUtm = utm_source === null && utm_medium === null && utm_campaign === null;
      const derived = noUtm
        ? healedAttribution(row.path, row.site_id as number, normalizer, report)
        : undefined;
      if (derived !== undefined) {
        return { ...shared, path, ref_type: 'campaign', ...derived } as EventRow;
      }
      const utm = normalizedUtm(normalizer, row.site_id as number, {
        utm_source: utm_source as string | null,
        utm_medium: utm_medium as string | null,
        utm_campaign: utm_campaign as string | null,
      });
      if (utm.changed) report.utmNormalized += 1;
      return { ...shared, path, ...utm.fields } as EventRow;
    });
    report.events += mapped.length;
    if (!dryRun) {
      withWriteTransaction(target, () => {
        insertEvents(target, mapped);
        setSetting(target, `${WATERMARK_PREFIX}events`, String(last.rid));
      });
    }
    if (rows.length < batchSize) return;
    cursor = last.rid;
  }
}

const V1_SESSION_COLUMNS = [
  'id',
  'site_id',
  'visitor_id',
  'started_at',
  'last_seen_at',
  'local_date',
  'entry_path',
  'exit_path',
  'pageviews',
  'events',
  'engaged_ms',
  'ref_domain',
  'ref_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'browser',
  'os',
  'device_type',
  'country',
  'region',
  'city',
] as const;

type V1SessionSourceRow = { rid: number } & {
  [K in (typeof V1_SESSION_COLUMNS)[number]]: K extends 'id' | 'visitor_id'
    ? Uint8Array
    : string | number | null;
};

/**
 * Site timezones from the source, for the one column a v1 session cannot
 * supply: `local_hour`. v1 dated a visit but never gave it an hour, so the
 * rewrite derives it the way ingest does — from `started_at` in the site's own
 * zone (docs/03 § Timezones).
 */
function sourceTimezones(source: Db): Map<number, string> {
  const rows = stmt<{ id: number; timezone: string }>(
    source,
    'SELECT id, timezone FROM sites',
  ).all() as { id: number; timezone: string }[];
  return new Map(rows.map((row) => [row.id, row.timezone]));
}

function importSessions(
  target: Db,
  source: Db,
  report: V1ImportReport,
  normalizer: UtmNormalizer,
  dryRun: boolean,
  batchSize: number,
): void {
  const timezones = sourceTimezones(source);
  // Sessions key on a blob id, so the cursor is the source table's rowid; the
  // upsert makes a re-read of any row idempotent.
  const sql = `SELECT rowid AS rid, ${V1_SESSION_COLUMNS.join(', ')}
FROM sessions WHERE rowid > ? ORDER BY rowid LIMIT ?`;
  let cursor = dryRun ? 0 : watermark(target, 'sessions');
  for (;;) {
    const rows = stmt<V1SessionSourceRow>(source, sql).all(
      cursor,
      batchSize,
    ) as V1SessionSourceRow[];
    const last = rows.at(-1);
    if (last === undefined) return;
    const mapped: SessionRow[] = rows.map((row) => {
      const { rid: _rid, utm_source, utm_medium, utm_campaign, ...rest } = row;
      const zone = timezones.get(row.site_id as number) ?? 'UTC';
      const shared = { ...rest, local_hour: localClock(zone, row.started_at as number).hour };
      const entry_path = healedPath(row.entry_path, report);
      const exit_path = healedPath(row.exit_path, report);
      const noUtm = utm_source === null && utm_medium === null && utm_campaign === null;
      // First-touch attribution reads the session's first page, i.e. its entry.
      const derived = noUtm
        ? healedAttribution(row.entry_path, row.site_id as number, normalizer, report)
        : undefined;
      if (derived !== undefined) {
        return { ...shared, entry_path, exit_path, ref_type: 'campaign', ...derived } as SessionRow;
      }
      const utm = normalizedUtm(normalizer, row.site_id as number, {
        utm_source: utm_source as string | null,
        utm_medium: utm_medium as string | null,
        utm_campaign: utm_campaign as string | null,
      });
      if (utm.changed) report.utmNormalized += 1;
      return { ...shared, entry_path, exit_path, ...utm.fields } as SessionRow;
    });
    report.sessions += mapped.length;
    if (!dryRun) {
      withWriteTransaction(target, () => {
        upsertSessions(target, mapped);
        setSetting(target, `${WATERMARK_PREFIX}sessions`, String(last.rid));
      });
    }
    if (rows.length < batchSize) return;
    cursor = last.rid;
  }
}

const SQL_UPSERT_BOT_DROPS = `INSERT INTO bot_drops (site_id, local_date, count) VALUES (?, ?, ?)
ON CONFLICT (site_id, local_date) DO UPDATE SET count = excluded.count`;

function importBotDrops(target: Db, source: Db, report: V1ImportReport, dryRun: boolean): void {
  const rows = stmt<{ site_id: number; local_date: string; count: number }>(
    source,
    'SELECT site_id, local_date, count FROM bot_drops ORDER BY site_id, local_date',
  ).all() as Array<{ site_id: number; local_date: string; count: number }>;
  report.botDropRows = rows.length;
  if (dryRun || rows.length === 0) return;
  // The upsert REPLACES the count, so a resume re-run converges instead of doubling.
  withWriteTransaction(target, () => {
    for (const row of rows) {
      stmt(target, SQL_UPSERT_BOT_DROPS).run(row.site_id, row.local_date, row.count);
    }
  });
}

/** Prefix-allowlisted settings: identity salts — imported salts mean the same
 * hash scheme keeps answering, so visitors carry across the cutover unbroken. */
const SETTING_PREFIX_ALLOWLIST = ['salt:', 'uidsalt:', 'uid_enabled:'] as const;
/** Exact-key allowlist: notification config and the retention horizon. */
const SETTING_KEY_ALLOWLIST: readonly string[] = [
  ...Object.values(NTFY_SETTING_KEYS),
  RETENTION_DAYS_KEY,
];

function settingAllowed(key: string): boolean {
  return (
    SETTING_KEY_ALLOWLIST.includes(key) ||
    SETTING_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))
  );
}

function importSettings(target: Db, source: Db, report: V1ImportReport, dryRun: boolean): void {
  const rows = stmt<{ key: string; value: string | null }>(
    source,
    'SELECT key, value FROM settings ORDER BY key',
  ).all() as Array<{ key: string; value: string | null }>;
  const imported = rows.filter((row) => settingAllowed(row.key) && row.value !== null);
  report.settingsImported = imported.map((row) => row.key);
  report.settingsSkipped = rows.filter((row) => !settingAllowed(row.key)).map((row) => row.key);
  if (dryRun || imported.length === 0) return;
  withWriteTransaction(target, () => {
    for (const row of imported) setSetting(target, row.key, row.value as string);
  });
}

const SQL_INSERT_DASHBOARD = `INSERT INTO dashboards
  (name, site_scope, layout, template, sort_order, created_at, updated_at)
VALUES (?, ?, ?, NULL, ?, ?, ?)`;

function importDashboards(target: Db, source: Db, report: V1ImportReport, dryRun: boolean): void {
  if (!hasTable(source, 'dashboards')) return; // source froze before schema v3
  const rows = stmt<{
    id: number;
    name: string;
    site_scope: string;
    layout: string;
    updated_at: number;
  }>(
    source,
    'SELECT id, name, site_scope, layout, updated_at FROM dashboards WHERE id > ? ORDER BY id',
  ).all(dryRun ? 0 : watermark(target, 'dashboards')) as Array<{
    id: number;
    name: string;
    site_scope: string;
    layout: string;
    updated_at: number;
  }>;
  const last = rows.at(-1);
  if (last === undefined) return;
  const upgraded: Array<{ row: (typeof rows)[number]; layout: string }> = [];
  for (const row of rows) {
    // The one way a stored layout crosses a vocabulary change: parse, carry
    // forward through the upgrade chain, re-validate (packages/shared/layout.ts).
    const dashboard = readStoredDashboard(row.layout);
    if (dashboard === undefined) {
      report.dashboardsSkipped += 1;
      continue;
    }
    upgraded.push({ row, layout: JSON.stringify(dashboard) });
  }
  report.dashboards = upgraded.length;
  if (dryRun) return;
  withWriteTransaction(target, () => {
    for (const { row, layout } of upgraded) {
      // sort_order carries the v1 id: the library lists them in the order the
      // operator made them. created_at = v1 updated_at, the best date v1 kept.
      stmt(target, SQL_INSERT_DASHBOARD).run(
        row.name,
        row.site_scope,
        layout,
        row.id,
        row.updated_at,
        row.updated_at,
      );
    }
    setSetting(target, `${WATERMARK_PREFIX}dashboards`, String(last.id));
  });
}

// ---------------------------------------------------------------------------
// Validation gates — IDENTICAL SQL run on both files, diffed to zero
// (docs/06 § v1 → v2). utm normalization may change utm values, but nothing
// below groups by utm, so these totals must hold exactly.
// ---------------------------------------------------------------------------

const GATE_TABLES = ['sites', 'events', 'sessions', 'bot_drops'] as const;

const GATE_EVENT_DAYS = `SELECT site_id, local_date,
  COUNT(DISTINCT CASE WHEN type != 'ping' THEN session_id END) AS visits,
  SUM(type = 'pageview') AS pageviews,
  SUM(type = 'event') AS events,
  COUNT(DISTINCT CASE WHEN type != 'ping' THEN visitor_id END) AS visitors
FROM events GROUP BY site_id, local_date ORDER BY site_id, local_date`;

const GATE_SESSION_DAYS = `SELECT site_id, local_date,
  COUNT(*) AS sessions, SUM(engaged_ms) AS engaged_ms
FROM sessions GROUP BY site_id, local_date ORDER BY site_id, local_date`;

type GateRow = Record<string, string | number | null>;

function diffDayRows(name: string, a: GateRow[], b: GateRow[], failures: string[]): void {
  const key = (row: GateRow) => `${row.site_id}/${row.local_date}`;
  const bByKey = new Map(b.map((row) => [key(row), row]));
  for (const row of a) {
    const other = bByKey.get(key(row));
    if (other === undefined) {
      failures.push(`${name}: target has no rows for site ${row.site_id} ${row.local_date}`);
      continue;
    }
    bByKey.delete(key(row));
    for (const column of Object.keys(row)) {
      if (row[column] !== other[column]) {
        failures.push(
          `${name}: site ${row.site_id} ${row.local_date} ${column} ` +
            `source=${row[column]} target=${other[column]}`,
        );
      }
    }
  }
  for (const leftover of bByKey.keys()) {
    failures.push(`${name}: target has extra rows for ${leftover}`);
  }
}

/**
 * Spot-check: representative v2 queries answered by `executeQueryRequest` on
 * the target (through the planner, so rollups answer where they should), with
 * every expected number recomputed from the SOURCE file by direct SQL.
 */
function runSpotChecks(source: Db, target: Db, failures: string[]): void {
  const range = stmt<{ from: string; to: string }>(
    source,
    'SELECT MIN(local_date) AS "from", MAX(local_date) AS "to" FROM events',
  ).get();
  if (range === undefined || range.from === null) return; // an empty v1 file has nothing to check
  const siteIds = stmt(source, 'SELECT DISTINCT site_id FROM events ORDER BY site_id')
    .pluck()
    .all() as number[];
  const site = siteIds[0];
  if (site === undefined) return;

  const request: QueryRequest = {
    site,
    range: { from: range.from, to: range.to },
    queries: [
      { id: 'totals', metrics: ['pageviews', 'visits'] },
      { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 1000 },
      { id: 'daily', metrics: ['visits'], bucket: 'day' },
    ],
  };
  const response = executeQueryRequest(target, request);

  const expectRows = (id: string): GateRow[] => {
    const entry = response.results[id];
    if (entry === undefined || 'error' in entry) {
      failures.push(`spot-check ${id}: query errored (${JSON.stringify(entry)})`);
      return [];
    }
    return entry.rows as GateRow[];
  };

  // 1 — totals: pageviews from events, visits from sessions, first site, full range.
  const totals = expectRows('totals')[0] ?? {};
  const expectedPageviews = stmt(
    source,
    "SELECT COUNT(*) FROM events WHERE site_id = ? AND type = 'pageview' AND local_date BETWEEN ? AND ?",
  )
    .pluck()
    .get(site, range.from, range.to) as number;
  const expectedVisits = stmt(
    source,
    'SELECT COUNT(*) FROM sessions WHERE site_id = ? AND local_date BETWEEN ? AND ?',
  )
    .pluck()
    .get(site, range.from, range.to) as number;
  if (totals.pageviews !== expectedPageviews || totals.visits !== expectedVisits) {
    failures.push(
      `spot-check totals: got pageviews=${totals.pageviews} visits=${totals.visits}, ` +
        `source says pageviews=${expectedPageviews} visits=${expectedVisits}`,
    );
  }

  // 2 — a breakdown: pageviews by path, compared as value maps. The source
  // side aggregates through the same path cleaning the import applied (like
  // the utm caveat above): v1's per-click variants merge onto one page, and
  // the merged totals must still match exactly.
  const expectedPages = new Map<string | null, number>();
  for (const row of stmt<{ path: string | null; n: number }>(
    source,
    `SELECT path, COUNT(*) AS n FROM events
WHERE site_id = ? AND type = 'pageview' AND local_date BETWEEN ? AND ? GROUP BY path`,
  ).all(site, range.from, range.to) as Array<{ path: string | null; n: number }>) {
    const path = row.path === null ? null : cleanStoredPath(row.path);
    expectedPages.set(path, (expectedPages.get(path) ?? 0) + row.n);
  }
  for (const row of expectRows('pages')) {
    if (expectedPages.get(row.path as string) !== row.pageviews) {
      failures.push(
        `spot-check pages: path ${row.path} pageviews=${row.pageviews}, ` +
          `source says ${expectedPages.get(row.path as string)}`,
      );
    }
    expectedPages.delete(row.path as string);
  }
  for (const [path, n] of expectedPages) {
    failures.push(`spot-check pages: source path ${path} (${n} pageviews) missing from target`);
  }

  // 3 — a timeseries: visits per day. The bucket axis may be dense, so a
  // zero-valued row for a day the source has no sessions on is not a mismatch.
  const expectedDaily = new Map(
    (
      stmt<{ local_date: string; n: number }>(
        source,
        `SELECT local_date, COUNT(*) AS n FROM sessions
WHERE site_id = ? AND local_date BETWEEN ? AND ? GROUP BY local_date`,
      ).all(site, range.from, range.to) as Array<{ local_date: string; n: number }>
    ).map((row) => [row.local_date, row.n]),
  );
  for (const row of expectRows('daily')) {
    const expected = expectedDaily.get(row.bucket as string) ?? 0;
    if ((row.visits ?? 0) !== expected) {
      failures.push(
        `spot-check daily: ${row.bucket} visits=${row.visits}, source says ${expected}`,
      );
    }
    expectedDaily.delete(row.bucket as string);
  }
  for (const [date, n] of expectedDaily) {
    failures.push(`spot-check daily: source day ${date} (${n} visits) missing from target`);
  }
}

function runValidationGates(source: Db, target: Db): V1GateReport {
  const failures: string[] = [];
  for (const table of GATE_TABLES) {
    const sql = `SELECT COUNT(*) FROM ${table}`;
    const a = stmt(source, sql).pluck().get() as number;
    const b = stmt(target, sql).pluck().get() as number;
    if (a !== b) failures.push(`row count: ${table} source=${a} target=${b}`);
  }
  diffDayRows(
    'events per day',
    stmt<GateRow>(source, GATE_EVENT_DAYS).all() as GateRow[],
    stmt<GateRow>(target, GATE_EVENT_DAYS).all() as GateRow[],
    failures,
  );
  diffDayRows(
    'sessions per day',
    stmt<GateRow>(source, GATE_SESSION_DAYS).all() as GateRow[],
    stmt<GateRow>(target, GATE_SESSION_DAYS).all() as GateRow[],
    failures,
  );
  runSpotChecks(source, target, failures);
  return { ok: failures.length === 0, failures };
}
