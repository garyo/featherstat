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

/** Rows per transaction — retention.ts's budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

/** `json_type` is non-NULL exactly when the bag carries the key; values are never
 * JSON null (the schema forbids it), so this misses nothing. */
const SQL_SCRUB_CHUNK = `UPDATE events
SET props = nullif(json_remove(props, ?), '{}')
WHERE id IN (
  SELECT id FROM events
  WHERE id > ? AND site_id = ? AND props IS NOT NULL AND json_type(props, ?) IS NOT NULL
  ORDER BY id LIMIT ?
)
RETURNING id`;

function watermarkKey(siteId: number, key: string): string {
  return `${WATERMARK_PREFIX}${siteId}:${key}`;
}

/** Enqueue a scrub — called INSIDE the route's write transaction, beside the
 * registry-row deletes, so the request and its watermark commit together. */
export function requestPropScrub(db: Db, siteId: number, key: string): void {
  setSetting(db, watermarkKey(siteId, key), '0');
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
      const ids = stmt<{ id: number }>(db, SQL_SCRUB_CHUNK).all(
        path,
        since,
        siteId,
        path,
        batchSize,
      ) as { id: number }[];
      if (ids.length === 0) {
        deleteSetting(db, setting);
        bumpDataEpoch(db);
        return true;
      }
      result.rows += ids.length;
      setSetting(db, setting, String(ids[ids.length - 1]?.id ?? since));
      return false;
    });
    result.completed += 1;
  }
  return result;
}
