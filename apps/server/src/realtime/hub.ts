import {
  ACTIVE_WINDOW_MS,
  isHeartbeat,
  MAX_ENGAGEMENT_ENTRIES,
  PING_CLAMP_MS,
  type RealtimeEngagement,
  type RealtimeHit,
  type RealtimeVisitor,
  SESSION_TIMEOUT_MS,
  TALLY_WINDOW_MS,
  type VersionTick,
} from '@featherstat/shared';
import { type Db, type EventRow, listSites, stmt } from '../db/index.ts';
import type { FlushSummary } from '../pipeline/batcher.ts';
import { populationWhere } from '../query/population.ts';
import { VisitorAliaser } from './alias.ts';

/**
 * The realtime hub (docs/02 § Realtime hub, docs/04 § 4): a ring buffer of the
 * most recent enriched hits, per-site active-visitor counts, and per-visitor
 * engaged time, fanned out to every SSE subscriber. It is fed straight from the
 * pipeline — the live feed must not wait for the 200 ms batch flush — and from
 * the batcher's flush hook, whose per-site version ticks are what make every
 * dashboard live by default.
 *
 * Privacy is structural here: `toRealtimeHit` is the only path from a stored row
 * to a wire shape, and visitor ids never leave `ActiveVisitors` and
 * `VisitorEngagement`, where they exist purely as map keys (CLAUDE.md
 * invariant 3). The one identity-shaped thing on the wire is the ephemeral
 * per-day alias, a one-way derivation that resets at 00:00 UTC (docs/03 §
 * Visitor identity).
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
  private readonly engagement = new VisitorEngagement(TALLY_WINDOW_MS, MAX_ENGAGEMENT_ENTRIES);
  private readonly aliaser = new VisitorAliaser();
  private readonly versions = new Map<number, number>();
  private readonly listeners = new Set<RealtimeListener>();

  constructor(options: RealtimeHubOptions = {}) {
    this.ring = new HitRing(options.capacity ?? RING_CAPACITY);
    this.active = new ActiveVisitors(ACTIVE_WINDOW_MS);
  }

  /**
   * Post-enrichment hook: called for every stored hit as it happens. Pings keep
   * their visitor active and accrue engaged time, but are not feed items
   * (docs/04 § 4) — the heartbeat is precisely what makes the time honest.
   *
   * "Active now" therefore counts the `presence` population — every stored hit —
   * while the `visitors` KPI counts `actions`. That difference is deliberate and
   * not an inconsistency: a reader holding a tab open IS here now, and did not
   * act today. `isHeartbeat` is the same definition the compiler's `actions`
   * population is built from, imported rather than respelled.
   */
  record(event: EventRow): void {
    const visitor = this.aliaser.alias(event.visitor_id, event.ts);
    this.active.touch(event.site_id, event.visitor_id, event.ts);
    // Touch first: the figure the row carries includes the gap this hit closes.
    const engagedMs = this.engagement.touch(event.site_id, event.visitor_id, event.ts, visitor);
    if (isHeartbeat(event.type)) return;
    this.emit({ kind: 'hit', entry: this.ring.push(toRealtimeHit(event, visitor, engagedMs)) });
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

  /** Engaged time per visitor seen inside the tally window — aliases only, never identity. */
  visitors(now = Date.now()): RealtimeEngagement[] {
    return this.engagement.entries(now);
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

  /** Retained engagement entries — the same diagnostic for the wider window. */
  trackedEngagement(): number {
    return this.engagement.size();
  }

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Boot seeding (docs/04 § 4): stored sessions restore both live figures, so a
   * deploy neither blanks the counter for five minutes nor zeroes everyone's
   * engaged time. One query spans the wider of the two windows; the counter
   * takes only the rows still inside its own. Every known site is registered
   * too, so a quiet one reports 0 instead of nothing.
   */
  seedSessions(db: Db, now = Date.now()): void {
    for (const site of listSites(db)) this.active.register(site.id);
    for (const row of stmt<RecentSessionRow>(db, SQL_RECENT_SESSIONS).all(
      now - this.engagement.windowMs,
    )) {
      if (row.last_seen_at >= now - this.active.windowMs) {
        this.active.touch(row.site_id, row.visitor_id, row.last_seen_at);
      }
      this.engagement.seed(
        row.site_id,
        row.visitor_id,
        row.engaged_ms,
        row.last_seen_at,
        this.aliaser.alias(row.visitor_id, row.last_seen_at),
      );
    }
  }

  /**
   * Boot seeding of the feed itself: the newest stored non-ping events refill
   * the ring, so a restart (every deploy) no longer blanks the realtime view.
   * Same projection and aliaser as the live path — within a UTC day, seeded
   * hits wear the same names live ones did. Pushed oldest-first so ring ids
   * stay monotonic; pre-restart resume cursors keep the documented
   * "gets what's left" semantics (docs/04 § 4).
   */
  seedRecent(db: Db, limit = SEED_RECENT_LIMIT): void {
    const rows = stmt<SeededEventRow>(db, SQL_RECENT_EVENTS).all(limit);
    for (const row of rows.reverse()) {
      this.ring.push(
        toRealtimeHit(row, this.aliaser.alias(row.visitor_id, row.ts), row.engaged_ms ?? undefined),
      );
    }
  }

  private emit(message: RealtimeMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/** Builds the hub and seeds it from the open sessions already in the database. */
export function createRealtimeHub(db: Db, options: RealtimeHubOptions = {}): RealtimeHub {
  const hub = new RealtimeHub(options);
  hub.seedSessions(db);
  hub.seedRecent(db);
  return hub;
}

const SEED_RECENT_LIMIT = 50;

/**
 * The visit's length rides along from `sessions`: a restored row carries its
 * visit's total rather than the moment (the moment is not reconstructable), and
 * for the last row of a finished visit those are the same number.
 */
const SQL_RECENT_EVENTS = `SELECT e.*, s.engaged_ms FROM events e
LEFT JOIN sessions s ON s.id = e.session_id
WHERE ${populationWhere('actions', 'e')}
ORDER BY e.id DESC
LIMIT ?`;

type SeededEventRow = EventRow & { engaged_ms: number | null };

interface RecentSessionRow {
  site_id: number;
  visitor_id: Uint8Array;
  last_seen_at: number;
  engaged_ms: number;
}

/**
 * Newest session per (site, visitor). `engaged_ms` is a bare column beside a
 * lone `MAX()`, which SQLite defines as coming from the row that produced the
 * maximum — so the engaged time restored is the one belonging to that last
 * session, matching the in-memory rule that a new visit starts a new figure.
 */
const SQL_RECENT_SESSIONS = `SELECT site_id, visitor_id, MAX(last_seen_at) AS last_seen_at, engaged_ms
FROM sessions WHERE last_seen_at >= ? GROUP BY site_id, visitor_id`;

/**
 * The projection every realtime consumer sees. Enumerating the fields — rather
 * than spreading the row — is what keeps the IP-derived visitor id, and anything
 * else added to `events` later, off the wire. Undefined members vanish in JSON.
 */
function toRealtimeHit(event: EventRow, visitor: RealtimeVisitor, engagedMs?: number): RealtimeHit {
  return {
    siteId: event.site_id,
    ts: event.ts,
    type: event.type,
    visitor,
    // 0 is "no time on the clock yet" — a row says nothing rather than `0s`.
    engagedMs: engagedMs !== undefined && engagedMs > 0 ? engagedMs : undefined,
    path: event.path ?? undefined,
    eventCategory: event.event_category ?? undefined,
    eventAction: event.event_action ?? undefined,
    country: event.country ?? undefined,
    region: event.region ?? undefined,
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

/**
 * Engaged time per (site, visitor), accrued exactly as the sessionizer accrues
 * `engaged_ms` (docs/03): every event — pings included — credits the gap since
 * that visitor's last one, clamped at `PING_CLAMP_MS`.
 *
 * A gap past the session timeout starts the figure over rather than continuing
 * it. That is the "time on site" reading the card wants: a visitor who returns
 * after lunch is on a fresh visit, and their card should say how long THIS one
 * has been going, not sum a day of them.
 *
 * As in `ActiveVisitors`, the visitor id is here only as a map key; what leaves
 * is the per-day alias the hits already wear (CLAUDE.md invariant 3).
 */
class VisitorEngagement {
  private readonly byVisitor = new Map<string, RealtimeEngagement>();
  private lastPruneAt = 0;

  constructor(
    readonly windowMs: number,
    readonly maxEntries: number,
  ) {}

  /** Returns the visit's length including this event — what the hit's row keeps. */
  touch(siteId: number, visitorId: Uint8Array, ts: number, visitor: RealtimeVisitor): number {
    // Opportunistic eviction, exactly as in ActiveVisitors: without it an
    // unwatched server would retain every (site, visitor, day) forever.
    if (ts - this.lastPruneAt >= this.windowMs) {
      this.prune(ts);
      this.lastPruneAt = ts;
    }
    const entry = this.byVisitor.get(visitorKey(siteId, visitorId));
    if (entry === undefined || ts - entry.lastTs > SESSION_TIMEOUT_MS) {
      this.seed(siteId, visitorId, 0, ts, visitor);
      return 0;
    }
    entry.engagedMs += Math.min(Math.max(ts - entry.lastTs, 0), PING_CLAMP_MS);
    entry.lastTs = ts;
    // The alias re-mints at 00:00 UTC and the hits follow it, so this must too —
    // otherwise the entry keeps a name no row in the feed still wears.
    entry.ref = visitor.ref;
    entry.name = visitor.name;
    entry.color = visitor.color;
    return entry.engagedMs;
  }

  /** Boot seeding: a stored session's engaged time and last-seen resume the figure. */
  seed(
    siteId: number,
    visitorId: Uint8Array,
    engagedMs: number,
    ts: number,
    visitor: RealtimeVisitor,
  ): void {
    this.byVisitor.set(visitorKey(siteId, visitorId), {
      ref: visitor.ref,
      name: visitor.name,
      color: visitor.color,
      siteId,
      engagedMs,
      lastTs: ts,
    });
    this.enforceCap();
  }

  /** Over cap, the oldest visit drops — exact at insertion, not eventually. */
  private enforceCap(): void {
    if (this.byVisitor.size <= this.maxEntries) return;
    const oldestFirst = [...this.byVisitor].sort((a, b) => a[1].lastTs - b[1].lastTs);
    for (const [key] of oldestFirst.slice(0, this.byVisitor.size - this.maxEntries)) {
      this.byVisitor.delete(key);
    }
  }

  /** Copies, so a serialized frame can never be mutated by later ingest. */
  entries(now: number): RealtimeEngagement[] {
    this.prune(now);
    return [...this.byVisitor.values()].map((entry) => ({ ...entry }));
  }

  size(): number {
    return this.byVisitor.size;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.byVisitor) {
      if (entry.lastTs < cutoff) this.byVisitor.delete(key);
    }
  }
}

function visitorKey(siteId: number, visitorId: Uint8Array): string {
  return `${siteId}:${Buffer.from(visitorId).toString('hex')}`;
}
