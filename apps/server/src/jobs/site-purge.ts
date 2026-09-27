import {
  bumpDataEpoch,
  type Db,
  deleteSetting,
  getSetting,
  setSetting,
  settingKeysWithPrefix,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';

/**
 * Chunked removal of a deleted site's bulk data (docs/04 § 5). The admin DELETE
 * route tombstones the site, drops its small config rows inline, and enqueues
 * this: a settings watermark per site, so a crash resumes at boot — the same
 * watermark-in-settings shape prop-scrub.ts and campaign-backfill.ts use.
 *
 * Each chunk is one short write transaction (the lock is shared with ingest)
 * with an event-loop yield between chunks. The watermark is cleared LAST, in
 * the same final transaction that bumps the data epoch: rows this site
 * contributed to `MAX(events.id)`-tagged answers are gone, so every ETag minted
 * before the purge must expire (CLAUDE.md invariant 10). The tombstoned `sites`
 * row outlives the purge on purpose — it is what keeps the id from being
 * handed to the next site created (db/index.ts `tombstoneSite`).
 */

const WATERMARK_PREFIX = 'site_purge:';

/** Rows per transaction — retention.ts's budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

/** Ordinary rowid tables: chunk by rowid, `changes` says when a table is drained. */
const ROWID_TABLES = ['events', 'sessions', 'bot_drops', 'excluded_drops'] as const;

/** WITHOUT ROWID rollup + presence tables: chunk by local_date — a day's rows
 * are bounded (dims × values), so a date batch stays a short transaction. */
const ROLLUP_TABLES = [
  'rollup_traffic_hour',
  'rollup_dim_day',
  'rollup_sessions_day',
  'rollup_visitor_seen',
  'rollup_session_seen',
] as const;

/** Dates per rollup-table chunk; each date can carry thousands of dim rows. */
const ROLLUP_DATES_PER_CHUNK = 50;

function watermarkKey(siteId: number): string {
  return `${WATERMARK_PREFIX}${siteId}`;
}

/** Enqueue a purge — called INSIDE the delete route's write transaction, beside
 * the tombstone and the config-row deletes, so all three commit together. */
export function requestSitePurge(db: Db, siteId: number): void {
  setSetting(db, watermarkKey(siteId), '0');
}

export interface SitePurgeResult {
  /** Purges completed this run (watermark cleared, epoch bumped). */
  completed: number;
  /** Rows deleted across all tables and purges. */
  rows: number;
}

interface SitePurgeOptions {
  batchSize?: number;
}

/** One run in flight per db: a route kick during the boot catch-up just rides it. */
const inFlight = new WeakMap<Db, Promise<SitePurgeResult>>();

/**
 * Drain every pending purge watermark. Safe to call any time — the delete route
 * kicks it, and the scheduler's daily job resumes whatever a crash left behind.
 */
export function runSitePurges(db: Db, options: SitePurgeOptions = {}): Promise<SitePurgeResult> {
  const running = inFlight.get(db);
  if (running !== undefined) return running;
  const run = drain(db, options.batchSize ?? DEFAULT_BATCH_SIZE).finally(() => {
    inFlight.delete(db);
  });
  inFlight.set(db, run);
  return run;
}

async function drain(db: Db, batchSize: number): Promise<SitePurgeResult> {
  const result: SitePurgeResult = { completed: 0, rows: 0 };
  for (const setting of settingKeysWithPrefix(db, WATERMARK_PREFIX)) {
    const siteId = Number(setting.slice(WATERMARK_PREFIX.length));
    if (!Number.isInteger(siteId) || getSetting(db, setting) === undefined) {
      withWriteTransaction(db, () => deleteSetting(db, setting)); // unreadable = unresumable
      continue;
    }

    for (const table of ROWID_TABLES) {
      const sql = `DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} WHERE site_id = ? LIMIT ?)`;
      for (;;) {
        // The event-loop yield between chunks: SQLite is synchronous, and an
        // unbroken purge would stall ingest and its 200 ms flush.
        await new Promise((resolve) => setImmediate(resolve));
        const deleted = withWriteTransaction(
          db,
          () => stmt(db, sql).run(siteId, batchSize).changes,
        );
        result.rows += deleted;
        if (deleted < batchSize) break;
      }
    }

    for (const table of ROLLUP_TABLES) {
      const sql = `DELETE FROM ${table} WHERE site_id = ? AND local_date IN (
        SELECT DISTINCT local_date FROM ${table} WHERE site_id = ? LIMIT ?)`;
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        const deleted = withWriteTransaction(
          db,
          () => stmt(db, sql).run(siteId, siteId, ROLLUP_DATES_PER_CHUNK).changes,
        );
        result.rows += deleted;
        if (deleted === 0) break;
      }
    }

    // Everything drained: the watermark and the epoch move together, so a
    // crash can only ever leave a resumable state behind.
    withWriteTransaction(db, () => {
      deleteSetting(db, setting);
      bumpDataEpoch(db);
    });
    result.completed += 1;
  }
  return result;
}
