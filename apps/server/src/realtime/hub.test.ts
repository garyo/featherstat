import { ACTIVE_WINDOW_MS } from '@analytics/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binId, event, openTestDb, session, T0, VISITOR } from '../../test/rows.ts';
import { type Db, upsertSessions, withWriteTransaction } from '../db/index.ts';
import { createRealtimeHub, RealtimeHub, type RealtimeMessage } from './hub.ts';

const OTHER = binId(9);
const STALE = binId(7);

let db: Db;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openTestDb(2);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('RealtimeHub feed', () => {
  it('projects a stored row to the wire shape and nothing else', () => {
    const hub = new RealtimeHub();
    const row = event({
      ts: T0,
      path: '/a',
      title: 'Home',
      event_action: 'click',
      country: 'US',
      city: 'Boston',
      lat: 42.36,
      lon: -71.06,
      device_type: 'desktop',
      browser: 'Chrome',
      lang: 'en-US',
      visitor_id: VISITOR,
    });
    hub.record(row);

    const [hit] = hub.recent(50);
    expect(hit).toEqual({
      siteId: 1,
      ts: T0,
      type: 'pageview',
      path: '/a',
      eventAction: 'click',
      country: 'US',
      city: 'Boston',
      lat: 42.36,
      lon: -71.06,
      deviceType: 'desktop',
    });
    // The row's identity columns have no wire representation at all.
    expect(JSON.stringify(hit)).not.toContain(Buffer.from(VISITOR).toString('hex'));
  });

  it('keeps pings out of the feed but still counts them as active', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, type: 'ping', visitor_id: OTHER }));
    expect(hub.recent(50)).toEqual([]);
    expect(hub.activeCounts(T0)).toEqual({ 1: 1 });
  });

  it('evicts the oldest hits past capacity and never reuses an id', () => {
    const hub = new RealtimeHub({ capacity: 3 });
    for (let i = 1; i <= 5; i += 1) hub.record(event({ ts: T0 + i, path: `/${i}` }));

    expect(hub.recent(50).map((hit) => hit.path)).toEqual(['/3', '/4', '/5']);
    expect(hub.since(0).map((entry) => entry.id)).toEqual([3, 4, 5]);
  });

  it('replays only what a client missed, and everything retained when its cursor is stale', () => {
    const hub = new RealtimeHub({ capacity: 3 });
    for (let i = 1; i <= 5; i += 1) hub.record(event({ ts: T0 + i, path: `/${i}` }));

    expect(hub.since(4).map((entry) => entry.hit.path)).toEqual(['/5']);
    expect(hub.since(1).map((entry) => entry.hit.path)).toEqual(['/3', '/4', '/5']);
    expect(hub.since(5)).toEqual([]);
  });

  it('fills a filtered recent() from older ring entries — busy sites cannot starve quiet ones', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, path: '/quiet' }));
    for (let i = 0; i < 60; i += 1) {
      hub.record(event({ site_id: 2, ts: T0 + 1 + i, path: `/busy/${i}` }));
    }

    // The newest 50 hits are all site 2, but the ring still holds the site-1 hit.
    expect(hub.recent(50, (hit) => hit.siteId === 1).map((hit) => hit.path)).toEqual(['/quiet']);
    expect(hub.recent(2, (hit) => hit.siteId === 2).map((hit) => hit.path)).toEqual([
      '/busy/58',
      '/busy/59',
    ]);
  });

  it('fans out hits and version ticks until a listener unsubscribes', () => {
    const hub = new RealtimeHub();
    const seen: RealtimeMessage[] = [];
    const unsubscribe = hub.subscribe((message) => seen.push(message));

    hub.record(event({ ts: T0 }));
    hub.recordFlush({ events: 1, sessions: 1, botDrops: 0, siteIds: [1] });
    unsubscribe();
    hub.record(event({ ts: T0 + 1 }));

    expect(seen).toEqual([
      { kind: 'hit', entry: { id: 1, hit: expect.objectContaining({ siteId: 1 }) } },
      { kind: 'version', tick: { siteId: 1, version: 1 } },
    ]);
  });

  it('ticks a monotonic version per site that changed in the flush', () => {
    const hub = new RealtimeHub();
    const ticks: RealtimeMessage[] = [];
    hub.subscribe((message) => {
      if (message.kind === 'version') ticks.push(message);
    });

    hub.recordFlush({ events: 2, sessions: 2, botDrops: 0, siteIds: [1, 2] });
    hub.recordFlush({ events: 1, sessions: 1, botDrops: 0, siteIds: [2] });

    expect(ticks.map((tick) => tick.kind === 'version' && tick.tick)).toEqual([
      { siteId: 1, version: 1 },
      { siteId: 2, version: 1 },
      { siteId: 2, version: 2 },
    ]);
  });
});

describe('RealtimeHub active visitors', () => {
  it('counts distinct visitors per site and drops them as the window slides', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0, visitor_id: VISITOR, seq: 2 }));
    hub.record(event({ ts: T0 + 60_000, visitor_id: OTHER }));
    hub.record(event({ ts: T0, site_id: 2, visitor_id: VISITOR }));

    expect(hub.activeCounts(T0 + 60_000)).toEqual({ 1: 2, 2: 1 });
    // The first visitor's last hit has aged out; the second one's has not.
    expect(hub.activeCounts(T0 + ACTIVE_WINDOW_MS + 1)).toEqual({ 1: 1, 2: 0 });
    expect(hub.activeCounts(T0 + ACTIVE_WINDOW_MS + 60_001)).toEqual({ 1: 0, 2: 0 });
  });

  it('prunes stale visitors on ingest, not only when a stream counts them', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: binId(11) }));
    hub.record(event({ ts: T0, site_id: 2, visitor_id: binId(12) }));
    expect(hub.trackedVisitors()).toBe(2);

    // No activeCounts() in between: ingest alone must evict what aged out.
    hub.record(event({ ts: T0 + 2 * ACTIVE_WINDOW_MS, visitor_id: binId(13) }));
    expect(hub.trackedVisitors()).toBe(1);
  });

  it('seeds from open sessions on boot, so a restart does not zero the counter', () => {
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        session({ id: Uint8Array.of(1), visitor_id: VISITOR, last_seen_at: T0 - 60_000 }),
        session({ id: Uint8Array.of(2), visitor_id: OTHER, last_seen_at: T0 - 60_000 }),
        // Same visitor, two sessions: still one active person.
        session({ id: Uint8Array.of(3), visitor_id: VISITOR, last_seen_at: T0 - 30_000 }),
        session({ id: Uint8Array.of(4), site_id: 2, visitor_id: VISITOR, last_seen_at: T0 - 1000 }),
        // Outside the window: not active any more.
        session({
          id: Uint8Array.of(5),
          visitor_id: STALE,
          last_seen_at: T0 - ACTIVE_WINDOW_MS - 1,
        }),
      ]);
    });

    const hub = createRealtimeHub(db);
    expect(hub.activeCounts(T0)).toEqual({ 1: 2, 2: 1 });
    // A seeded visitor coming back is the same person, not a second one.
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    expect(hub.activeCounts(T0)).toEqual({ 1: 2, 2: 1 });
  });
});
