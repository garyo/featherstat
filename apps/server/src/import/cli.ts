import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, V1_IMPORT_SUBCOMMAND } from '../db/index.ts';
import { type ImportReport, importMatomo, parseSiteMap, type SourceQuery } from './importer.ts';
import { importV1, type V1ImportReport } from './v1/importer.ts';

/**
 * One-shot importer CLI. Two sources, dispatched on the first positional:
 *
 *   # Matomo (docs/06 § Importer) — the default when no subcommand is given:
 *   MATOMO_MYSQL_URL=mysql://user:pass@host/matomo \
 *     bun run --cwd apps/server import -- [--dry-run] [--since 2026-07-01] [--until 2026-07-15] [--site-map 3:7]
 *
 *   # featherstat v1 (docs/06 § v1 → v2) — what migrate.ts's refusal points at:
 *   bun run --cwd apps/server import -- v1 <path> [--into <target>] [--dry-run]
 *
 * Both stream in watermarked batches into the target database, so re-running
 * resumes/tops-up instead of duplicating.
 */

const USAGE = `usage:
  MATOMO_MYSQL_URL=mysql://user:pass@host/matomo bun run --cwd apps/server import -- [matomo] [--dry-run] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--site-map M:L,…]
  bun run --cwd apps/server import -- ${V1_IMPORT_SUBCOMMAND} <path> [--into <target>] [--dry-run]

matomo (default subcommand):
  --mysql-url  Matomo MariaDB connection URL — prefer the MATOMO_MYSQL_URL env
               var: command lines are visible in ps and land in shell history
  --dry-run    map + count + report per-site/day totals, write nothing
  --since      only scan visits/actions at or after this UTC date (final top-up;
               re-reads the window's visits so mutated rows upsert to final state)
  --until      only scan strictly before this UTC date — at cutover, the date the
               tee started, so live-ingested traffic is not imported twice
  --site-map   Matomo id → local id pairs (3:7,4:8). Ids are preserved, so a
               Matomo site whose id a local site with none of its domains already
               holds is refused; map it to a free id, or to the same id to vouch
               that they are one site. Remembered for later top-ups

  Target database: DB_PATH env, default data/dev.db.

${V1_IMPORT_SUBCOMMAND} (featherstat v1 → v2):
  <path>       the v1 database file, opened READONLY — run it against a copy or
               a stopped server (runbook: stop v1 → import → start v2)
  --into       the v2 target file (default: DB_PATH env, else analytics.db);
               created and migrated if absent, REFUSED if it already has events
  --dry-run    read + validate the source + report what would happen, write nothing`;

const DEFAULT_MATOMO_DB_PATH = 'data/dev.db';
const DEFAULT_V1_TARGET_PATH = 'analytics.db';

interface CliValues {
  'mysql-url'?: string;
  'dry-run'?: boolean;
  since?: string;
  until?: string;
  'site-map'?: string;
  into?: string;
  help?: boolean;
}

async function main(): Promise<void> {
  let values: CliValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        'mysql-url': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        since: { type: 'string' },
        until: { type: 'string' },
        'site-map': { type: 'string' },
        into: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const subcommand = positionals[0] ?? 'matomo';
  if (subcommand === V1_IMPORT_SUBCOMMAND) {
    await mainV1(positionals[1], values);
    return;
  }
  if (subcommand !== 'matomo') {
    console.error(`unknown subcommand '${subcommand}'`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await mainMatomo(values);
}

// ---------------------------------------------------------------------------
// featherstat v1
// ---------------------------------------------------------------------------

async function mainV1(sourcePath: string | undefined, values: CliValues): Promise<void> {
  if (sourcePath === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const dryRun = values['dry-run'] ?? false;
  const targetPath = values.into ?? process.env.DB_PATH ?? DEFAULT_V1_TARGET_PATH;
  // Readonly + fileMustExist: the source is a stopped v1 server's file (or a
  // copy of one) and nothing here may touch it — not even to create a -wal.
  const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  // A dry run writes nothing, which includes not creating the target file.
  const target = dryRun && !existsSync(targetPath) ? openDb(':memory:') : openDb(targetPath);
  try {
    console.log(`importing v1 ${sourcePath} → ${targetPath}`);
    console.log(
      'runbook (docs/06): stop v1 → import → start v2 — a still-writing v1 forks history',
    );
    const report = await importV1(target, source, {
      dryRun,
      log: (line) => console.log(`  ${line}`),
    });
    printV1Report(report);
    if (report.gates !== null && !report.gates.ok) process.exitCode = 1;
  } finally {
    target.close();
    source.close();
  }
}

function printV1Report(report: V1ImportReport): void {
  console.log(report.dryRun ? 'dry run — nothing written:' : 'imported:');
  const skippedSites = report.sitesSkipped > 0 ? ` (${report.sitesSkipped} already present)` : '';
  console.log(`  sites       ${report.sites}${skippedSites}`);
  console.log(`  events      ${report.events}`);
  console.log(`  sessions    ${report.sessions}`);
  console.log(`  bot_drops   ${report.botDropRows}`);
  console.log(`  settings    ${report.settingsImported.length}`);
  for (const key of report.settingsSkipped) console.log(`    skipped (not allowlisted): ${key}`);
  const badLayouts =
    report.dashboardsSkipped > 0 ? ` (${report.dashboardsSkipped} unreadable, skipped)` : '';
  console.log(`  dashboards  ${report.dashboards}${badLayouts}`);
  console.log(
    `  dropped by design: ${report.droppedShareTokens} share tokens (re-mint), ` +
      `${report.droppedAdminSessions} admin sessions (re-login)`,
  );
  if (report.utmNormalized > 0) {
    console.log(
      `  note: ${report.utmNormalized} rows had utm values normalized — per-day totals are ` +
        'unchanged, but utm-grouped numbers may differ from v1 by design',
    );
  }
  if (!report.dryRun) console.log(`  rollups     ${report.rollupDays} site-days rebuilt`);
  if (report.gates !== null) {
    if (report.gates.ok) {
      console.log('  validation gates: all held');
    } else {
      console.log('  validation gates FAILED:');
      for (const failure of report.gates.failures) console.log(`    ${failure}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Matomo
// ---------------------------------------------------------------------------

async function mainMatomo(values: CliValues): Promise<void> {
  // Env preferred: a URL with credentials on the command line leaks via ps/history.
  const mysqlUrl = values['mysql-url'] ?? process.env.MATOMO_MYSQL_URL;
  if (!mysqlUrl) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  for (const [flag, value] of [
    ['since', values.since],
    ['until', values.until],
  ] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.error(`--${flag} must be YYYY-MM-DD, got '${value}'`);
      process.exitCode = 1;
      return;
    }
  }
  let siteMap: Map<number, number> | undefined;
  try {
    siteMap = values['site-map'] === undefined ? undefined : parseSiteMap(values['site-map']);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  // The mysql2 dependency is import()ed here so the v1 path never loads it.
  const { createConnection } = await import('mysql2/promise');
  // dateStrings keeps Matomo's UTC DATETIMEs as strings — the driver must not
  // reinterpret them in the local timezone (the mappers parse them as UTC).
  const connection = await createConnection({
    uri: mysqlUrl,
    dateStrings: true,
    supportBigNumbers: true,
  });
  const db = openDb(process.env.DB_PATH ?? DEFAULT_MATOMO_DB_PATH);
  try {
    const source: SourceQuery = async (sql, params) => {
      const [rows] = await connection.query(sql, params as unknown[]);
      return rows as Array<Record<string, unknown>>;
    };
    const report = await importMatomo(db, source, {
      dryRun: values['dry-run'],
      since: values.since,
      until: values.until,
      siteMap,
      log: (line) => console.log(`  ${line}`),
    });
    printMatomoReport(report);
  } finally {
    db.close();
    await connection.end();
  }
}

function printMatomoReport(report: ImportReport): void {
  console.log(report.dryRun ? 'dry run — nothing written:' : 'imported:');
  const skippedSites = report.sitesSkipped > 0 ? ` (${report.sitesSkipped} already present)` : '';
  const skippedRows =
    report.skipped > 0 ? ` (${report.skipped} rows outside our model, skipped)` : '';
  console.log(`  sites     ${report.sites}${skippedSites}`);
  console.log(`  sessions  ${report.sessions}`);
  console.log(`  events    ${report.events}${skippedRows}`);
  if (report.dryRun) {
    console.log('  per-site/day totals:');
    for (const day of report.days) {
      console.log(
        `    site ${day.site_id}  ${day.local_date}  visits ${day.visits}  pageviews ${day.pageviews}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
