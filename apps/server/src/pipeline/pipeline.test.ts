import {
  BATCH_INTERVAL_MS,
  DAY_MS,
  type Hit,
  type HitContext,
  PING_CLAMP_MS,
  SESSION_REVIVAL_MS,
} from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, GOOGLEBOT_UA, resultOf, T0 } from '../../test/rows.ts';
import { createSite, type Db, getBotDrops, openDb, withWriteTransaction } from '../db/index.ts';
import { executeQueryRequest } from '../query/executor.ts';
import type { GeoProvider } from './geo.ts';
import type { Pipeline } from './index.ts';
import { createPipeline } from './index.ts';

const BOSTON: GeoProvider = {
  lookup: () => ({
    country: 'US',
    region: 'Massachusetts',
    city: 'Boston',
    lat: 42.36,
    lon: -71.06,
  }),
};

function hit(overrides: Partial<Hit> = {}): Hit {
  return { siteId: 1, type: 'pageview', url: 'https://example.com/a', ...overrides };
}

function ctx(overrides: Partial<HitContext> = {}): HitContext {
  return {
    ip: '203.0.113.5',
    userAgent: DESKTOP_UA,
    acceptLanguage: 'en-US,en;q=0.9',
    receivedAt: T0,
    ...overrides,
  };
}

let db: Db;
let pipeline: Pipeline;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'Example', domains: ['example.com'] });
  });
  pipeline = createPipeline(db, { geo: BOSTON });
});

afterEach(() => {
  pipeline.shutdown();
  db.close();
  vi.useRealTimers();
});

describe('createPipeline', () => {
  it('enriches a pageview end-to-end and lands it on the batch interval', () => {
    pipeline.sink([hit()], ctx());
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);

    const event = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(event.type).toBe('pageview');
    expect(event.hostname).toBe('example.com');
    expect(event.path).toBe('/a');
    expect(event.browser).toBe('Chrome');
    expect(event.os).toBe('Windows');
    expect(event.device_type).toBe('desktop');
    expect(event.lang).toBe('en-US');
    expect(event.country).toBe('US');
    expect(event.city).toBe('Boston');
    expect(event.local_date).toBe('2026-07-27');
    expect(event.local_hour).toBe(10);
    expect(event.visitor_id).toHaveLength(8);

    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(session.pageviews).toBe(1);
    expect(session.ref_type).toBe('direct');
    expect(session.country).toBe('US');
  });

  it('drops bot traffic before storage and counts it per site and local day', () => {
    pipeline.sink([hit()], ctx({ userAgent: GOOGLEBOT_UA }));
    pipeline.sink([hit()], ctx({ userAgent: GOOGLEBOT_UA }));
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    expect(getBotDrops(db, 1, '2026-07-27')).toBe(2);
  });

  it('drops hits for unknown sites', () => {
    pipeline.sink([hit({ siteId: 99 })], ctx());
    pipeline.flush();
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
  });

  it('stores pings as rows that update engagement but not pageviews', () => {
    pipeline.sink([hit()], ctx());
    pipeline.sink([hit({ type: 'ping' })], ctx({ receivedAt: T0 + 10_000 }));
    pipeline.flush();
    const types = db.prepare('SELECT type FROM events ORDER BY seq').pluck().all();
    expect(types).toEqual(['pageview', 'ping']);
    const session = db.prepare('SELECT pageviews, engaged_ms FROM sessions').get();
    expect(session).toEqual({ pageviews: 1, engaged_ms: 10_000 });
  });

  it('notifies onFlush hooks with the sites that changed', () => {
    const hook = vi.fn();
    pipeline.onFlush(hook);
    pipeline.sink([hit()], ctx());
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0].siteIds).toEqual([1]);
  });

  it('recovers open sessions across a restart and keeps seq counting', () => {
    pipeline.sink([hit()], ctx());
    pipeline.shutdown();

    vi.setSystemTime(T0 + 60_000);
    pipeline = createPipeline(db, { geo: BOSTON });
    pipeline.sink([hit({ url: 'https://example.com/b' })], ctx({ receivedAt: T0 + 60_000 }));
    pipeline.flush();

    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    const rows = db.prepare('SELECT seq, session_id FROM events ORDER BY seq').all() as Array<{
      seq: number;
      session_id: Buffer;
    }>;
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]?.session_id).toEqual(rows[1]?.session_id);
    const session = db.prepare('SELECT pageviews, engaged_ms, exit_path FROM sessions').get();
    expect(session).toEqual({ pageviews: 2, engaged_ms: 20_000, exit_path: '/b' });
  });
});

/**
 * The production shape this rule exists for (docs/03 § Sessionization): heartbeats
 * are focus-gated, so a reader who switches away stops pinging entirely. Coming
 * back to the same open tab half an hour later used to book a second, pageview-less
 * visit and credit the second span of attention to no page at all.
 */
describe('a reader who comes back to an open tab', () => {
  const HEARTBEAT_MS = 15_000;
  const READING_MS = 3 * 60_000;
  const AWAY_MS = 35 * 60_000;

  /** `enableHeartBeatTimer(15)` for `forMs`, starting one beat after `from`. */
  function read(from: number, forMs: number): number {
    let at = from;
    for (let beat = HEARTBEAT_MS; beat <= forMs; beat += HEARTBEAT_MS) {
      at = from + beat;
      pipeline.sink([hit({ type: 'ping' })], ctx({ receivedAt: at }));
    }
    return at;
  }

  function rows<T>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...params) as T[];
  }

  /**
   * 3 min of beats, one clamped beat bridging the silence, then the remaining
   * 2:45 of beats: ~6 min of attention, not the 41 min of wall clock between the
   * first hit and the last, and not two visits.
   */
  const ENGAGED_MS = READING_MS + PING_CLAMP_MS + (READING_MS - HEARTBEAT_MS);

  it('counts one visit, ~6 minutes of engagement, and attributes it to the page', () => {
    pipeline.sink([hit()], ctx());
    const left = read(T0, READING_MS);
    pipeline.flush(); // the visit is durable before the silence, as in production
    read(left + AWAY_MS, READING_MS);
    pipeline.flush();

    const sessions = rows<{ pageviews: number; engaged_ms: number; entry_path: string }>(
      'SELECT pageviews, engaged_ms, entry_path FROM sessions',
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({ pageviews: 1, engaged_ms: ENGAGED_MS, entry_path: '/a' });
    const minutes = (sessions[0]?.engaged_ms ?? 0) / 60_000;
    expect(minutes).toBeGreaterThan(5.9); // the ruling's "6 minutes", not 41
    expect(minutes).toBeLessThan(6.2);

    // One session, one contiguous seq run, and its first row is the pageview.
    const stored = rows<{ seq: number; type: string; session_id: Buffer }>(
      'SELECT seq, type, session_id FROM events ORDER BY seq',
    );
    expect(stored.map((row) => row.seq)).toEqual(stored.map((_, i) => i + 1));
    expect(new Set(stored.map((row) => row.session_id.toString('hex'))).size).toBe(1);
    expect(stored[0]?.type).toBe('pageview');

    // No pageview-less session anywhere — the defect's own signature.
    expect(db.prepare('SELECT COUNT(*) FROM sessions WHERE pageviews = 0').pluck().get()).toBe(0);

    // And the second span of attention lands on the page, not on nothing: the
    // same total, attributed per page instead of per session.
    const dwell = resultOf(
      executeQueryRequest(db, {
        site: 1,
        range: { from: '2026-07-27', to: '2026-07-27' },
        queries: [{ id: 'q', kind: 'dwell', limit: 10 }],
      }),
      'q',
    ).rows;
    expect(dwell).toEqual([
      { path: '/a', views_measured: 1, avg_page_ms: ENGAGED_MS, max_page_ms: ENGAGED_MS },
    ]);
  });

  it('drops heartbeats that come back past the returning-reader window', () => {
    pipeline.sink([hit()], ctx());
    const left = read(T0, READING_MS);
    pipeline.flush();
    read(left + SESSION_REVIVAL_MS + 60_000, READING_MS);
    pipeline.flush();

    // Nothing to continue, so they are dropped rather than booked as a visit:
    // still exactly the first visit, and only its own heartbeats stored.
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM events WHERE type = 'ping'").pluck().get()).toBe(
      READING_MS / HEARTBEAT_MS,
    );
  });

  /** 19:50 EDT, ten minutes before the UTC day turns over — mid-evening locally. */
  const BEFORE_UTC_MIDNIGHT = Math.floor(T0 / DAY_MS) * DAY_MS + DAY_MS - 10 * 60_000;
  /** 23:50 EDT: the site's own midnight is at 04:00 UTC, four hours past the UTC one. */
  const BEFORE_LOCAL_MIDNIGHT = Date.UTC(2026, 6, 28, 4) - 10 * 60_000;

  it('reaches across 00:00 UTC, which is mid-evening for this site (docs/03)', () => {
    // The reader steps away at 19:50 local and comes back at 20:20. Nothing about
    // that is a new day, and since the salt turns over at site-local midnight the
    // same person is still the same visitor: one visit, revived.
    pipeline.sink([hit()], ctx({ receivedAt: BEFORE_UTC_MIDNIGHT }));
    const left = read(BEFORE_UTC_MIDNIGHT, 60_000);
    pipeline.flush();

    read(left + 30 * 60_000, 60_000);
    pipeline.flush();
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(9); // 1 + 4 + 4 beats
  });

  it('cannot reach across the site-local visitor-id rotation (docs/03)', () => {
    pipeline.sink([hit()], ctx({ receivedAt: BEFORE_LOCAL_MIDNIGHT }));
    const left = read(BEFORE_LOCAL_MIDNIGHT, 60_000);
    pipeline.flush();

    // 40 min later is well inside the revival window, but on the other side of the
    // rotation: the same person is a different visitor, so there is nothing of
    // theirs to find. The heartbeats are dropped, not turned into a second visit.
    read(left + 40 * 60_000, 60_000);
    pipeline.flush();
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM sessions WHERE pageviews = 0').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(5); // 1 + 4 beats
  });
});
