import {
  type HitType,
  PROP_BAG_MAX_BYTES,
  PROP_KEY_PATTERN,
  PROP_KEYS_PER_SITE,
  PROP_VALUE_OTHER,
  PROP_VALUES_PER_KEY,
  PROPS_PER_EVENT,
  type Props,
} from '@featherstat/shared';
import { assertWritable, type Db, deletePropKey, stmt } from '../db/index.ts';

/**
 * Custom-prop governance at ingest (docs/03 § Props). `admit` clamps one hit's
 * bag against the caps and returns the canonical JSON to store — every breach
 * clamps silently and counts in `prop_drops`, because a beacon never bounces
 * (CLAUDE.md invariant 4).
 *
 * State discipline mirrors `identity.ts`: per-site state loads lazily from the
 * governance tables and is then authoritative in memory, running AHEAD of the
 * store between flushes. Its durable writes queue here and land in the SAME
 * flush transaction as the events they describe (the batcher drains the queue
 * inside `withWriteTransaction`, invariant 2) — a failed flush keeps the queue
 * and retries; a crash loses at most the between-flush deltas, and a restart
 * reloads from the tables, which are the truth.
 */

export type DropReason =
  | 'too_many_keys'
  | 'oversize'
  | 'bad_key'
  | 'ip_shaped'
  | 'value_clamped'
  | 'on_ping';

/** In-memory per-key state — the durable `prop_keys` row, run ahead. */
interface KeyState {
  firstSeen: number;
  /** JSON-encoded values, so `true` and `"true"` stay distinct. */
  values: Set<string>;
  overCapSince: number | null;
}

interface SiteState {
  keys: Map<string, KeyState>;
}

/** Pending durable delta for one (site, key), aggregated across a flush interval. */
interface KeyDelta {
  siteId: number;
  key: string;
  firstSeen: number;
  lastSeen: number;
  events: number;
  /** Values first seen since the last flush — become `prop_values` inserts. */
  newValues: string[];
  overCapSince: number | null;
}

interface DropDelta {
  siteId: number;
  localDate: string;
  reason: DropReason;
  count: number;
}

/** IPv4 or IPv6 literal shape — dropped on sight (CLAUDE.md invariant 3 posture). */
const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_SHAPE = /^[0-9a-f:.]+$/i;

function isIpShaped(value: string): boolean {
  if (IPV4_SHAPE.test(value)) return true;
  // Two-plus colons over hex/dot/colon covers every v6 literal, mapped v4 included.
  return value.includes(':') && value.indexOf(':') !== value.lastIndexOf(':')
    ? IPV6_SHAPE.test(value)
    : false;
}

const SQL_LOAD_KEYS =
  'SELECT key, first_seen, last_seen, over_cap_since FROM prop_keys WHERE site_id = ?';
const SQL_LOAD_VALUES = 'SELECT key, value FROM prop_values WHERE site_id = ?';

const SQL_UPSERT_KEY = `INSERT INTO prop_keys
  (site_id, key, first_seen, last_seen, events, distinct_values, over_cap_since)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, key) DO UPDATE SET
  last_seen       = excluded.last_seen,
  events          = events + excluded.events,
  distinct_values = distinct_values + excluded.distinct_values,
  over_cap_since  = COALESCE(over_cap_since, excluded.over_cap_since)`;

const SQL_INSERT_VALUE = 'INSERT OR IGNORE INTO prop_values (site_id, key, value) VALUES (?, ?, ?)';

const SQL_INCREMENT_DROPS = `INSERT INTO prop_drops (site_id, local_date, reason, count)
VALUES (?, ?, ?, ?)
ON CONFLICT (site_id, local_date, reason) DO UPDATE SET count = count + excluded.count`;

export class PropRegistry {
  private readonly sites = new Map<number, SiteState>();
  private readonly keyDeltas = new Map<string, KeyDelta>();
  private readonly dropDeltas = new Map<string, DropDelta>();

  constructor(private readonly db: Db) {}

  /** Queued durable writes — counts toward the batcher's `pending`, so a drop
   * with no event beside it (an orphan heartbeat's bag) still lands. */
  get pendingCount(): number {
    return this.keyDeltas.size + this.dropDeltas.size;
  }

  /**
   * Clamp one hit's bag and return the canonical JSON to store, or `undefined`
   * for no bag at all (an empty `{}` is never stored). Enforcement order:
   * ping strip → key charset → value shape (length, IP) → per-event count →
   * bag bytes → per-site key cap → per-key value cap.
   */
  admit(
    siteId: number,
    props: Props,
    localDate: string,
    hitType: HitType,
    now: number,
  ): string | undefined {
    // Props never ride pings: a heartbeat re-measures a page, it says nothing
    // new — a bag here is a tracker bug, counted so the operator can see it.
    if (hitType === 'ping') {
      this.drop(siteId, localDate, 'on_ping');
      return undefined;
    }

    // Sorted once: the truncation order and the canonical JSON both need it.
    const entries = Object.entries(props).sort(([a], [b]) => (a < b ? -1 : 1));
    const kept: [string, string | number | boolean][] = [];
    for (const [key, value] of entries) {
      // The schema enforces this on the collect path; a Hit-level caller could not.
      if (!PROP_KEY_PATTERN.test(key)) {
        this.drop(siteId, localDate, 'bad_key');
        continue;
      }
      if (typeof value === 'string') {
        if (value.length > 200) {
          this.drop(siteId, localDate, 'oversize');
          continue;
        }
        if (isIpShaped(value)) {
          this.drop(siteId, localDate, 'ip_shaped');
          continue;
        }
      }
      kept.push([key, value]);
    }

    if (kept.length > PROPS_PER_EVENT) {
      kept.length = PROPS_PER_EVENT; // first N in sorted key order
      this.drop(siteId, localDate, 'oversize');
    }
    if (kept.length === 0) return undefined;

    const keptJson = canonicalJson(kept);
    if (Buffer.byteLength(keptJson) > PROP_BAG_MAX_BYTES) {
      this.drop(siteId, localDate, 'oversize');
      return undefined;
    }

    const site = this.siteState(siteId);
    const admitted: [string, string | number | boolean][] = [];
    let reshaped = false; // a dropped key or clamped value forces a re-serialize
    for (const [key, value] of kept) {
      let state = site.keys.get(key);
      if (state === undefined) {
        if (site.keys.size >= PROP_KEYS_PER_SITE) {
          this.drop(siteId, localDate, 'too_many_keys');
          reshaped = true;
          continue;
        }
        state = { firstSeen: now, values: new Set(), overCapSince: null };
        site.keys.set(key, state);
      }
      const delta = this.keyDelta(siteId, key, state.firstSeen, now);

      let stored = value;
      const encoded = JSON.stringify(value);
      if (!state.values.has(encoded)) {
        if (state.values.size >= PROP_VALUES_PER_KEY) {
          stored = PROP_VALUE_OTHER;
          reshaped = true;
          this.drop(siteId, localDate, 'value_clamped');
          if (state.overCapSince === null) {
            state.overCapSince = now;
            delta.overCapSince = now;
          }
        } else {
          state.values.add(encoded);
          delta.newValues.push(encoded);
        }
      }
      delta.events += 1;
      delta.lastSeen = now;
      admitted.push([key, stored]);
    }

    if (admitted.length === 0) return undefined;
    return reshaped ? canonicalJson(admitted) : keptJson;
  }

  /**
   * Forget one key: in-memory state and queued deltas immediately, the durable
   * rows in the caller's write transaction. The stored bags are the scrub job's
   * to clean (jobs/prop-scrub.ts) — a re-appearing key afterwards is admitted
   * as brand new. True if the key existed anywhere.
   */
  deleteKey(siteId: number, key: string): boolean {
    const inMemory = this.sites.get(siteId)?.keys.delete(key) ?? false;
    this.keyDeltas.delete(deltaKey(siteId, key));
    const inStore = deletePropKey(this.db, siteId, key);
    return inMemory || inStore;
  }

  /**
   * Drain every queued delta into the store — called by the batcher INSIDE its
   * flush transaction, right beside the events these deltas describe. The queue
   * is NOT cleared here: `committed()` does that after the transaction lands,
   * so a failed flush retries the same writes.
   */
  apply(db: Db): void {
    if (this.pendingCount === 0) return;
    assertWritable(db);
    for (const delta of this.keyDeltas.values()) {
      stmt(db, SQL_UPSERT_KEY).run(
        delta.siteId,
        delta.key,
        delta.firstSeen,
        delta.lastSeen,
        delta.events,
        delta.newValues.length,
        delta.overCapSince,
      );
      for (const value of delta.newValues) {
        stmt(db, SQL_INSERT_VALUE).run(delta.siteId, delta.key, value);
      }
    }
    for (const drop of this.dropDeltas.values()) {
      stmt(db, SQL_INCREMENT_DROPS).run(drop.siteId, drop.localDate, drop.reason, drop.count);
    }
  }

  /** The flush committed; what `apply` wrote is durable and the queue resets. */
  committed(): void {
    this.keyDeltas.clear();
    this.dropDeltas.clear();
  }

  private siteState(siteId: number): SiteState {
    let site = this.sites.get(siteId);
    if (site !== undefined) return site;
    site = { keys: new Map() };
    const values = new Map<string, Set<string>>();
    for (const row of stmt<{ key: string; value: string }>(this.db, SQL_LOAD_VALUES).all(siteId)) {
      let set = values.get(row.key);
      if (set === undefined) {
        set = new Set();
        values.set(row.key, set);
      }
      set.add(row.value);
    }
    interface KeyRow {
      key: string;
      first_seen: number;
      over_cap_since: number | null;
    }
    for (const row of stmt<KeyRow>(this.db, SQL_LOAD_KEYS).all(siteId)) {
      site.keys.set(row.key, {
        firstSeen: row.first_seen,
        values: values.get(row.key) ?? new Set(),
        overCapSince: row.over_cap_since,
      });
    }
    this.sites.set(siteId, site);
    return site;
  }

  private keyDelta(siteId: number, key: string, firstSeen: number, now: number): KeyDelta {
    const id = deltaKey(siteId, key);
    let delta = this.keyDeltas.get(id);
    if (delta === undefined) {
      delta = {
        siteId,
        key,
        firstSeen,
        lastSeen: now,
        events: 0,
        newValues: [],
        overCapSince: null,
      };
      this.keyDeltas.set(id, delta);
    }
    return delta;
  }

  private drop(siteId: number, localDate: string, reason: DropReason): void {
    const id = `${siteId}|${localDate}|${reason}`;
    const entry = this.dropDeltas.get(id);
    if (entry !== undefined) entry.count += 1;
    else this.dropDeltas.set(id, { siteId, localDate, reason, count: 1 });
  }
}

function deltaKey(siteId: number, key: string): string {
  return `${siteId}|${key}`;
}

/** Canonical JSON: sorted keys (the caller sorted), no whitespace — what SQLite's
 * `json_*` functions preserve, so a scrubbed bag stays canonical too. */
function canonicalJson(entries: readonly [string, string | number | boolean][]): string {
  return JSON.stringify(Object.fromEntries(entries));
}
