import { BATCH_INTERVAL_MS } from '@featherstat/shared';
import {
  type Db,
  type EventRow,
  incrementBotDrops,
  incrementExcludedDrops,
  insertEvents,
  insertMissingHits,
  type MissingRow,
  type SessionRow,
  stmt,
  tombstonedSiteIds,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import {
  applyRollups,
  type SessionDelta,
  type SessionSnapshot,
  snapshotSession,
} from '../rollup/apply.ts';
import type { PropRegistry } from './props.ts';

export interface FlushSummary {
  events: number;
  sessions: number;
  botDrops: number;
  /** Hits refused because the client address matched an exclusion rule (docs/03 § Exclusions). */
  excludedDrops: number;
  /** Not-found hits, counted and stored up to the daily cap (docs/03 § Not-found hits). */
  missing: number;
  /** Sites whose event data changed — feeds the SSE per-site version ticks (docs/02). */
  siteIds: number[];
}

export type FlushHook = (summary: FlushSummary) => void;

interface DropEntry {
  siteId: number;
  localDate: string;
  count: number;
}

function countDrop(drops: Map<string, DropEntry>, siteId: number, localDate: string): void {
  const key = `${siteId}|${localDate}`;
  const entry = drops.get(key);
  if (entry !== undefined) entry.count += 1;
  else drops.set(key, { siteId, localDate, count: 1 });
}

function totalDrops(drops: readonly DropEntry[]): number {
  return drops.reduce((total, drop) => total + drop.count, 0);
}

/** One flush's worth of queued rows. */
interface Batch {
  events: EventRow[];
  sessions: SessionRow[];
  missing: MissingRow[];
  botDrops: DropEntry[];
  excludedDrops: DropEntry[];
}

/**
 * The batch minus every row of a site deleted since it queued. Read inside the
 * flush transaction, so a site delete either committed first — its stragglers
 * drop here — or commits after, and the purge it enqueues removes what landed.
 */
function withoutTombstoned(db: Db, batch: Batch): Batch {
  const dead = tombstonedSiteIds(db);
  if (dead.size === 0) return batch;
  return {
    events: batch.events.filter((row) => !dead.has(row.site_id)),
    sessions: batch.sessions.filter((row) => !dead.has(row.site_id)),
    missing: batch.missing.filter((row) => !dead.has(row.site_id)),
    botDrops: batch.botDrops.filter((drop) => !dead.has(drop.siteId)),
    excludedDrops: batch.excludedDrops.filter((drop) => !dead.has(drop.siteId)),
  };
}

/**
 * The single writer (docs/02): everything the pipeline produces queues here and
 * lands in ONE transaction per interval — events insert + sessions upsert +
 * not-found hits + the drop counters. A hard crash loses at most one interval
 * of hits.
 */
export class WriteBatcher {
  private events: EventRow[] = [];
  private missing: MissingRow[] = [];
  /**
   * Deduped by row identity: the sessionizer mutates one live row per open
   * session, so whatever state that row holds at flush time is what lands.
   */
  private readonly sessions = new Set<SessionRow>();
  private readonly botDrops = new Map<string, DropEntry>();
  private readonly excludedDrops = new Map<string, DropEntry>();
  private readonly hooks: FlushHook[] = [];
  private timer: NodeJS.Timeout | undefined;
  /**
   * Each live session row's state as last COMMITTED — what the rollup deltas
   * subtract (docs/03 § Rollups). Advanced only after a successful flush, so a
   * retried flush recomputes the same deltas it failed to land; keyed by row
   * identity because the sessionizer mutates one live object per open session.
   */
  private readonly committed = new WeakMap<SessionRow, SessionSnapshot>();
  /**
   * Test seam: runs inside the flush transaction, after every write. The drift
   * suite makes one flush throw here to prove a retry double-counts nothing —
   * there is no other way to fail a flush without also poisoning the retry.
   */
  beforeCommit: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly intervalMs: number = BATCH_INTERVAL_MS,
    /** Prop-registry deltas ride the same flush transaction as the events they
     * shaped (docs/03 § Props, invariant 2) — exactly as rollups do. */
    private readonly props?: PropRegistry,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer and flushes whatever is queued — graceful shutdown. True
   * when nothing is left queued, false when the flush failed and every row it
   * held is still in memory; calling again retries.
   */
  stop(): boolean {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
    return this.pending === 0;
  }

  addEvent(row: EventRow): void {
    this.events.push(row);
  }

  /** One upsert per dirty session per flush, whatever its state is by then. */
  addSession(row: SessionRow): void {
    this.sessions.add(row);
  }

  /**
   * Marks `row` as already committed with its CURRENT values — restart recovery
   * and session revival, where the row was just read back from the store. Without
   * this the next flush would book the revived session as a brand-new visit.
   */
  seedSnapshot(row: SessionRow): void {
    this.committed.set(row, snapshotSession(row));
  }

  addMissing(row: MissingRow): void {
    this.missing.push(row);
  }

  addBotDrop(siteId: number, localDate: string): void {
    countDrop(this.botDrops, siteId, localDate);
  }

  addExcludedDrop(siteId: number, localDate: string): void {
    countDrop(this.excludedDrops, siteId, localDate);
  }

  onFlush(hook: FlushHook): void {
    this.hooks.push(hook);
  }

  get pending(): number {
    return (
      this.events.length +
      this.sessions.size +
      this.missing.length +
      this.botDrops.size +
      this.excludedDrops.size +
      // A prop drop can queue with no event beside it (an orphan heartbeat's
      // bag); counting it here is what gets that flush scheduled at all.
      (this.props?.pendingCount ?? 0)
    );
  }

  flush(): FlushSummary | undefined {
    if (this.pending === 0) return undefined;
    const queued: Batch = {
      events: this.events,
      sessions: [...this.sessions],
      missing: this.missing,
      botDrops: [...this.botDrops.values()],
      excludedDrops: [...this.excludedDrops.values()],
    };

    let landed: Batch;
    try {
      landed = withWriteTransaction(this.db, () => {
        const batch = withoutTombstoned(this.db, queued);
        // Read before the inserts, inside the transaction: `id > sinceEventId`
        // is then exactly this flush's rows, and a rolled-back attempt reads
        // the same value again on retry.
        const sinceEventId = stmt(this.db, 'SELECT COALESCE(MAX(id), 0) FROM events')
          .pluck()
          .get() as number;
        insertEvents(this.db, batch.events);
        upsertSessions(this.db, batch.sessions);
        insertMissingHits(this.db, batch.missing);
        for (const drop of batch.botDrops) {
          incrementBotDrops(this.db, drop.siteId, drop.localDate, drop.count);
        }
        for (const drop of batch.excludedDrops) {
          incrementExcludedDrops(this.db, drop.siteId, drop.localDate, drop.count);
        }
        const deltas: SessionDelta[] = batch.sessions.map((row) => ({
          row,
          before: this.committed.get(row),
        }));
        applyRollups(this.db, sinceEventId, batch.events, deltas);
        this.props?.apply(this.db);
        this.beforeCommit?.();
        return batch;
      });
    } catch (error) {
      // Everything stays queued and the next interval retries: dropping the
      // batch would leave in-memory session state (seq, counters) permanently
      // ahead of the events table. A crash still loses only what is queued —
      // the accepted docs/02 trade. Snapshots deliberately do NOT advance here,
      // so the retry recomputes the same rollup deltas against the same base.
      console.error('batch flush failed, retrying next interval:', error);
      return undefined;
    }
    // Only now, after the commit, does "committed" move: better-sqlite3 is
    // synchronous, so nothing can have mutated the rows since they were written.
    for (const row of landed.sessions) this.committed.set(row, snapshotSession(row));
    this.props?.committed();
    this.events = [];
    this.missing = [];
    this.sessions.clear();
    this.botDrops.clear();
    this.excludedDrops.clear();

    const siteIds = new Set<number>();
    for (const event of landed.events) siteIds.add(event.site_id);
    for (const session of landed.sessions) siteIds.add(session.site_id);
    for (const row of landed.missing) siteIds.add(row.site_id);
    const summary: FlushSummary = {
      events: landed.events.length,
      sessions: landed.sessions.length,
      botDrops: totalDrops(landed.botDrops),
      excludedDrops: totalDrops(landed.excludedDrops),
      missing: landed.missing.length,
      siteIds: [...siteIds],
    };
    for (const hook of this.hooks) hook(summary);
    return summary;
  }
}
