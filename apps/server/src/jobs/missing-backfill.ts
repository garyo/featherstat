import {
  isTrackerMilestone,
  MISSING_PROP,
  PING_CLAMP_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import {
  type Db,
  deleteSetting,
  getSetting,
  insertMissingHits,
  type MissingRow,
  setSetting,
  stmt,
} from '../db/index.ts';
import { requestedPath } from '../pipeline/missing.ts';
import { canonicalReferrerDomain, referrerTypeOf } from '../pipeline/referrers.ts';
import { inChunks, markRewriteDirty, oneRunAtATime, settleRewrite } from './rewrite.ts';

/**
 * Not-found backfill (docs/03 § Not-found hits): the page views a site's 404
 * page reported before ingest knew to keep them apart move out of traffic into
 * `missing_hits`. Enqueued once by migration 106.
 *
 * A not-found page view is one carrying the `missing` prop, or — older history,
 * from before the 404 snippet carried it — one reported as `/404`. It goes,
 * and so does everything recorded ON that page: its heartbeats, its read
 * milestone, any click out of it. A visit left with no page view was never a
 * visit and goes whole; a visit with real pages left is recomputed from its
 * remaining rows by the sessionizer's own rules. Its start stays where it was —
 * the visitor did arrive then, on a page that did not exist.
 *
 * A visit the live sessionizer may still hold (idle under the session timeout)
 * is left for the next run: the next flush would write the in-memory row back
 * over the recomputed one. The watermark is then rewound rather than cleared,
 * so the daily run comes back for it.
 *
 * The rewrite changes events, sessions and every rolled counter they fed, so
 * it owes `settleRewrite`: a full rollup rebuild, then the epoch bump that
 * expires every pre-rewrite ETag (invariant 10).
 */

const WATERMARK = 'missing_backfill:events';
/** The durable debt `settleRewrite` pays: set with the first row moved. */
const DIRTY_SETTING = 'missing_backfill:dirty';
/** Not-found page views per transaction, each pulling its whole visit along. */
const DEFAULT_BATCH_SIZE = 500;

const SQL_CANDIDATES = `SELECT id, session_id FROM events
WHERE id > ? AND type = 'pageview'
  AND (json_extract(props, '$.${MISSING_PROP}') IS NOT NULL OR path = '/404')
ORDER BY id LIMIT ?`;
const SQL_SESSION = 'SELECT last_seen_at FROM sessions WHERE id = ?';
const SQL_SESSION_ROWS = `SELECT id, site_id, ts, local_date, local_hour, type, hostname, path, props,
  ref_type, ref_domain, event_category, event_action, device_type, country
FROM events WHERE session_id = ? ORDER BY seq, id`;
const SQL_DELETE_EVENT = 'DELETE FROM events WHERE id = ?';
const SQL_DELETE_SESSION = 'DELETE FROM sessions WHERE id = ?';
const SQL_UPDATE_SESSION = `UPDATE sessions SET entry_path = ?, exit_path = ?, pageviews = ?,
  events = ?, engaged_ms = ?, last_seen_at = ? WHERE id = ?`;

interface Candidate {
  id: number;
  session_id: Uint8Array;
}

interface StoredRow {
  id: number;
  site_id: number;
  ts: number;
  local_date: string;
  local_hour: number;
  type: string;
  hostname: string | null;
  path: string | null;
  props: string | null;
  ref_type: string | null;
  ref_domain: string | null;
  event_category: string | null;
  event_action: string | null;
  device_type: string | null;
  country: string | null;
}

export interface MissingBackfillResult {
  /** True when this run drained the watermark, or paid a crashed run's rebuild. */
  completed: boolean;
  /** Not-found page views moved out of traffic. */
  moved: number;
  /** Visits deleted because nothing but a not-found page was in them. */
  visits: number;
}

interface MissingBackfillOptions {
  batchSize?: number;
  now?: () => number;
}

/** Drain the pending backfill, if any. Safe to call any time. */
export const runMissingBackfill = oneRunAtATime((db: Db, options: MissingBackfillOptions = {}) =>
  drain(db, options.batchSize ?? DEFAULT_BATCH_SIZE, options.now?.() ?? Date.now()),
);

async function drain(db: Db, batchSize: number, now: number): Promise<MissingBackfillResult> {
  const result: MissingBackfillResult = { completed: false, moved: 0, visits: 0 };
  const enqueued = getSetting(db, WATERMARK) !== undefined;
  let deferred = false;
  if (enqueued) {
    const candidates = stmt<Candidate>(db, SQL_CANDIDATES);
    await inChunks(db, () => {
      const since = Number(getSetting(db, WATERMARK) ?? 0);
      const rows = candidates.all(since, batchSize);
      if (rows.length === 0) {
        if (deferred) setSetting(db, WATERMARK, '0');
        else deleteSetting(db, WATERMARK);
        return true;
      }
      const seen = new Set<string>();
      for (const { session_id } of rows) {
        const key = Buffer.from(session_id).toString('hex');
        if (seen.has(key)) continue;
        seen.add(key);
        const lastSeen = stmt<{ last_seen_at: number }>(db, SQL_SESSION).get(session_id);
        if (lastSeen !== undefined && lastSeen.last_seen_at > now - SESSION_TIMEOUT_MS) {
          deferred = true;
          continue;
        }
        const outcome = rewriteVisit(db, session_id);
        result.moved += outcome.moved;
        if (outcome.deleted) result.visits += 1;
        if (outcome.moved > 0) markRewriteDirty(db, DIRTY_SETTING);
      }
      setSetting(db, WATERMARK, String(rows[rows.length - 1]?.id ?? since));
      return false;
    });
  }
  const settled = await settleRewrite(db, DIRTY_SETTING);
  result.completed = (enqueued && !deferred) || settled;
  return result;
}

/** One visit: its not-found page views moved, what was recorded on them dropped, the rest recounted. */
function rewriteVisit(db: Db, sessionId: Uint8Array): { moved: number; deleted: boolean } {
  const rows = stmt<StoredRow>(db, SQL_SESSION_ROWS).all(sessionId);
  const kept: StoredRow[] = [];
  const moved: MissingRow[] = [];
  const dropped: number[] = [];
  let onMissing = false;
  let previousPage: StoredRow | undefined;
  for (const row of rows) {
    if (row.type === 'pageview') {
      onMissing = isMissingPageview(row);
      if (onMissing) {
        moved.push(missingRowOf(row, previousPage));
        dropped.push(row.id);
        continue;
      }
      previousPage = row;
    }
    if (onMissing) dropped.push(row.id);
    else kept.push(row);
  }
  if (moved.length === 0) return { moved: 0, deleted: false };

  insertMissingHits(db, moved);
  const pages = kept.filter((row) => row.type === 'pageview');
  const deleteEvent = stmt(db, SQL_DELETE_EVENT);
  if (pages.length === 0) {
    for (const row of rows) deleteEvent.run(row.id);
    stmt(db, SQL_DELETE_SESSION).run(sessionId);
    return { moved: moved.length, deleted: true };
  }
  for (const id of dropped) deleteEvent.run(id);
  stmt(db, SQL_UPDATE_SESSION).run(
    pages[0]?.path ?? null,
    pages[pages.length - 1]?.path ?? null,
    pages.length,
    kept.filter((row) => row.type === 'event' && !isTrackerMilestone(eventOf(row))).length,
    engagedMs(kept),
    kept[kept.length - 1]?.ts ?? 0,
    sessionId,
  );
  return { moved: moved.length, deleted: false };
}

/** The ingest rule (`isMissingHit`), plus the older `/404` page views that never set the prop. */
function isMissingPageview(row: StoredRow): boolean {
  return row.path === '/404' || Boolean(missingProp(row));
}

function missingProp(row: StoredRow): unknown {
  return row.props === null
    ? undefined
    : (JSON.parse(row.props) as Record<string, unknown>)[MISSING_PROP];
}

/**
 * The referrer a stored not-found page view can still tell. Mid-visit, the page
 * before it in the visit linked to it. As the visit's first hit, the visit's own
 * attribution WAS its referrer — but only the domain was ever stored.
 */
function missingRowOf(row: StoredRow, previousPage: StoredRow | undefined): MissingRow {
  const base = {
    site_id: row.site_id,
    ts: row.ts,
    local_date: row.local_date,
    local_hour: row.local_hour,
    path: requestedPath(missingProp(row)),
    device_type: row.device_type,
    country: row.country,
  };
  if (previousPage !== undefined) {
    return {
      ...base,
      ref_type: 'internal',
      ref_domain: row.hostname === null ? null : canonicalReferrerDomain(row.hostname),
      ref_path: previousPage.path?.split('?')[0] ?? null,
    };
  }
  if (row.ref_domain === null)
    return { ...base, ref_type: 'direct', ref_domain: null, ref_path: null };
  // A campaign is a visit's label, not a referrer: the domain says what it was.
  const type = isReferrerType(row.ref_type) ? row.ref_type : referrerTypeOf(row.ref_domain);
  return { ...base, ref_type: type, ref_domain: row.ref_domain, ref_path: null };
}

const REFERRER_TYPES: ReadonlySet<string> = new Set(['internal', 'search', 'social', 'referral']);

function isReferrerType(
  type: string | null,
): type is 'internal' | 'search' | 'social' | 'referral' {
  return type !== null && REFERRER_TYPES.has(type);
}

function eventOf(row: StoredRow): { category: string; action: string } | undefined {
  if (row.event_category === null || row.event_action === null) return undefined;
  return { category: row.event_category, action: row.event_action };
}

/** The sessionizer's accrual over the rows that remain: each carried hit adds its gap, clamped. */
function engagedMs(rows: readonly StoredRow[]): number {
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = (rows[i]?.ts ?? 0) - (rows[i - 1]?.ts ?? 0);
    total += Math.min(Math.max(gap, 0), PING_CLAMP_MS);
  }
  return total;
}
