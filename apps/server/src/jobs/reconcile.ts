import { DAY_MS, localClock } from '@featherstat/shared';
import { type Db, listSites, withReadSnapshot, withWriteTransaction } from '../db/index.ts';
import { rebuildRollupDay } from '../rollup/rebuild.ts';
import { type RollupDiscrepancy, verifyRollupDay } from '../rollup/verify.ts';

/**
 * Nightly rollup reconcile (docs/03 § Rollups, plan risk #1): recompute
 * yesterday from raw rows per site, diff against the stored rollup rows, and
 * repair any drift with a per-day rebuild.
 *
 * Drift here is never routine maintenance — the flush path is PROVEN
 * equivalent to the rebuild by the replay ratchet, so a discrepancy in
 * production means a delta-logic bug slipped past it. The job repairs the day
 * (so dashboards heal immediately) but also logs loudly and counts the repair
 * in /metrics, because the repair treats a symptom whose cause needs a fix.
 *
 * Yesterday, site-local, on purpose: today is still being written, and days
 * before yesterday were checked by earlier runs — one day per site keeps the
 * job O(day), not O(history).
 */

export interface ReconcileResult {
  /** (site, day) pairs verified. */
  checked: number;
  /** Pairs found drifted and rebuilt. */
  repaired: number;
  /** Total drifted cells across those pairs. */
  cells: number;
}

export interface ReconcileOptions {
  now?: () => number;
}

export async function runReconcile(
  db: Db,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const now = options.now?.() ?? Date.now();
  const result: ReconcileResult = { checked: 0, repaired: 0, cells: 0 };

  for (const site of listSites(db)) {
    // One event-loop yield per site: verification is synchronous SQLite work
    // on the writer's thread (jobs/retention.ts's batching discipline).
    if (result.checked > 0) await new Promise((resolve) => setImmediate(resolve));
    const yesterday = localYesterday(site.timezone, now);
    // One snapshot per (site, day): a flush landing between the recompute and
    // the stored read would otherwise report phantom drift.
    const drift = withReadSnapshot(db, () => verifyRollupDay(db, site.id, yesterday));
    result.checked += 1;
    if (drift.length === 0) continue;

    console.error(
      `rollup reconcile: site ${site.id} @ ${yesterday} drifted in ${drift.length} cell(s) — ` +
        'the incremental flush path disagrees with a recompute from raw. This is a ' +
        `delta-logic BUG, repaired for now by rebuilding the day. First: ${describe(drift[0])}`,
    );
    withWriteTransaction(db, () => rebuildRollupDay(db, site.id, yesterday, { now: options.now }));
    result.repaired += 1;
    result.cells += drift.length;
  }
  return result;
}

function describe(entry: RollupDiscrepancy | undefined): string {
  if (entry === undefined) return '(none)';
  return `${entry.table}[${entry.key}].${entry.column} stored ${entry.actual}, raw says ${entry.expected}`;
}

/** The local date before the site's current one. */
function localYesterday(timezone: string, now: number): string {
  const today = localClock(timezone, now).date;
  return new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}
