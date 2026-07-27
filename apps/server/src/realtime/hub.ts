import { ACTIVE_WINDOW_MS, type RealtimeHit, type VersionTick } from '@analytics/shared';
import { type Db, type EventRow, listSites, stmt } from '../db/index.ts';
import type { FlushSummary } from '../pipeline/batcher.ts';

/**
 * The realtime hub (docs/02 § Realtime hub, docs/04 § 4): a ring buffer of the
 * most recent enriched hits plus per-site active-visitor counts, fanned out to
 * every SSE subscriber. It is fed straight from the pipeline — the live feed
 * must not wait for the 200 ms batch flush — and from the batcher's flush hook,
 * whose per-site version ticks are what make every dashboard live by default.
 *
 * Privacy is structural here: `toRealtimeHit` is the only path from a stored row
 * to a wire shape, and visitor ids never leave `ActiveVisitors`, where they
 * exist purely to make a count distinct (CLAUDE.md invariant 3).
 */

/** Hits retained for `Last-Event-ID` resume; a slower reconnect gets what is left. */
const RING_CAPACITY = 500;

export interface RealtimeEntry {
  /** Monotonic within the process: the SSE `id:` field and the resume cursor. */
  id: number;
  hit: RealtimeHit;
}

export type RealtimeMessage =
  | { kind: 'hit'; entry: RealtimeEntry }
  | { kind: 'version'; tick: VersionTick };

export type RealtimeListener = (message: RealtimeMessage) => void;

export interface RealtimeHubOptions {
  capacity?: number;
}

export class RealtimeHub {
  private readonly ring: HitRing;
  private readonly active: ActiveVisitors;
  private readonly versions = new Map<number, number>();
  private readonly listeners = new Set<RealtimeListener>();

  constructor(options: RealtimeHubOptions = {}) {
    this.ring = new HitRing(options.capacity ?? RING_CAPACITY);
    this.active = new ActiveVisitors(ACTIVE_WINDOW_MS);
  }

  /**
   * Post-enrichment hook: called for every stored hit as it happens. Pings keep
   * their visitor active but are not feed items (docs/04 § 4).
   */
  record(event: EventRow): void {
    this.active.touch(event.site_id, event.visitor_id, event.ts);
    if (event.type === 'ping') return;
    this.emit({ kind: 'hit', entry: this.ring.push(toRealtimeHit(event)) });
  }

  /** One tick per site whose data changed in a batch — dashboards revalidate on it. */
  recordFlush(summary: FlushSummary): void {
    for (const siteId of summary.siteIds) {
      const version = (this.versions.get(siteId) ?? 0) + 1;
      this.versions.set(siteId, version);
      this.emit({ kind: 'version', tick: { siteId, version } });
    }
  }

  /** Distinct visitors per site inside the active window; sites idle since boot report 0. */
  activeCounts(now = Date.now()): Record<number, number> {
    return this.active.counts(now);
  }

  /**
   * The newest `limit` hits `matches` accepts, oldest first — a fresh
   * connection's feed. Filtering happens inside the ring walk, so a quiet site
   * is never starved out of its snapshot by a busier one (docs/04 § 4).
   */
  recent(limit: number, matches: (hit: RealtimeHit) => boolean = () => true): RealtimeHit[] {
    return this.ring.last(limit, (entry) => matches(entry.hit)).map((entry) => entry.hit);
  }

  /** Retained entries after `id`, oldest first: the `Last-Event-ID` resume path. */
  since(id: number): RealtimeEntry[] {
    return this.ring.since(id);
  }

  /** Retained (site, visitor) entries — a memory diagnostic, never identity. */
  trackedVisitors(): number {
    return this.active.size();
  }

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Boot seeding (docs/04 § 4): sessions still inside the active window restore
   * the live counter, so a restart does not blank it for five minutes. Every
   * known site is registered too, so a quiet one reports 0 instead of nothing.
   */
  seedActive(db: Db, now = Date.now()): void {
    for (const site of listSites(db)) this.active.register(site.id);
    for (const row of stmt<ActiveSessionRow>(db, SQL_ACTIVE_SESSIONS).all(
      now - this.active.windowMs,
    )) {
      this.active.touch(row.site_id, row.visitor_id, row.last_seen_at);
    }
  }

  private emit(message: RealtimeMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/** Builds the hub and seeds it from the open sessions already in the database. */
export function createRealtimeHub(db: Db, options: RealtimeHubOptions = {}): RealtimeHub {
  const hub = new RealtimeHub(options);
  hub.seedActive(db);
  return hub;
}

interface ActiveSessionRow {
  site_id: number;
  visitor_id: Uint8Array;
  last_seen_at: number;
}

const SQL_ACTIVE_SESSIONS = `SELECT site_id, visitor_id, MAX(last_seen_at) AS last_seen_at
FROM sessions WHERE last_seen_at >= ? GROUP BY site_id, visitor_id`;

/**
 * The projection every realtime consumer sees. Enumerating the fields — rather
 * than spreading the row — is what keeps the IP-derived visitor id, and anything
 * else added to `events` later, off the wire. Undefined members vanish in JSON.
 */
function toRealtimeHit(event: EventRow): RealtimeHit {
  return {
    siteId: event.site_id,
    ts: event.ts,
    type: event.type,
    path: event.path ?? undefined,
    eventCategory: event.event_category ?? undefined,
    eventAction: event.event_action ?? undefined,
    country: event.country ?? undefined,
    city: event.city ?? undefined,
    lat: event.lat ?? undefined,
    lon: event.lon ?? undefined,
    deviceType: event.device_type ?? undefined,
  };
}

/**
 * Fixed-capacity ring. Ids are 1-based and never reused, so the id of the newest
 * entry doubles as the count of everything ever pushed.
 */
class HitRing {
  private readonly slots: Array<RealtimeEntry | undefined>;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Array<RealtimeEntry | undefined>(capacity);
  }

  push(hit: RealtimeHit): RealtimeEntry {
    this.count += 1;
    const entry: RealtimeEntry = { id: this.count, hit };
    this.slots[(this.count - 1) % this.capacity] = entry;
    return entry;
  }

  /** The newest `n` entries `matches` accepts, oldest first. */
  last(n: number, matches: (entry: RealtimeEntry) => boolean): RealtimeEntry[] {
    const oldest = Math.max(1, this.count - this.capacity + 1);
    const found: RealtimeEntry[] = [];
    for (let id = this.count; id >= oldest && found.length < n; id -= 1) {
      const entry = this.slots[(id - 1) % this.capacity];
      if (entry !== undefined && matches(entry)) found.push(entry);
    }
    return found.reverse();
  }

  /** Entries with `id > since`, oldest first — everything retained if `since` is stale. */
  since(since: number): RealtimeEntry[] {
    const oldest = Math.max(1, this.count - this.capacity + 1);
    const entries: RealtimeEntry[] = [];
    for (let id = Math.max(oldest, since + 1); id <= this.count; id += 1) {
      const entry = this.slots[(id - 1) % this.capacity];
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }
}

/**
 * Distinct visitors per site inside the active window. The visitor id is held as
 * hex only to make that count distinct: it is never read back out, and no method
 * here returns anything but numbers.
 */
class ActiveVisitors {
  private readonly bySite = new Map<number, Map<string, number>>();
  private lastPruneAt = 0;

  constructor(readonly windowMs: number) {}

  /** Makes a site countable before it has any traffic. */
  register(siteId: number): Map<string, number> {
    let visitors = this.bySite.get(siteId);
    if (visitors === undefined) {
      visitors = new Map();
      this.bySite.set(siteId, visitors);
    }
    return visitors;
  }

  touch(siteId: number, visitorId: Uint8Array, ts: number): void {
    // Opportunistic eviction: `counts()` only runs while an SSE client is
    // connected, and daily-rotating visitor ids never repeat a key — without
    // this, an unwatched server would retain every (site, visitor, day) forever.
    if (ts - this.lastPruneAt >= this.windowMs) {
      this.prune(ts);
      this.lastPruneAt = ts;
    }
    const visitors = this.register(siteId);
    const key = Buffer.from(visitorId).toString('hex');
    const seen = visitors.get(key);
    if (seen === undefined || ts > seen) visitors.set(key, ts);
  }

  /**
   * Prunes what fell out of the window, then counts. A site keeps its entry once
   * seen, so a stream that reported 3 later reports 0 instead of going silent.
   */
  counts(now: number): Record<number, number> {
    this.prune(now);
    const counts: Record<number, number> = {};
    for (const [siteId, visitors] of this.bySite) counts[siteId] = visitors.size;
    return counts;
  }

  /** Total retained (site, visitor) entries. */
  size(): number {
    let total = 0;
    for (const visitors of this.bySite.values()) total += visitors.size;
    return total;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const visitors of this.bySite.values()) {
      for (const [key, ts] of visitors) {
        if (ts < cutoff) visitors.delete(key);
      }
    }
  }
}
