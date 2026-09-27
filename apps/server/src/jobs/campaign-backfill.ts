import { canonicalUtmValue } from '@featherstat/shared';
import { type Db, deleteSetting, getSetting, setSetting, stmt } from '../db/index.ts';
import { AliasCache } from '../pipeline/campaigns.ts';
import { inChunks, markRewriteDirty, oneRunAtATime, settleRewrite } from './rewrite.ts';

/**
 * Alias backfill (docs/03 § Campaigns): after an alias edit, every stored utm
 * value is re-derived from `COALESCE(utm_*_raw, utm_*)` — the as-received value
 * when normalization ever changed it, the current value otherwise — through the
 * SAME canonicalize-then-alias pipeline ingest runs. Re-reading from that base
 * is what makes the job idempotent: run it twice (or after any sequence of
 * alias edits) and the rows land in the same state. The raw column is set when
 * the stored value now differs from the base, and NULLed when they agree again.
 *
 * The plumbing is jobs/rewrite.ts's, shared with the referrer backfill and the
 * prop scrub: a settings watermark per table so a crash resumes where it
 * stopped, short chunked write transactions sharing the lock with ingest.
 *
 * Cost note: rewritten utm values change the utm marginals in `rollup_dim_day`
 * and `rollup_sessions_day`, so a completed backfill that changed ANY row runs
 * `rebuildAllRollups` — a per-day recompute over all history (chunked and
 * yielding, but minutes on a large file) — and then bumps the data epoch so
 * every pre-rewrite ETag expires (`settleRewrite`). A backfill that changed
 * nothing skips both.
 */

const WATERMARK_PREFIX = 'campaign_backfill:';
/** The durable debt `settleRewrite` pays: set with the first row changed. */
const DIRTY_SETTING = 'campaign_backfill:dirty';
const TABLES = ['events', 'sessions'] as const;
type BackfillTable = (typeof TABLES)[number];

/** Rows per transaction — prop-scrub's budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

const FIELDS = [
  { field: 'source', column: 'utm_source' },
  { field: 'medium', column: 'utm_medium' },
  { field: 'campaign', column: 'utm_campaign' },
] as const;

const UTM_COLUMNS = FIELDS.flatMap(({ column }) => [column, `${column}_raw`]);

/** Any utm state at all — rows with none can never change and are never read. */
const ANY_UTM = UTM_COLUMNS.map((column) => `${column} IS NOT NULL`).join(' OR ');

function selectChunk(table: BackfillTable): string {
  return `SELECT rowid AS rid, site_id, ${UTM_COLUMNS.join(', ')} FROM ${table}
WHERE rowid > ? AND (${ANY_UTM}) ORDER BY rowid LIMIT ?`;
}

function updateRow(table: BackfillTable): string {
  return `UPDATE ${table} SET ${UTM_COLUMNS.map((column) => `${column} = ?`).join(', ')}
WHERE rowid = ?`;
}

interface ChunkRow {
  rid: number;
  site_id: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_source_raw: string | null;
  utm_medium_raw: string | null;
  utm_campaign_raw: string | null;
}

function watermarkKey(table: BackfillTable): string {
  return `${WATERMARK_PREFIX}${table}`;
}

/** Enqueue a backfill — called INSIDE the alias route's write transaction, so
 * the alias rows and the promise to apply them commit together. */
export function requestCampaignBackfill(db: Db): void {
  for (const table of TABLES) setSetting(db, watermarkKey(table), '0');
}

export interface CampaignBackfillResult {
  /** True when this run drained both tables' watermarks, or paid a crashed run's rebuild. */
  completed: boolean;
  /** Rows whose stored utm state actually changed. */
  rows: number;
}

interface CampaignBackfillOptions {
  batchSize?: number;
}

/**
 * Drain the pending backfill, if any. Safe to call any time — the alias route
 * kicks it after a PUT, and the scheduler resumes whatever a crash left behind.
 */
export const runCampaignBackfill = oneRunAtATime((db: Db, options: CampaignBackfillOptions = {}) =>
  drain(db, options.batchSize ?? DEFAULT_BATCH_SIZE),
);

async function drain(db: Db, batchSize: number): Promise<CampaignBackfillResult> {
  const result: CampaignBackfillResult = { completed: false, rows: 0 };
  const enqueued = TABLES.some((table) => getSetting(db, watermarkKey(table)) !== undefined);
  // Loaded once per run: the aliases a chunk applies are the ones committed
  // when the run started; an edit mid-run re-enqueues and the next run catches it.
  const aliases = new AliasCache(db);

  for (const table of TABLES) {
    const setting = watermarkKey(table);
    if (getSetting(db, setting) === undefined) continue;
    const select = stmt<ChunkRow>(db, selectChunk(table));
    const update = stmt(db, updateRow(table));
    await inChunks(db, () => {
      const since = Number(getSetting(db, setting) ?? 0);
      const rows = select.all(since, batchSize) as ChunkRow[];
      if (rows.length === 0) {
        deleteSetting(db, setting);
        return true;
      }
      for (const row of rows) {
        const next: (string | null)[] = [];
        let changed = false;
        for (const { field, column } of FIELDS) {
          const rawColumn = `${column}_raw` as keyof ChunkRow;
          const current = row[column] as string | null;
          const storedRaw = row[rawColumn] as string | null;
          const base = storedRaw ?? current;
          if (base === null) {
            next.push(null, null);
            continue;
          }
          const canonical = canonicalUtmValue(base);
          const normalized =
            canonical === '' ? null : (aliases.resolve(row.site_id, field, canonical) ?? canonical);
          const raw = normalized === base ? null : base;
          next.push(normalized, raw);
          if (normalized !== current || raw !== storedRaw) changed = true;
        }
        if (changed) {
          update.run(...next, row.rid);
          result.rows += 1;
          markRewriteDirty(db, DIRTY_SETTING);
        }
      }
      setSetting(db, setting, String(rows[rows.length - 1]?.rid ?? since));
      return false;
    });
  }

  // Everything drained: the utm marginals in the rollups may now disagree with
  // raw, and cached ETags describe rewritten history.
  const settled = await settleRewrite(db, DIRTY_SETTING);
  result.completed = enqueued || settled;
  return result;
}
