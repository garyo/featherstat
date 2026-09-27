import { ENGAGEMENT_THRESHOLD_MS, isHeartbeat } from '@featherstat/shared';
import { assertWritable, type Db, type EventRow, type SessionRow, stmt } from '../db/index.ts';
import {
  EVENT_ROLLUP_DIMS,
  NO_DIM_ID,
  PRESENCE_HORIZON_DAYS,
  SESSION_ROLLUP_DIMS,
} from './tables.ts';

/**
 * Flush-time rollup maintenance (docs/03 § Rollups). Called by the batcher
 * INSIDE its flush transaction, right after the raw inserts — so within any
 * committed snapshot the rollups can never lag the raw rows, and a failed
 * flush rolls both back together (CLAUDE.md invariant 2).
 *
 * The statement budget per flush is fixed, never per-event: counters are
 * pre-grouped in JS into one upsert per touched key, and the exact-distinct
 * bookkeeping is (rolled dims + 1) INSERT…SELECT…RETURNING statements per
 * presence table over the flush's own rowid range — the events were inserted
 * moments ago in this same transaction, so `id > sinceEventId` IS the flush.
 */

// ---------------------------------------------------------------------------
// Session snapshots — the batcher's before/after seam
// ---------------------------------------------------------------------------

/**
 * The mutable session fields rollups depend on, as last COMMITTED. `exit_path`
 * is here because it is the one ROLLED dimension the sessionizer mutates — its
 * delta is a move between keys, not an increment under one.
 */
export interface SessionSnapshot {
  pageviews: number;
  events: number;
  engaged_ms: number;
  exit_path: string | null;
}

export function snapshotSession(row: SessionRow): SessionSnapshot {
  return {
    pageviews: row.pageviews,
    events: row.events,
    engaged_ms: row.engaged_ms,
    exit_path: row.exit_path ?? null,
  };
}

/** One dirty session at flush: the live row, and its state as last committed
 * (`undefined` = the store has never seen this session — it counts as a new visit). */
export interface SessionDelta {
  row: SessionRow;
  before: SessionSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// rollup_meta — the engagement-threshold guard
// ---------------------------------------------------------------------------

const SQL_GET_META = 'SELECT value FROM rollup_meta WHERE key = ?';
const SQL_SET_META =
  'INSERT INTO rollup_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
const SQL_DELETE_META = 'DELETE FROM rollup_meta WHERE key = ?';

export const META_ENGAGEMENT_THRESHOLD = 'engagement_threshold_ms';
const META_NEEDS_REBUILD = 'needs_rebuild';
/** UTC ms below which raw events/sessions may have been pruned (jobs/retention.ts). */
export const META_RAW_HORIZON = 'raw_horizon_ts';

/** The raw floor: instants before this may lack raw rows; rollups still answer. */
export function rawHorizonTs(db: Db): number | undefined {
  const raw = getRollupMeta(db, META_RAW_HORIZON);
  if (raw === undefined) return undefined;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : undefined;
}

export function getRollupMeta(db: Db, key: string): string | undefined {
  return stmt<{ value: string }>(db, SQL_GET_META).get(key)?.value;
}

export function setRollupMeta(db: Db, key: string, value: string): void {
  assertWritable(db);
  stmt(db, SQL_SET_META).run(key, value);
}

/** True while session rollups are refusing to apply — `rebuildAllRollups` clears it. */
export function rollupNeedsRebuild(db: Db): boolean {
  return getRollupMeta(db, META_NEEDS_REBUILD) === '1';
}

/**
 * The read side's guard (invariant 5): session metrics must not be answered
 * from `rollup_sessions_day` while its `bounced` column is stale — a rebuild
 * is pending, OR the stored threshold differs from the code's. The flush path
 * only notices a changed threshold on its first apply after boot, so without
 * the second test a deploy that changes it would serve the old bounce
 * definition from rollups until a hit arrived.
 */
export function sessionRollupsStale(db: Db): boolean {
  if (rollupNeedsRebuild(db)) return true;
  const stored = getRollupMeta(db, META_ENGAGEMENT_THRESHOLD);
  return stored !== undefined && Number(stored) !== ENGAGEMENT_THRESHOLD_MS;
}

/** Whether this connection may apply session rollups — resolved once, then cached. */
const sessionRollupsBlocked = new WeakMap<Db, boolean>();

/**
 * The bounce definition is baked into `rollup_sessions_day.bounced`, so a
 * changed `ENGAGEMENT_THRESHOLD_MS` makes every stored `bounced` a lie. On the
 * first apply we record the constant; on a mismatch we refuse the session side
 * (event rollups are threshold-free and continue) until a full rebuild
 * re-derives history under the new definition.
 */
function sessionSideBlocked(db: Db): boolean {
  const cached = sessionRollupsBlocked.get(db);
  if (cached !== undefined) return cached;

  let blocked: boolean;
  const stored = getRollupMeta(db, META_ENGAGEMENT_THRESHOLD);
  if (stored === undefined) {
    setRollupMeta(db, META_ENGAGEMENT_THRESHOLD, String(ENGAGEMENT_THRESHOLD_MS));
    blocked = rollupNeedsRebuild(db);
  } else if (Number(stored) !== ENGAGEMENT_THRESHOLD_MS) {
    console.error(
      `ENGAGEMENT_THRESHOLD_MS changed (rollups built at ${stored}, code says ` +
        `${ENGAGEMENT_THRESHOLD_MS}): 'bounced' in rollup_sessions_day is stale. ` +
        'Session rollups are SUSPENDED until rebuildAllRollups() runs.',
    );
    setRollupMeta(db, META_NEEDS_REBUILD, '1');
    blocked = true;
  } else {
    blocked = rollupNeedsRebuild(db);
  }
  sessionRollupsBlocked.set(db, blocked);
  return blocked;
}

/** A completed full rebuild: stamp the current threshold and lift the suspension. */
export function noteRollupsRebuilt(db: Db): void {
  assertWritable(db);
  setRollupMeta(db, META_ENGAGEMENT_THRESHOLD, String(ENGAGEMENT_THRESHOLD_MS));
  stmt(db, SQL_DELETE_META).run(META_NEEDS_REBUILD);
  sessionRollupsBlocked.set(db, false);
}

// ---------------------------------------------------------------------------
// Statements — additive upserts; session counters may go DOWN (un-bounce)
// ---------------------------------------------------------------------------

const SQL_UPSERT_TRAFFIC_HOUR = `INSERT INTO rollup_traffic_hour (
  site_id, local_date, local_hour,
  hits, actions, pageviews, events, outlinks, downloads, event_value_sum
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, local_date, local_hour) DO UPDATE SET
  hits            = hits            + excluded.hits,
  actions         = actions         + excluded.actions,
  pageviews       = pageviews       + excluded.pageviews,
  events          = events          + excluded.events,
  outlinks        = outlinks        + excluded.outlinks,
  downloads       = downloads       + excluded.downloads,
  event_value_sum = event_value_sum + excluded.event_value_sum`;

const SQL_UPSERT_DIM_DAY = `INSERT INTO rollup_dim_day (
  site_id, local_date, dim_id, dim_value, dim_null,
  hits, actions, pageviews, events, outlinks, downloads, event_value_sum,
  visitors, sessions_touched
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, local_date, dim_id, dim_value, dim_null) DO UPDATE SET
  hits             = hits             + excluded.hits,
  actions          = actions          + excluded.actions,
  pageviews        = pageviews        + excluded.pageviews,
  events           = events           + excluded.events,
  outlinks         = outlinks         + excluded.outlinks,
  downloads        = downloads        + excluded.downloads,
  event_value_sum  = event_value_sum  + excluded.event_value_sum,
  visitors         = visitors         + excluded.visitors,
  sessions_touched = sessions_touched + excluded.sessions_touched`;

/**
 * Presence maintenance for one rolled group, over the rows this transaction
 * just inserted. `RETURNING` emits only the rows actually INSERTED — an ignored
 * conflict returns nothing — so the returned groups are exactly the first
 * sightings whose distinct counters must move. Column expressions come from the
 * closed dim tables; every value is bound (invariant 9).
 */
function seenSql(table: string, idColumn: string, dimId: number, column: string | null): string {
  const value = column === null ? "''" : `COALESCE(${column}, '')`;
  const isNull = column === null ? '0' : `${column} IS NULL`;
  return `INSERT OR IGNORE INTO ${table}
SELECT DISTINCT site_id, local_date, ${dimId}, ${value}, ${isNull}, ${idColumn}
FROM events WHERE id > ? AND type != 'ping'
RETURNING site_id, local_date, dim_value, dim_null`;
}

interface PresenceDim {
  dimId: number;
  visitorSql: string;
  sessionSql: string;
}

const PRESENCE_DIMS: readonly PresenceDim[] = [
  { dimId: NO_DIM_ID, column: null as string | null },
  ...EVENT_ROLLUP_DIMS.map(({ dimId, column }) => ({ dimId, column: column as string | null })),
].map(({ dimId, column }) => ({
  dimId,
  visitorSql: seenSql('rollup_visitor_seen', 'visitor_id', dimId, column),
  sessionSql: seenSql('rollup_session_seen', 'session_id', dimId, column),
}));

/**
 * Presence rows are per-day scaffolding: the daily salt closes a day, so once
 * ingest moves past it they serve nothing. The write path prunes them itself at
 * day rollover — the first flush carrying a site's new local_date drops that
 * site's rows older than the horizon — which is what keeps the file's
 * bytes-per-event budget honest without waiting for a retention job.
 */
const SQL_PRUNE_VISITOR_SEEN = `DELETE FROM rollup_visitor_seen
WHERE site_id = ? AND local_date < date(?, '-${PRESENCE_HORIZON_DAYS} days')`;
const SQL_PRUNE_SESSION_SEEN = `DELETE FROM rollup_session_seen
WHERE site_id = ? AND local_date < date(?, '-${PRESENCE_HORIZON_DAYS} days')`;

/** Per-site newest local_date already seen — day rollover detection. */
const presenceFrontier = new WeakMap<Db, Map<number, string>>();

const SQL_UPSERT_SESSIONS_DAY = `INSERT INTO rollup_sessions_day (
  site_id, local_date, dim_id, dim_value, dim_null,
  visits, measured_sessions, engaged_ms, bounced, session_pageviews
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, local_date, dim_id, dim_value, dim_null) DO UPDATE SET
  visits            = visits            + excluded.visits,
  measured_sessions = measured_sessions + excluded.measured_sessions,
  engaged_ms        = engaged_ms        + excluded.engaged_ms,
  bounced           = bounced           + excluded.bounced,
  session_pageviews = session_pageviews + excluded.session_pageviews`;

// ---------------------------------------------------------------------------
// Event side — insert-only, order-free
// ---------------------------------------------------------------------------

interface TrafficAcc {
  site: number;
  date: string;
  hour: number;
  hits: number;
  actions: number;
  pageviews: number;
  events: number;
  outlinks: number;
  downloads: number;
  value: number;
}

interface DimAcc {
  site: number;
  date: string;
  dimId: number;
  value: string;
  isNull: 0 | 1;
  /** Every stored row incl. pings — group existence, matching a raw GROUP BY. */
  hits: number;
  actions: number;
  pageviews: number;
  events: number;
  outlinks: number;
  downloads: number;
  value_sum: number;
  /** First sightings this flush, from the presence tables' RETURNING rows. */
  visitors: number;
  sessions: number;
}

function trafficAcc(map: Map<string, TrafficAcc>, event: EventRow): TrafficAcc {
  const key = `${event.site_id}|${event.local_date}|${event.local_hour}`;
  let acc = map.get(key);
  if (acc === undefined) {
    acc = {
      site: event.site_id,
      date: event.local_date,
      hour: event.local_hour,
      hits: 0,
      actions: 0,
      pageviews: 0,
      events: 0,
      outlinks: 0,
      downloads: 0,
      value: 0,
    };
    map.set(key, acc);
  }
  return acc;
}

function dimAcc(
  map: Map<string, DimAcc>,
  event: EventRow,
  dimId: number,
  raw: string | null | undefined,
): DimAcc {
  const isNull = raw === null || raw === undefined ? 1 : 0;
  const value = raw ?? '';
  const key = `${event.site_id}|${event.local_date}|${dimId}|${isNull}|${value}`;
  let acc = map.get(key);
  if (acc === undefined) {
    acc = {
      site: event.site_id,
      date: event.local_date,
      dimId,
      value,
      isNull: isNull as 0 | 1,
      hits: 0,
      actions: 0,
      pageviews: 0,
      events: 0,
      outlinks: 0,
      downloads: 0,
      value_sum: 0,
      visitors: 0,
      sessions: 0,
    };
    map.set(key, acc);
  }
  return acc;
}

/** Counts one action into a dim accumulator — the population rules of query/population.ts. */
function countAction(acc: DimAcc, event: EventRow): void {
  acc.actions += 1;
  if (event.type === 'pageview') acc.pageviews += 1;
  else if (event.type === 'event') {
    acc.events += 1;
    acc.value_sum += event.event_value ?? 0;
  } else if (event.type === 'outlink') acc.outlinks += 1;
  else if (event.type === 'download') acc.downloads += 1;
}

// ---------------------------------------------------------------------------
// Session side — mutation deltas
// ---------------------------------------------------------------------------

/** A session's whole additive contribution to one rollup_sessions_day row. */
interface SessionVector {
  visits: number;
  measured: number;
  engaged: number;
  bounced: number;
  pageviews: number;
}

function sessionVector(pageviews: number, events: number, engagedMs: number): SessionVector {
  return {
    visits: 1,
    measured: engagedMs > 0 ? 1 : 0,
    engaged: engagedMs,
    // Invariant 5: engagement-aware bounce — baked in, which is what the
    // rollup_meta threshold guard above exists to police.
    bounced: pageviews === 1 && events === 0 && engagedMs < ENGAGEMENT_THRESHOLD_MS ? 1 : 0,
    pageviews,
  };
}

interface SessionDayAcc {
  site: number;
  date: string;
  dimId: number;
  value: string;
  isNull: 0 | 1;
  net: SessionVector;
}

function addVector(
  map: Map<string, SessionDayAcc>,
  row: SessionRow,
  dimId: number,
  raw: string | null | undefined,
  vector: SessionVector,
  sign: 1 | -1,
): void {
  const isNull = raw === null || raw === undefined ? 1 : 0;
  const value = raw ?? '';
  const key = `${row.site_id}|${row.local_date}|${dimId}|${isNull}|${value}`;
  let acc = map.get(key);
  if (acc === undefined) {
    acc = {
      site: row.site_id,
      date: row.local_date,
      dimId,
      value,
      isNull: isNull as 0 | 1,
      net: { visits: 0, measured: 0, engaged: 0, bounced: 0, pageviews: 0 },
    };
    map.set(key, acc);
  }
  acc.net.visits += sign * vector.visits;
  acc.net.measured += sign * vector.measured;
  acc.net.engaged += sign * vector.engaged;
  acc.net.bounced += sign * vector.bounced;
  acc.net.pageviews += sign * vector.pageviews;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export function applyRollups(
  db: Db,
  /** `MAX(events.id)` as read inside this transaction BEFORE the flush's inserts. */
  sinceEventId: number,
  events: readonly EventRow[],
  sessionDeltas: readonly SessionDelta[],
): void {
  assertWritable(db);
  applyEventRollups(db, sinceEventId, events);
  if (!sessionSideBlocked(db)) applySessionRollups(db, sessionDeltas);
}

function applyEventRollups(db: Db, sinceEventId: number, events: readonly EventRow[]): void {
  if (events.length === 0) return;
  const traffic = new Map<string, TrafficAcc>();
  const dims = new Map<string, DimAcc>();

  for (const event of events) {
    const hour = trafficAcc(traffic, event);
    hour.hits += 1;

    // Heartbeats keep a dim row ALIVE (hits) without counting as actions: a raw
    // GROUP BY ranges over every stored row, so the read path must know a key
    // only pings touched — its metrics are all zero, but the group exists.
    const heartbeat = isHeartbeat(event.type);
    const noDim = dimAcc(dims, event, NO_DIM_ID, '');
    noDim.hits += 1;
    if (!heartbeat) countAction(noDim, event);
    for (const { dimId, column } of EVENT_ROLLUP_DIMS) {
      const acc = dimAcc(dims, event, dimId, event[column]);
      acc.hits += 1;
      if (!heartbeat) countAction(acc, event);
    }
    if (heartbeat) continue; // presence, not an action

    hour.actions += 1;
    if (event.type === 'pageview') hour.pageviews += 1;
    else if (event.type === 'event') {
      hour.events += 1;
      hour.value += event.event_value ?? 0;
    } else if (event.type === 'outlink') hour.outlinks += 1;
    else if (event.type === 'download') hour.downloads += 1;
  }

  const upsertHour = stmt(db, SQL_UPSERT_TRAFFIC_HOUR);
  for (const acc of traffic.values()) {
    upsertHour.run(
      acc.site,
      acc.date,
      acc.hour,
      acc.hits,
      acc.actions,
      acc.pageviews,
      acc.events,
      acc.outlinks,
      acc.downloads,
      acc.value,
    );
  }

  prunePresence(db, traffic.values());

  // Exact distincts: each presence statement inserts the flush's first
  // sightings for one rolled group and RETURNs exactly those, so the counts
  // fold straight into the accumulators the upsert below writes.
  interface SeenRow {
    site_id: number;
    local_date: string;
    dim_value: string;
    dim_null: number;
  }
  for (const { dimId, visitorSql, sessionSql } of PRESENCE_DIMS) {
    for (const [sql, field] of [
      [visitorSql, 'visitors'],
      [sessionSql, 'sessions'],
    ] as const) {
      for (const row of stmt<SeenRow>(db, sql).all(sinceEventId) as SeenRow[]) {
        // Presence rows come from the very rows the accumulators grouped, so
        // the key always exists; `?.` would silently swallow a drift bug.
        const key = `${row.site_id}|${row.local_date}|${dimId}|${row.dim_null}|${row.dim_value}`;
        const acc = dims.get(key);
        if (acc === undefined) throw new Error(`presence row for unknown rollup key ${key}`);
        acc[field] += 1;
      }
    }
  }

  const upsertDim = stmt(db, SQL_UPSERT_DIM_DAY);
  for (const acc of dims.values()) {
    upsertDim.run(
      acc.site,
      acc.date,
      acc.dimId,
      acc.value,
      acc.isNull,
      acc.hits,
      acc.actions,
      acc.pageviews,
      acc.events,
      acc.outlinks,
      acc.downloads,
      acc.value_sum,
      acc.visitors,
      acc.sessions,
    );
  }
}

/** Day rollover per site: the first flush on a new local_date prunes old presence rows. */
function prunePresence(db: Db, touched: Iterable<TrafficAcc>): void {
  let frontier = presenceFrontier.get(db);
  if (frontier === undefined) {
    frontier = new Map();
    presenceFrontier.set(db, frontier);
  }
  for (const { site, date } of touched) {
    const known = frontier.get(site);
    if (known !== undefined && date <= known) continue;
    frontier.set(site, date);
    stmt(db, SQL_PRUNE_VISITOR_SEEN).run(site, date);
    stmt(db, SQL_PRUNE_SESSION_SEEN).run(site, date);
  }
}

/**
 * The sessionizer mutates ONE live row per open session, so each delta is
 * "subtract what the store believed, add what the row says now". For the
 * immutable first-touch dimensions the two keys coincide and the subtraction
 * nets to a plain delta; for `exit_path` — the one rolled dimension that moves —
 * it becomes a move between keys. `bounced` can genuinely go down: a session
 * that gains a second pageview or enough engaged time un-bounces, and the
 * before-vector carries that −1.
 */
function applySessionRollups(db: Db, deltas: readonly SessionDelta[]): void {
  if (deltas.length === 0) return;
  const accs = new Map<string, SessionDayAcc>();

  for (const { row, before } of deltas) {
    const after = sessionVector(row.pageviews, row.events, row.engaged_ms);
    const prior =
      before === undefined
        ? undefined
        : sessionVector(before.pageviews, before.events, before.engaged_ms);

    addVector(accs, row, NO_DIM_ID, '', after, 1);
    if (prior !== undefined) addVector(accs, row, NO_DIM_ID, '', prior, -1);
    for (const { dim, dimId, column } of SESSION_ROLLUP_DIMS) {
      addVector(accs, row, dimId, row[column], after, 1);
      if (prior !== undefined) {
        const beforeValue = dim === 'exit_path' ? before?.exit_path : row[column];
        addVector(accs, row, dimId, beforeValue, prior, -1);
      }
    }
  }

  const upsert = stmt(db, SQL_UPSERT_SESSIONS_DAY);
  for (const acc of accs.values()) {
    const { visits, measured, engaged, bounced, pageviews } = acc.net;
    if (visits === 0 && measured === 0 && engaged === 0 && bounced === 0 && pageviews === 0) {
      continue; // an unchanged key — nothing to write
    }
    upsert.run(
      acc.site,
      acc.date,
      acc.dimId,
      acc.value,
      acc.isNull,
      visits,
      measured,
      engaged,
      bounced,
      pageviews,
    );
  }
}
