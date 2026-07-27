import { BATCH_INTERVAL_MS } from '@analytics/shared';
import {
  type Db,
  type EventRow,
  incrementBotDrops,
  insertEvents,
  type SessionRow,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';

export interface FlushSummary {
  events: number;
  sessions: number;
  botDrops: number;
  /** Sites whose event data changed — feeds the SSE per-site version ticks (docs/02). */
  siteIds: number[];
}

export type FlushHook = (summary: FlushSummary) => void;

interface BotDropEntry {
  siteId: number;
  localDate: string;
  count: number;
}

/**
 * The single writer (docs/02): everything the pipeline produces queues here and
 * lands in ONE transaction per interval — events insert + sessions upsert +
 * bot-drop counters. A hard crash loses at most one interval of hits.
 */
export class WriteBatcher {
  private events: EventRow[] = [];
  /**
   * Deduped by row identity: the sessionizer mutates one live row per open
   * session, so whatever state that row holds at flush time is what lands.
   */
  private readonly sessions = new Set<SessionRow>();
  private readonly botDrops = new Map<string, BotDropEntry>();
  private readonly hooks: FlushHook[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly intervalMs: number = BATCH_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stops the timer and flushes whatever is queued — graceful shutdown. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }

  addEvent(row: EventRow): void {
    this.events.push(row);
  }

  /** One upsert per dirty session per flush, whatever its state is by then. */
  addSession(row: SessionRow): void {
    this.sessions.add(row);
  }

  addBotDrop(siteId: number, localDate: string): void {
    const key = `${siteId}|${localDate}`;
    const entry = this.botDrops.get(key);
    if (entry !== undefined) entry.count += 1;
    else this.botDrops.set(key, { siteId, localDate, count: 1 });
  }

  onFlush(hook: FlushHook): void {
    this.hooks.push(hook);
  }

  get pending(): number {
    return this.events.length + this.sessions.size + this.botDrops.size;
  }

  flush(): FlushSummary | undefined {
    if (this.pending === 0) return undefined;
    const events = this.events;
    const sessions = [...this.sessions];
    const botDrops = [...this.botDrops.values()];

    try {
      withWriteTransaction(this.db, () => {
        insertEvents(this.db, events);
        upsertSessions(this.db, sessions);
        for (const drop of botDrops) {
          incrementBotDrops(this.db, drop.siteId, drop.localDate, drop.count);
        }
      });
    } catch (error) {
      // Everything stays queued and the next interval retries: dropping the
      // batch would leave in-memory session state (seq, counters) permanently
      // ahead of the events table. A crash still loses only what is queued —
      // the accepted docs/02 trade.
      console.error('batch flush failed, retrying next interval:', error);
      return undefined;
    }
    this.events = [];
    this.sessions.clear();
    this.botDrops.clear();

    const siteIds = new Set<number>();
    for (const event of events) siteIds.add(event.site_id);
    for (const session of sessions) siteIds.add(session.site_id);
    const summary: FlushSummary = {
      events: events.length,
      sessions: sessions.length,
      botDrops: botDrops.reduce((total, drop) => total + drop.count, 0),
      siteIds: [...siteIds],
    };
    for (const hook of this.hooks) hook(summary);
    return summary;
  }
}
