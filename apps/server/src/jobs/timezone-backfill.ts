import { localClock, SESSION_REVIVAL_MS } from '@featherstat/shared';
import {
  type Db,
  deleteSetting,
  getSetting,
  getSite,
  setSetting,
  settingKeysWithPrefix,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';
import { rawHorizonTs } from '../rollup/apply.ts';
import { rebuildAllRollups, rebuildRollupDay } from '../rollup/rebuild.ts';
import { inChunks, markRewriteDirty, oneRunAtATime, settleRewrite } from './rewrite.ts';

/**
 * Timezone backfill (docs/03 § Timezones): a site whose timezone changed has
 * its stored `local_date`/`local_hour` re-derived in the new zone — events from
 * `ts`, sessions from `started_at` — then its rollups rebuilt and the data epoch
 * bumped. Until then its history is keyed in the old zone while every window
 * resolves in the new one: day buckets off by the offset, heatmap hours shifted.
 *
 * The plumbing is jobs/rewrite.ts's, shared with the other backfills: a
 * settings watermark per (site, table) so a crash resumes, short chunked write
 * transactions sharing the lock with ingest, and a durable dirty flag set with
 * the first row it changes and cleared only after the bump (invariant 10).
 * The zone is read inside every chunk and the columns are a pure function of
 * instant and zone, so the job is idempotent — and a second change mid-run,
 * which re-arms the watermarks in the PATCH's own transaction, simply restarts
 * the walk in the newest zone.
 *
 * What it cannot move, stated rather than papered over:
 * - A session seen within `SESSION_REVIVAL_MS`: the sessionizer may still hold
 *   it, and the batcher keys that session's rollup deltas by the date it holds —
 *   rewriting the row under it would drift the rollups. It keeps the date it
 *   started on; its events move.
 * - Rollup days whose raw rows retention has pruned: nothing is left to
 *   recompute them from, so they stay bucketed in the old zone.
 * - The per-day drop counters (bot, excluded, prop): they store no instant.
 */

const WATERMARK_PREFIX = 'tz_backfill:';
/** Per site: the durable debt `settleRewrite` pays. */
const DIRTY_PREFIX = 'tz_backfill_dirty:';
const TABLES = ['events', 'sessions'] as const;
type BackfillTable = (typeof TABLES)[number];

/** Rows per transaction — the other backfills' budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

/** UTC+14 (Pacific/Kiritimati): no zone's local day begins earlier than this before 00:00Z. */
const EARLIEST_DAY_START_MS = 14 * 3_600_000;

/**
 * `+site_id` keeps SQLite off the (site_id, …) indexes: with one it would sort
 * the site's every row by rowid for each chunk, where the rowid range scan
 * walks the table once over the whole run.
 */
const SELECT_CHUNK: Record<BackfillTable, string> = {
  events: `SELECT rowid AS rid, ts AS at, local_date, local_hour, NULL AS last_seen_at
FROM events WHERE +site_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
  sessions: `SELECT rowid AS rid, started_at AS at, local_date, local_hour, last_seen_at
FROM sessions WHERE +site_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
};

const UPDATE_ROW: Record<BackfillTable, string> = {
  events: 'UPDATE events SET local_date = ?, local_hour = ? WHERE rowid = ?',
  sessions: 'UPDATE sessions SET local_date = ?, local_hour = ? WHERE rowid = ?',
};

/** Rollup days of the site that no raw row keys any more — the old zone's leftovers. */
const SQL_ORPHAN_DAYS = `SELECT local_date FROM rollup_traffic_hour WHERE site_id = @site
UNION SELECT local_date FROM rollup_dim_day WHERE site_id = @site
UNION SELECT local_date FROM rollup_sessions_day WHERE site_id = @site
EXCEPT SELECT local_date FROM events WHERE site_id = @site
EXCEPT SELECT local_date FROM sessions WHERE site_id = @site`;

interface ChunkRow {
  rid: number;
  at: number;
  local_date: string;
  local_hour: number | null;
  last_seen_at: number | null;
}

function watermarkKey(siteId: number, table: BackfillTable): string {
  return `${WATERMARK_PREFIX}${siteId}:${table}`;
}

function dirtyKey(siteId: number): string {
  return `${DIRTY_PREFIX}${siteId}`;
}

/** Enqueue a backfill — called INSIDE the PATCH's write transaction, beside the zone change. */
export function requestTimezoneBackfill(db: Db, siteId: number): void {
  for (const table of TABLES) setSetting(db, watermarkKey(siteId, table), '0');
}

/**
 * Drop a site's pending backfill and its debt — called INSIDE the site delete's
 * write transaction: the purge owns the rows now, and bumps the epoch itself.
 */
export function forgetTimezoneBackfill(db: Db, siteId: number): void {
  for (const table of TABLES) deleteSetting(db, watermarkKey(siteId, table));
  deleteSetting(db, dirtyKey(siteId));
}

export interface TimezoneBackfillResult {
  /** Sites whose backfill completed this run (rollups rebuilt, epoch bumped if owed). */
  completed: number;
  /** Rows whose local clock actually changed. */
  rows: number;
}

interface TimezoneBackfillOptions {
  batchSize?: number;
  now?: () => number;
}

/** Drain every pending backfill. Safe to call any time. */
export const runTimezoneBackfills = oneRunAtATime((db: Db, options: TimezoneBackfillOptions = {}) =>
  drain(db, options),
);

/** Sites with a watermark or an unsettled dirty flag; keys this job never wrote are ignored. */
function pendingSites(db: Db): number[] {
  const ids = new Set<number>();
  for (const [prefix, pattern] of [
    [WATERMARK_PREFIX, /^(\d+):/],
    [DIRTY_PREFIX, /^(\d+)$/],
  ] as const) {
    for (const key of settingKeysWithPrefix(db, prefix)) {
      const id = pattern.exec(key.slice(prefix.length))?.[1];
      if (id !== undefined) ids.add(Number(id));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function drain(db: Db, options: TimezoneBackfillOptions): Promise<TimezoneBackfillResult> {
  const result: TimezoneBackfillResult = { completed: 0, rows: 0 };
  // Re-read after every site: a PATCH landing mid-run re-arms watermarks that
  // this run must still honour, or they would wait for the daily resume.
  for (let site = pendingSites(db)[0]; site !== undefined; site = pendingSites(db)[0]) {
    if (await backfillSite(db, site, options, result)) result.completed += 1;
  }
  return result;
}

/** True when the site's backfill finished; false when it was re-armed or its site is gone. */
async function backfillSite(
  db: Db,
  siteId: number,
  options: TimezoneBackfillOptions,
  result: TimezoneBackfillResult,
): Promise<boolean> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  for (const table of TABLES) {
    const key = watermarkKey(siteId, table);
    const select = stmt<ChunkRow>(db, SELECT_CHUNK[table]);
    const update = stmt(db, UPDATE_ROW[table]);
    await inChunks(db, () => {
      const mark = getSetting(db, key);
      if (mark === undefined) return true;
      const site = getSite(db, siteId);
      if (site === undefined) {
        forgetTimezoneBackfill(db, siteId);
        return true;
      }
      const rows = select.all(siteId, Number(mark), batchSize);
      if (rows.length === 0) {
        deleteSetting(db, key);
        return true;
      }
      const liveFloor = (options.now?.() ?? Date.now()) - SESSION_REVIVAL_MS;
      for (const row of rows) {
        if (row.last_seen_at !== null && row.last_seen_at >= liveFloor) continue;
        const clock = localClock(site.timezone, row.at);
        if (clock.date === row.local_date && clock.hour === row.local_hour) continue;
        update.run(clock.date, clock.hour, row.rid);
        result.rows += 1;
        markRewriteDirty(db, dirtyKey(siteId));
      }
      setSetting(db, key, String(rows[rows.length - 1]?.rid ?? mark));
      return false;
    });
  }
  if (getSite(db, siteId) === undefined) return false;
  if (TABLES.some((table) => getSetting(db, watermarkKey(siteId, table)) !== undefined)) {
    return false; // re-armed by a newer change while this walk ran; drain goes again
  }

  await settleRewrite(db, dirtyKey(siteId), async () => {
    await rebuildAllRollups(db, { siteId });
    await clearOrphanDays(db, siteId);
  });
  return true;
}

/**
 * The rebuild recomputes the days raw rows now key; a day only the OLD zone
 * had (history's first or last, or one either side of a gap) keeps its rollup
 * rows unless cleared — an empty rebuild clears it. Only where raw is whole:
 * a day that could reach below the raw horizon is the only record left of the
 * rows retention took, and is never touched.
 */
async function clearOrphanDays(db: Db, siteId: number): Promise<void> {
  const horizon = rawHorizonTs(db) ?? Number.NEGATIVE_INFINITY;
  const days = stmt<string>(db, SQL_ORPHAN_DAYS).pluck().all({ site: siteId });
  for (const day of days) {
    if (Date.parse(`${day}T00:00:00Z`) - EARLIEST_DAY_START_MS <= horizon) continue;
    await new Promise((resolve) => setImmediate(resolve));
    withWriteTransaction(db, () => rebuildRollupDay(db, siteId, day));
  }
}
