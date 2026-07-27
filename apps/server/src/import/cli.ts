import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { openDb } from '../db/index.ts';
import { type ImportReport, importMatomo, type SourceQuery } from './importer.ts';

/**
 * One-shot Matomo importer CLI (docs/06):
 *
 *   MATOMO_MYSQL_URL=mysql://user:pass@host/matomo \
 *     bun run --cwd apps/server import -- [--dry-run] [--since 2026-07-01] [--until 2026-07-15]
 *
 * Reads the Matomo MariaDB directly (read-only credentials suffice) into the
 * local database at DB_PATH (default data/dev.db). Safe to re-run: high-water
 * marks in `settings` make every run a top-up.
 */

const USAGE = `usage: MATOMO_MYSQL_URL=mysql://user:pass@host/matomo bun run --cwd apps/server import -- [--dry-run] [--since YYYY-MM-DD] [--until YYYY-MM-DD]

  --mysql-url  Matomo MariaDB connection URL — prefer the MATOMO_MYSQL_URL env
               var: command lines are visible in ps and land in shell history
  --dry-run    map + count + report per-site/day totals, write nothing
  --since      only scan visits/actions at or after this UTC date (final top-up;
               re-reads the window's visits so mutated rows upsert to final state)
  --until      only scan strictly before this UTC date — at cutover, the date the
               tee started, so live-ingested traffic is not imported twice

Target database: DB_PATH env, default data/dev.db.`;

const DEFAULT_DB_PATH = 'data/dev.db';

async function main(): Promise<void> {
  let values: {
    'mysql-url'?: string;
    'dry-run'?: boolean;
    since?: string;
    until?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        'mysql-url': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        since: { type: 'string' },
        until: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
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

  // dateStrings keeps Matomo's UTC DATETIMEs as strings — the driver must not
  // reinterpret them in the local timezone (the mappers parse them as UTC).
  const connection = await createConnection({
    uri: mysqlUrl,
    dateStrings: true,
    supportBigNumbers: true,
  });
  const db = openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH);
  try {
    const source: SourceQuery = async (sql, params) => {
      const [rows] = await connection.query(sql, params as unknown[]);
      return rows as Array<Record<string, unknown>>;
    };
    const report = await importMatomo(db, source, {
      dryRun: values['dry-run'],
      since: values.since,
      until: values.until,
      log: (line) => console.log(`  ${line}`),
    });
    printReport(report);
  } finally {
    db.close();
    await connection.end();
  }
}

function printReport(report: ImportReport): void {
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
