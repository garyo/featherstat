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
import { inChunks, oneRunAtATime } from './rewrite.ts';

/**
 * Chunked removal of one prop key from stored bags (docs/03 § Props). The admin
 * DELETE route drops the governance rows inline and enqueues this: a settings
 * watermark per (site, key), so a crash resumes where it stopped — the same
 * watermark-in-settings shape retention.ts uses for its horizon.
 *
 * Each chunk is one short write transaction (the lock is shared with ingest),
 * `json_remove` on exactly the rows still carrying the key, and a bag emptied
 * to `{}` becomes NULL — an empty bag is never stored. Completion deletes the
 * watermark and bumps the data epoch (db/index.ts): this rewrites history in
 * place, so every ETag minted before it must expire.
 */

const WATERMARK_PREFIX = 'prop_scrub:';

/** Rows examined per transaction — retention.ts's budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

/**
 * One rowid window of `batchSize` rows — examined, not matched: a window keeps
 * each transaction's work bounded however sparse the key is, where "the next N
 * matches" could walk the rest of the table in one go. `+site_id` keeps the
 * planner on the rowid range; the site index would scan the whole site and sort.
 * `json_type` is non-NULL exactly when the bag carries the key; values are never
 * JSON null (the schema forbids it), so this misses nothing.
 */
const SQL_SCRUB_WINDOW = `UPDATE events
SET props = nullif(json_remove(props, ?), '{}')
WHERE id > ? AND id <= ? AND +site_id = ? AND props IS NOT NULL AND json_type(props, ?) IS NOT NULL`;

const SQL_MAX_EVENT_ID = 'SELECT COALESCE(MAX(id), 0) FROM events';

function watermarkKey(siteId: number, key: string): string {
  return `${WATERMARK_PREFIX}${siteId}:${key}`;
}

/** Enqueue a scrub — called INSIDE the route's write transaction, beside the
 * registry-row deletes, so the request and its watermark commit together. */
export function requestPropScrub(db: Db, siteId: number, key: string): void {
  setSetting(db, watermarkKey(siteId, key), '0');
}

/**
 * Drop a site's pending scrubs — called INSIDE the site delete's write
 * transaction: the purge removes every bag they would have rewritten.
 */
export function forgetPropScrubs(db: Db, siteId: number): void {
  for (const setting of settingKeysWithPrefix(db, `${WATERMARK_PREFIX}${siteId}:`)) {
    deleteSetting(db, setting);
  }
}

export interface PropScrubResult {
  /** Scrubs completed this run (watermark removed, epoch bumped). */
  completed: number;
  /** Event rows rewritten across all scrubs. */
  rows: number;
}

interface PropScrubOptions {
  batchSize?: number;
}

/**
 * Drain every pending scrub watermark. Safe to call any time — the route kicks
 * it after a DELETE, and the scheduler's hourly job resumes whatever a crash
 * left behind.
 */
export const runPropScrubs = oneRunAtATime((db: Db, options: PropScrubOptions = {}) =>
  drain(db, options.batchSize ?? DEFAULT_BATCH_SIZE),
);

async function drain(db: Db, batchSize: number): Promise<PropScrubResult> {
  const result: PropScrubResult = { completed: 0, rows: 0 };
  for (const setting of settingKeysWithPrefix(db, WATERMARK_PREFIX)) {
    const [siteRaw, key] = setting.slice(WATERMARK_PREFIX.length).split(':', 2);
    const siteId = Number(siteRaw);
    if (!Number.isInteger(siteId) || key === undefined || key === '') {
      withWriteTransaction(db, () => deleteSetting(db, setting)); // unreadable = unresumable
      continue;
    }
    const path = `$."${key}"`;
    await inChunks(db, () => {
      const since = Number(getSetting(db, setting) ?? 0);
      if (since >= (stmt<number>(db, SQL_MAX_EVENT_ID).pluck().get() as number)) {
        deleteSetting(db, setting);
        bumpDataEpoch(db);
        return true;
      }
      const until = since + batchSize;
      result.rows += stmt(db, SQL_SCRUB_WINDOW).run(path, since, until, siteId, path).changes;
      setSetting(db, setting, String(until));
      return false;
    });
    result.completed += 1;
  }
  return result;
}
