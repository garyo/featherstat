import { DAY_MS, localClock } from '@featherstat/shared';
import { type Db, getSetting, stmt, withWriteTransaction } from '../db/index.ts';
import { META_RAW_HORIZON, rawHorizonTs, setRollupMeta } from '../rollup/apply.ts';

/** Settings key (docs/05 § Settings). Absent = keep raw events forever, the default (docs/03). */
export const RETENTION_DAYS_KEY = 'retention_days';

/** Rows per transaction: the write lock is shared with ingest, so each batch stays short. */
const DEFAULT_BATCH_SIZE = 5_000;
/** Bounds one run; a large backlog drains over the following daily runs. */
const DEFAULT_MAX_BATCHES = 100;

// Whole site-local days, so a day is either complete or absent — never cut
// part-way where a rollup rebuild could mistake the remainder for the day.
// Both walk a (site_id, local_date) index prefix, so even the batch that finds
// nothing left is a seek, not a scan. Tombstoned sites included: their rows
// are still rows until the purge reaches them.
const SQL_SITES = 'SELECT id, timezone FROM sites ORDER BY id';
interface RetentionSite {
  id: number;
  timezone: string;
}
const SQL_DELETE_EVENTS = `DELETE FROM events WHERE id IN (
  SELECT id FROM events WHERE site_id = ? AND local_date < ? LIMIT ?)`;
const SQL_DELETE_SESSIONS = `DELETE FROM sessions WHERE rowid IN (
  SELECT rowid FROM sessions WHERE site_id = ? AND local_date < ? LIMIT ?)`;

// Prop-registry ageing (docs/03 § Props): a key not seen since the horizon has
// no rows left to describe once the events above are gone. Values go first —
// they hang off keys. The live registry keeps its in-memory copy until restart,
// which is harmless: a re-appearing key upserts its row right back.
const SQL_DELETE_STALE_PROP_VALUES = `DELETE FROM prop_values WHERE (site_id, key) IN (
  SELECT site_id, key FROM prop_keys WHERE last_seen < ?)`;
const SQL_DELETE_STALE_PROP_KEYS = 'DELETE FROM prop_keys WHERE last_seen < ?';
const SQL_DELETE_OLD_PROP_DROPS = 'DELETE FROM prop_drops WHERE local_date < ?';

export interface RetentionOptions {
  now?: () => number;
  batchSize?: number;
  maxBatches?: number;
}

export interface RetentionResult {
  /** Configured retention; `undefined` means keep forever and nothing was examined. */
  days: number | undefined;
  events: number;
  sessions: number;
  /** Prop keys (with their values) whose `last_seen` fell past the horizon. */
  propKeys: number;
  /** Old `prop_drops` diagnostic counters removed. */
  propDrops: number;
  /** The run hit its batch bound and left older rows for the next one. */
  more: boolean;
}

/**
 * Optional pruning of raw events past a configurable age (docs/02 § Background
 * jobs). The unit is the site-local day: every event and session dated before
 * the cutoff's local date in its site's timezone goes, and that date itself is
 * kept whole — so at least `days` of history always survive. Sessions go by
 * their start day, the day their rollup row is keyed on: a session row whose
 * day is gone would keep counting toward visit metrics the pageviews no longer
 * support. The prop registry ages with them: keys (and their values) last seen
 * before the cutoff, and diagnostic drop counters older than it, describe rows
 * this run is deleting.
 *
 * Rollup rows are NEVER touched — outliving raw is their point (docs/03).
 * The run instead records the raw floor in `rollup_meta.raw_horizon_ts`, so
 * the query engine refuses raw-only questions at or below its local date
 * (partial numbers are wrong numbers) while rollup-answerable ones keep
 * answering, and a rollup rebuild leaves those days alone.
 */
export async function runRetention(
  db: Db,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const days = retentionDays(db);
  if (days === undefined) {
    return { days, events: 0, sessions: 0, propKeys: 0, propDrops: 0, more: false };
  }

  const cutoff = (options.now?.() ?? Date.now()) - days * DAY_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const result: RetentionResult = {
    days,
    events: 0,
    sessions: 0,
    propKeys: 0,
    propDrops: 0,
    more: false,
  };

  // Advance the floor BEFORE deleting: the batched DELETE takes rows below the
  // cutoff's day in no particular order, so raw history under it is suspect from the
  // first batch — even one this run leaves for tomorrow. Monotonic: an operator
  // who widens retention gets slower pruning, never a floor that retreats.
  if (cutoff > (rawHorizonTs(db) ?? Number.NEGATIVE_INFINITY)) {
    withWriteTransaction(db, () => setRollupMeta(db, META_RAW_HORIZON, String(cutoff)));
  }

  // The registry tables are capped by construction (30 keys/site), so this is
  // one short transaction, not a chunked walk like the event prune below.
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  withWriteTransaction(db, () => {
    stmt(db, SQL_DELETE_STALE_PROP_VALUES).run(cutoff);
    result.propKeys = stmt(db, SQL_DELETE_STALE_PROP_KEYS).run(cutoff).changes;
    result.propDrops = stmt(db, SQL_DELETE_OLD_PROP_DROPS).run(cutoffDate).changes;
  });

  const sites = stmt<RetentionSite>(db, SQL_SITES).all();
  let batches = 0;
  for (const site of sites) {
    const keepFrom = localClock(site.timezone, cutoff).date;
    for (;;) {
      if (batches === maxBatches) {
        result.more = true;
        return result;
      }
      // One transaction per batch, and the event loop back between them: SQLite is
      // synchronous, so an unbroken prune would stall ingest and its 200 ms flush.
      if (batches > 0) await new Promise((resolve) => setImmediate(resolve));
      batches += 1;
      const deleted = withWriteTransaction(db, () => ({
        events: stmt(db, SQL_DELETE_EVENTS).run(site.id, keepFrom, batchSize).changes,
        sessions: stmt(db, SQL_DELETE_SESSIONS).run(site.id, keepFrom, batchSize).changes,
      }));
      result.events += deleted.events;
      result.sessions += deleted.sessions;
      if (deleted.events < batchSize && deleted.sessions < batchSize) break;
    }
  }
  return result;
}

/** Days of raw data to keep; `undefined` (unset, or unusable) keeps everything. */
export function retentionDays(db: Db): number | undefined {
  const raw = getSetting(db, RETENTION_DAYS_KEY);
  if (raw === undefined) return undefined;
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) {
    console.error(`ignoring unusable ${RETENTION_DAYS_KEY} setting: ${JSON.stringify(raw)}`);
    return undefined;
  }
  return days;
}
