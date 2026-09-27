import {
  bumpDataEpoch,
  type Db,
  deleteSetting,
  getSetting,
  setSetting,
  withWriteTransaction,
} from '../db/index.ts';
import { rebuildAllRollups } from '../rollup/rebuild.ts';

/**
 * The plumbing the chunked, watermarked history rewrites share (docs/02 §
 * Background jobs): one run per database at a time, short write transactions
 * with the event loop back between them, and — for a rewrite that moves a
 * rolled dimension — a durable flag that owes a rollup rebuild and an epoch
 * bump until both have happened.
 */

/**
 * Wraps a job so only one run per database is ever in flight: a second caller
 * (a route kick landing during the boot catch-up) rides the run already going.
 */
export function oneRunAtATime<Args extends unknown[], Result>(
  run: (db: Db, ...args: Args) => Promise<Result>,
): (db: Db, ...args: Args) => Promise<Result> {
  const inFlight = new WeakMap<Db, Promise<Result>>();
  return (db, ...args) => {
    const running = inFlight.get(db);
    if (running !== undefined) return running;
    const next = run(db, ...args).finally(() => {
      inFlight.delete(db);
    });
    inFlight.set(db, next);
    return next;
  };
}

/**
 * Runs `chunk` in a write transaction of its own, again and again until it
 * reports done, giving the event loop back before each: SQLite is synchronous,
 * and an unbroken rewrite would stall ingest and its 200 ms flush.
 */
export async function inChunks(db: Db, chunk: () => boolean): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (withWriteTransaction(db, chunk)) return;
  }
}

/**
 * Records that a rewrite owes `settleRewrite`. Called inside the chunk
 * transaction that changed a row, so the debt commits with the rewrite it
 * describes.
 */
export function markRewriteDirty(db: Db, dirtySetting: string): void {
  setSetting(db, dirtySetting, '1');
}

/**
 * What a rewrite of rolled dimensions owes once its watermarks are drained:
 * the rollups re-derived from the rewritten rows, then an epoch bump so every
 * pre-rewrite ETag expires (invariant 10), the flag cleared in the bump's own
 * transaction. Returns whether it ran.
 *
 * Gated on the durable flag, never on one run's tally, and checked whether or
 * not anything was left to drain: a run that rewrites rows and dies — mid-walk
 * or mid-rebuild — leaves the flag set, and whichever run comes next pays the
 * debt even when it finds no work of its own. Neither step is destructive to
 * repeat.
 */
export async function settleRewrite(db: Db, dirtySetting: string): Promise<boolean> {
  if (getSetting(db, dirtySetting) === undefined) return false;
  await rebuildAllRollups(db);
  withWriteTransaction(db, () => {
    bumpDataEpoch(db);
    deleteSetting(db, dirtySetting);
  });
  return true;
}
