import {
  bumpDataEpoch,
  type Db,
  deleteSetting,
  getSetting,
  setSetting,
  stmt,
  withWriteTransaction,
} from '../db/index.ts';
import { canonicalReferrerDomain, referrerTypeOf } from '../pipeline/referrers.ts';
import { rebuildAllRollups } from '../rollup/rebuild.ts';

/**
 * Referrer backfill (docs/03 § Attribution): every stored referrer is
 * re-derived from `COALESCE(ref_domain_raw, ref_domain)` — the as-received host
 * when canonicalization ever changed it, the current value otherwise — through
 * the SAME function ingest runs. Re-reading from that base is what makes the
 * job idempotent: run it twice, or after an edit to the keep-distinct/alias
 * tables, and the rows land in the same state. `ref_domain_raw` is set when the
 * stored value now differs from the base, and NULLed when they agree again.
 * `ref_type` follows the new host wherever it can (see `DERIVABLE_TYPES`).
 *
 * Shape mirrors jobs/campaign-backfill.ts exactly: a settings watermark per
 * table so a crash resumes where it stopped, short chunked write transactions
 * sharing the lock with ingest, an event-loop yield between chunks.
 *
 * Cost note: `ref_domain` is a rolled dimension, so a backfill that changed ANY
 * row runs `rebuildAllRollups` — a per-day recompute over all history — and
 * then bumps the data epoch so every pre-rewrite ETag expires (invariant 10).
 * A backfill that changed nothing skips both.
 */

const WATERMARK_PREFIX = 'referrer_backfill:';
const TABLES = ['events', 'sessions'] as const;
type BackfillTable = (typeof TABLES)[number];

/** Rows per transaction — campaign-backfill's budget, for the same shared-lock reason. */
const DEFAULT_BATCH_SIZE = 5_000;

/** Rows with no referrer at all can never change and are never read. */
function selectChunk(table: BackfillTable): string {
  return `SELECT rowid AS rid, ref_domain, ref_domain_raw, ref_type FROM ${table}
WHERE rowid > ? AND (ref_domain IS NOT NULL OR ref_domain_raw IS NOT NULL)
ORDER BY rowid LIMIT ?`;
}

function updateRow(table: BackfillTable): string {
  return `UPDATE ${table} SET ref_domain = ?, ref_domain_raw = ?, ref_type = ? WHERE rowid = ?`;
}

/**
 * The classifications that follow from the host alone, so collapsing the host
 * can change them: an `fb.me` row must not stay `referral` once it reads
 * `facebook.com`. `campaign` and `internal` come from the landing URL and the
 * site's own domains, which this job cannot see — those rows keep their type.
 */
const DERIVABLE_TYPES: ReadonlySet<string> = new Set(['search', 'social', 'referral']);

interface ChunkRow {
  rid: number;
  ref_domain: string | null;
  ref_domain_raw: string | null;
  ref_type: string | null;
}

function watermarkKey(table: BackfillTable): string {
  return `${WATERMARK_PREFIX}${table}`;
}

/** Enqueue a backfill. Migration 101 does this in SQL; callers re-arm it after a table edit. */
export function requestReferrerBackfill(db: Db): void {
  for (const table of TABLES) setSetting(db, watermarkKey(table), '0');
}

export interface ReferrerBackfillResult {
  /** True when both tables' watermarks were drained this run. */
  completed: boolean;
  /** Rows whose stored referrer state actually changed. */
  rows: number;
}

interface ReferrerBackfillOptions {
  batchSize?: number;
}

/** One run in flight per db: a second caller just rides the first. */
const inFlight = new WeakMap<Db, Promise<ReferrerBackfillResult>>();

/** Drain the pending backfill, if any. Safe to call any time. */
export function runReferrerBackfill(
  db: Db,
  options: ReferrerBackfillOptions = {},
): Promise<ReferrerBackfillResult> {
  const running = inFlight.get(db);
  if (running !== undefined) return running;
  const run = drain(db, options.batchSize ?? DEFAULT_BATCH_SIZE).finally(() => {
    inFlight.delete(db);
  });
  inFlight.set(db, run);
  return run;
}

async function drain(db: Db, batchSize: number): Promise<ReferrerBackfillResult> {
  const result: ReferrerBackfillResult = { completed: false, rows: 0 };
  if (TABLES.every((table) => getSetting(db, watermarkKey(table)) === undefined)) {
    return result; // nothing enqueued
  }

  for (const table of TABLES) {
    const setting = watermarkKey(table);
    if (getSetting(db, setting) === undefined) continue;
    const select = stmt<ChunkRow>(db, selectChunk(table));
    const update = stmt(db, updateRow(table));
    for (;;) {
      // The event-loop yield between chunks: SQLite is synchronous, and an
      // unbroken rewrite would stall ingest and its 200 ms flush.
      await new Promise((resolve) => setImmediate(resolve));
      const done = withWriteTransaction(db, () => {
        const since = Number(getSetting(db, setting) ?? 0);
        const rows = select.all(since, batchSize) as ChunkRow[];
        if (rows.length === 0) {
          deleteSetting(db, setting);
          return true;
        }
        for (const row of rows) {
          const base = row.ref_domain_raw ?? row.ref_domain;
          if (base === null) continue;
          const canonical = canonicalReferrerDomain(base);
          const raw = canonical === base ? null : base;
          const type =
            row.ref_type !== null && DERIVABLE_TYPES.has(row.ref_type)
              ? referrerTypeOf(canonical)
              : row.ref_type;
          if (canonical === row.ref_domain && raw === row.ref_domain_raw && type === row.ref_type) {
            continue;
          }
          update.run(canonical, raw, type, row.rid);
          result.rows += 1;
        }
        setSetting(db, setting, String(rows[rows.length - 1]?.rid ?? since));
        return false;
      });
      if (done) break;
    }
  }

  // Everything drained: the ref_domain marginals in the rollups may now
  // disagree with raw, and cached ETags describe rewritten history.
  if (result.rows > 0) {
    await rebuildAllRollups(db);
    withWriteTransaction(db, () => bumpDataEpoch(db));
  }
  result.completed = true;
  return result;
}
