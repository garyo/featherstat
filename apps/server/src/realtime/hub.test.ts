import {
  ACTIVE_WINDOW_MS,
  DAY_MS,
  MAX_ENGAGEMENT_ENTRIES,
  PING_CLAMP_MS,
  type RealtimeHit,
  SESSION_TIMEOUT_MS,
  TALLY_WINDOW_MS,
} from '@featherstat/shared';
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
    expect(hit?.visitor.ref).toMatch(/^[0-9a-f]{12}$/);
    expect(hit).toEqual({
      siteId: 1,
      ts: T0,
      type: 'pageview',
      engagedMs: undefined,
      visitor: { name: 'Easygoing Ermine', color: 2, ref: hit?.visitor.ref },
      path: '/a',
      eventAction: 'click',
      country: 'US',
      city: 'Boston',
      lat: 42.36,
      lon: -71.06,
      deviceType: 'desktop',
    });
  });

  // Props are operator-owned payload, not audience telemetry — they stay off
  // the SSE wire entirely (docs/03 § Props), live path and boot seed alike.
  it('never puts a stored prop bag on the wire', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, path: '/pricing', props: '{"plan":"pro"}' }));
    withWriteTransaction(db, () =>
      insertEvents(db, [event({ ts: T0, path: '/seeded', props: '{"plan":"free"}' })]),
    );
    hub.seedRecent(db);
    const hits = hub.recent(50);
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(hit).not.toHaveProperty('props');
      expect(JSON.stringify(hit)).not.toContain('plan');
    }
  });

  // Reversed deliberately: pings used to be dropped here as noise. They are what
  // MEASURES a page, and dropping them forced the feed to carry a figure derived
  // elsewhere — which is how a row came to mean one thing live and another after
  // a restart. The feed is the raw stream; the client collapses it.
  it('carries pings in the feed AND counts them as active', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, type: 'ping', visitor_id: OTHER }));
    expect(hub.recent(50).map((hit) => hit.type)).toEqual(['ping']);
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
    hub.recordFlush({
      events: 1,
      sessions: 1,
      botDrops: 0,
      excludedDrops: 0,
      missing: 0,
      siteIds: [1],
    });
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

    hub.recordFlush({
      events: 2,
      sessions: 2,
      botDrops: 0,
      excludedDrops: 0,
      missing: 0,
      siteIds: [1, 2],
    });
    hub.recordFlush({
      events: 1,
      sessions: 1,
      botDrops: 0,
      excludedDrops: 0,
      missing: 0,
      siteIds: [2],
    });

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
      expect.objectContaining({ name: 'Easygoing Ermine', color: 2 }),
      expect.objectContaining({ name: 'Easygoing Ermine', color: 2 }),
    ]);
    // The ref is what consumers key on: one visitor, one ref, all day.
    expect(aliases[0]?.ref).toBe(aliases[1]?.ref);
  });

  it('re-mints the alias when the UTC day rolls over', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    vi.setSystemTime(T0 + DAY_MS);
    hub.record(event({ ts: T0 + DAY_MS, visitor_id: VISITOR, seq: 2 }));

    const [today, tomorrow] = hub.recent(50).map((hit) => hit.visitor);
    expect(today).toMatchObject({ name: 'Easygoing Ermine', color: 2 });
    expect(tomorrow).toMatchObject({ name: 'Wistful Wallaby', color: 1 });
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
    expect(names).toEqual(['Easygoing Ermine', 'Humble Heron']);
  });

  it('puts alias names on the wire but never a 16-hex token or an IP shape', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR, path: '/a' }));
    hub.record(event({ ts: T0, visitor_id: OTHER, path: '/b', country: 'VN', city: 'Hanoi' }));

    const wire = JSON.stringify(hub.recent(50));
    expect(wire).toContain('"name":"Easygoing Ermine"');
    expect(wire).toContain('"name":"Humble Heron"');
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

describe('RealtimeHub visitor engagement', () => {
  /** `{ name: engagedMs }` — the wire rows keyed for readable assertions. */
  const timeByName = (hub: RealtimeHub, now: number): Record<string, number> =>
    Object.fromEntries(hub.visitors(now).map((entry) => [entry.name, entry.engagedMs]));

  it('accrues every gap, pings included — the heartbeat is what makes it honest', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0 + 5_000, type: 'ping', visitor_id: VISITOR, seq: 2 }));
    hub.record(event({ ts: T0 + 12_000, visitor_id: VISITOR, seq: 3 }));

    expect(hub.visitors(T0 + 12_000)).toEqual([
      expect.objectContaining({
        name: 'Easygoing Ermine',
        color: 2,
        siteId: 1,
        engagedMs: 12_000,
        lastTs: T0 + 12_000,
      }),
    ]);
  });

  it('credits at most PING_CLAMP_MS per gap, so an idle tab cannot inflate the figure', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0 + 60_000, visitor_id: VISITOR, seq: 2 }));

    expect(timeByName(hub, T0 + 60_000)).toEqual({ 'Easygoing Ermine': PING_CLAMP_MS });
  });

  it('starts the figure over when a visitor returns on a new session', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    // Another visitor at the window edge: the sweep runs, and an entry exactly
    // at the cutoff must survive it — otherwise this proves nothing below.
    hub.record(event({ ts: T0 + TALLY_WINDOW_MS, visitor_id: OTHER }));
    expect(timeByName(hub, T0 + TALLY_WINDOW_MS)['Easygoing Ermine']).toBe(0);

    const returning = T0 + SESSION_TIMEOUT_MS + 1_000;
    hub.record(event({ ts: returning, visitor_id: VISITOR, seq: 2 }));
    hub.record(event({ ts: returning + 3_000, visitor_id: VISITOR, seq: 3 }));

    // The card reads as time on THIS visit, not a day's worth of them.
    expect(timeByName(hub, returning + 3_000)['Easygoing Ermine']).toBe(3_000);
  });

  it('forgets a visitor once the tally window has passed, reader or none', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0, site_id: 2, visitor_id: OTHER }));
    expect(hub.trackedEngagement()).toBe(2);

    // No reader in between: ingest alone must evict what aged out.
    const late = T0 + 2 * TALLY_WINDOW_MS;
    hub.record(event({ ts: late, visitor_id: STALE }));
    expect(hub.trackedEngagement()).toBe(1);

    // The reader's own sweep: an entry exactly at the cutoff still counts.
    expect(hub.visitors(late + TALLY_WINDOW_MS)).toHaveLength(1);
    expect(hub.visitors(late + TALLY_WINDOW_MS + 1)).toEqual([]);
  });

  it('tracks a visitor per site, and keys every entry by the alias its hits wear', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    hub.record(event({ ts: T0 + 1_000, site_id: 2, visitor_id: VISITOR }));
    hub.record(event({ ts: T0 + 2_000, visitor_id: OTHER }));

    expect(hub.visitors(T0 + 2_000)).toEqual([
      expect.objectContaining({ name: 'Easygoing Ermine', siteId: 1 }),
      expect.objectContaining({ name: 'Easygoing Ermine', siteId: 2 }),
      expect.objectContaining({ name: 'Humble Heron', siteId: 1 }),
    ]);
    // Same names the feed carries, so the two views merge into one row per visitor.
    expect(hub.recent(50).map((hit) => hit.visitor.name)).toEqual([
      'Easygoing Ermine',
      'Easygoing Ermine',
      'Humble Heron',
    ]);

    const wire = JSON.stringify(hub.visitors(T0 + 2_000));
    expect(wire).not.toContain(Buffer.from(VISITOR).toString('hex'));
    expect(wire).not.toMatch(/[0-9a-f]{16}/i);
    expect(wire).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it('seeds engaged time from the same sessions the counter is seeded from', () => {
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        session({
          id: Uint8Array.of(1),
          visitor_id: VISITOR,
          last_seen_at: T0 - 60_000,
          engaged_ms: 90_000,
        }),
        // Outside the 5-min active window, inside the 30-min tally window.
        session({
          id: Uint8Array.of(2),
          site_id: 2,
          visitor_id: OTHER,
          last_seen_at: T0 - 20 * 60_000,
          engaged_ms: 45_000,
        }),
        session({
          id: Uint8Array.of(3),
          visitor_id: STALE,
          last_seen_at: T0 - TALLY_WINDOW_MS - 1,
          engaged_ms: 5_000,
        }),
      ]);
    });

    const hub = createRealtimeHub(db);
    expect(timeByName(hub, T0)).toEqual({ 'Easygoing Ermine': 90_000, 'Humble Heron': 45_000 });
    // The wider seed query must not widen the counter itself.
    expect(hub.activeCounts(T0)).toEqual({ 1: 1, 2: 0 });

    // A deploy is not a break in the visit: the next hit continues the figure.
    hub.record(event({ ts: T0, visitor_id: VISITOR }));
    expect(timeByName(hub, T0)['Easygoing Ermine']).toBe(90_000 + PING_CLAMP_MS);
  });

  it('restores the newest session of a visitor who has more than one', () => {
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        session({ id: Uint8Array.of(1), last_seen_at: T0 - 25 * 60_000, engaged_ms: 300_000 }),
        session({ id: Uint8Array.of(2), last_seen_at: T0 - 60_000, engaged_ms: 12_000 }),
      ]);
    });

    expect(createRealtimeHub(db).visitors(T0)).toEqual([
      expect.objectContaining({
        name: 'Easygoing Ermine',
        color: 2,
        siteId: 1,
        engagedMs: 12_000,
        lastTs: T0 - 60_000,
      }),
    ]);
  });
});

describe('RealtimeHub feed seeding', () => {
  const store = (rows: Parameters<typeof insertEvents>[1]) =>
    withWriteTransaction(db, () => insertEvents(db, rows));

  it('refills the ring from stored events, oldest first, pings included', () => {
    store([
      event({ ts: T0 - 3_000, path: '/a' }),
      event({ ts: T0 - 2_000, type: 'ping', path: '/a' }),
      event({ ts: T0 - 1_000, path: '/b', visitor_id: OTHER }),
    ]);
    const hub = createRealtimeHub(db);
    const recent = hub.recent(10);
    // Same rows the live path would have pushed — that sameness is the point.
    expect(recent.map((hit) => hit.path)).toEqual(['/a', '/a', '/b']);
    expect(recent.map((hit) => hit.type)).toEqual(['pageview', 'ping', 'pageview']);
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

describe('RealtimeHub feed is the raw hit stream', () => {
  it('carries every hit, heartbeats included — they are what measures a page', () => {
    const hub = new RealtimeHub();
    hub.record(event({ ts: T0, visitor_id: VISITOR, path: '/first' }));
    hub.record(event({ ts: T0 + 15_000, type: 'ping', visitor_id: VISITOR, path: '/first' }));
    hub.record(event({ ts: T0 + 30_000, visitor_id: VISITOR, path: '/second' }));

    // The ping is a row. The client collapses the run; the wire hides nothing,
    // so time on page is recoverable rather than something the server ships.
    expect(hub.recent(10).map((hit) => hit.type)).toEqual(['pageview', 'ping', 'pageview']);
  });

  /**
   * The bug this design deletes: a row used to carry the visit length as of that
   * hit, which the boot path could not reconstruct, so it substituted the
   * visit's TOTAL — and a row meant one thing live and another after a deploy.
   * With nothing derived on a row the two paths cannot disagree, and this test
   * is the statement of that rather than a check of any one field.
   */
  it('gives a seeded row exactly what the live path would have given it', () => {
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        session({ id: Uint8Array.of(9), visitor_id: VISITOR, engaged_ms: 42_000 }),
      ]);
      insertEvents(db, [event({ ts: T0, session_id: Uint8Array.of(9), path: '/restored' })]);
    });
    const seeded = createRealtimeHub(db).recent(10)[0];

    const live = new RealtimeHub();
    live.record(
      event({ ts: T0, session_id: Uint8Array.of(9), visitor_id: VISITOR, path: '/restored' }),
    );

    // `ref` is minted per process, so two hubs never share one; everything a
    // row actually carries must match.
    const withoutRef = (hit: RealtimeHit | undefined) =>
      hit === undefined ? undefined : { ...hit, visitor: { ...hit.visitor, ref: '' } };
    expect(withoutRef(seeded)).toEqual(withoutRef(live.recent(10)[0]));
    // Specifically: the session's 42 s is nowhere on the row, live or restored.
    expect(JSON.stringify(seeded)).not.toContain('42000');
  });

  it('caps the live map at MAX_ENGAGEMENT_ENTRIES, keeping the newest', () => {
    const hub = new RealtimeHub();
    for (let i = 0; i <= MAX_ENGAGEMENT_ENTRIES + 20; i++) {
      hub.record(event({ ts: T0 + i, visitor_id: binId(1_000 + i) }));
    }
    expect(hub.trackedEngagement()).toBe(MAX_ENGAGEMENT_ENTRIES);
  });
});
