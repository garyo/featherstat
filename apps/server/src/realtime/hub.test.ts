import { ACTIVE_WINDOW_MS, DAY_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binId, event, openTestDb, session, T0, VISITOR } from '../../test/rows.ts';
import { type Db, insertEvents, upsertSessions, withWriteTransaction } from '../db/index.ts';
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
      visitor: { name: 'Exuberant Ermine', color: 1 },
      path: '/a',
      eventAction: 'click',
      country: 'US',
      city: 'Boston',
      lat: 42.36,
      lon: -71.06,
      deviceType: 'desktop',
    });
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

describe('RealtimeHub visitor aliases', () => {
  it('gives one visitor one alias for the whole UTC day', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0 + 3_600_000, visitor_id: VISITOR, seq: 2 }));

    const aliases = hub.recent(50).map((hit) => hit.visitor);
    expect(aliases).toEqual([
      { name: 'Exuberant Ermine', color: 1 },
      { name: 'Exuberant Ermine', color: 1 },
    ]);
  });

  it('re-mints the alias when the UTC day rolls over', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    vi.setSystemTime(T0 + DAY_MS);
    hub.record(event({ ts: T0 + DAY_MS, visitor_id: VISITOR, seq: 2 }));

    const [today, tomorrow] = hub.recent(50).map((hit) => hit.visitor);
    expect(today).toEqual({ name: 'Exuberant Ermine', color: 1 });
    expect(tomorrow).toEqual({ name: 'Wistful Wallaby', color: 2 });
  });

  it('keeps one alias through a backward clock step across midnight', () => {
    // Midnight after T0 (14:00 UTC) is T0 + 10h. First hit lands just past it;
    // an NTP step then times the next hit just before it. The salt is
    // forward-only (identity.ts), so the alias day must hold too — otherwise
    // one visitor wears two names for the rest of the day.
    const midnight = T0 + 10 * 3_600_000;
    const hub = new RealtimeHub();
    hub.record(event({ ts: midnight + 60_000, visitor_id: VISITOR }));
    hub.record(event({ ts: midnight - 60_000, visitor_id: VISITOR, seq: 2 }));

    const names = hub.recent(50).map((hit) => hit.visitor.name);
    expect(names).toEqual(['Wistful Wallaby', 'Wistful Wallaby']);
  });

  it('tells two visitors apart by name', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0, visitor_id: OTHER }));

    const names = hub.recent(50).map((hit) => hit.visitor.name);
    expect(names).toEqual(['Exuberant Ermine', 'Humble Hedgehog']);
  });

  it('puts alias names on the wire but never a 16-hex token or an IP shape', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR, path: '/a' }));
    hub.record(event({ ts: T0, visitor_id: OTHER, path: '/b', country: 'VN', city: 'Hanoi' }));

    const wire = JSON.stringify(hub.recent(50));
    expect(wire).toContain('"name":"Exuberant Ermine"');
    expect(wire).toContain('"name":"Humble Hedgehog"');
    // The stronger property: no visitor hex — and nothing even shaped like one.
    expect(wire).not.toContain(Buffer.from(VISITOR).toString('hex'));
    expect(wire).not.toMatch(/[0-9a-f]{16}/i);
    expect(wire).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
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

describe('RealtimeHub feed seeding', () => {
  const store = (rows: Parameters<typeof insertEvents>[1]) =>
    withWriteTransaction(db, () => insertEvents(db, rows));

  it('refills the ring from stored events, oldest first, pings excluded', () => {
    store([
      event({ ts: T0 - 3_000, path: '/a' }),
      event({ ts: T0 - 2_000, type: 'ping', path: '/a' }),
      event({ ts: T0 - 1_000, path: '/b', visitor_id: OTHER }),
    ]);
    const hub = createRealtimeHub(db);
    const recent = hub.recent(10);
    expect(recent.map((hit) => hit.path)).toEqual(['/a', '/b']);
    expect(recent.map((hit) => hit.type)).toEqual(['pageview', 'pageview']);
  });

  it('seeded hits wear the same alias a live hit gets within the day', () => {
    store([event({ ts: T0 - 5_000, path: '/stored' })]);
    const hub = createRealtimeHub(db);
    const seeded = hub.recent(10)[0];
    hub.record(event({ ts: T0, path: '/live' }));
    const live = hub.recent(10).at(-1);
    expect(seeded?.visitor.name).toBe(live?.visitor.name);
  });

  it('is a no-op on an empty database and keeps ring ids monotonic after', () => {
    const hub = createRealtimeHub(db);
    expect(hub.recent(10)).toEqual([]);
    const seen: number[] = [];
    hub.subscribe((message) => {
      if (message.kind === 'hit') seen.push(message.entry.id);
    });
    hub.record(event({ ts: T0 }));
    hub.record(event({ ts: T0 + 1 }));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('caps the seed at the requested limit, keeping the newest rows', () => {
    store(
      Array.from({ length: 6 }, (_, i) => event({ ts: T0 - 6_000 + i * 1_000, path: `/${i}` })),
    );
    const hub = new RealtimeHub();
    hub.seedRecent(db, 3);
    expect(hub.recent(10).map((hit) => hit.path)).toEqual(['/3', '/4', '/5']);
  });
});
