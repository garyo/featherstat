import {
  PING_CLAMP_MS,
  type RealtimeEngagement,
  type RealtimeHit,
  SESSION_TIMEOUT_MS,
  TALLY_WINDOW_MS,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  collapseRuns,
  countryTally,
  engagementByName,
  placeOf,
  pushFeed,
  relativeAgo,
  seedFeed,
  visitorMeta,
  visitorTally,
  visitorTrail,
} from './realtime.ts';

const hit = (over: Partial<RealtimeHit>): RealtimeHit => ({
  siteId: 1,
  ts: 0,
  type: 'pageview',
  visitor: { name: 'Amiable Aardvark', color: 0, ref: 'ref-a' },
  ...over,
});

/** Refs are opaque and per-visitor; tests derive a stable one from the label. */
/**
 * Refs are opaque and per (site, visitor) — the server mints them from the
 * visitor id, which is itself salted per site. Tests spell them out so a test
 * can put one NAME on two sites and still describe two visitors.
 */
const visitor = (name: string, color = 0, site = 1) => ({
  name,
  color,
  ref: `ref-${site}-${name}`,
});

const engagement = (over: Partial<RealtimeEngagement> & { name: string }): RealtimeEngagement => ({
  color: 0,
  siteId: 1,
  ref: `ref-${over.siteId ?? 1}-${over.name}`,
  engagedMs: 0,
  lastTs: 0,
  ...over,
});

describe('relativeAgo', () => {
  it('formats seconds, minutes and hours', () => {
    expect(relativeAgo(1_000, 1_500)).toBe('now');
    expect(relativeAgo(0, 8_000)).toBe('8s');
    expect(relativeAgo(0, 4 * 60_000 + 5_000)).toBe('4m');
    expect(relativeAgo(0, 2 * 3_600_000)).toBe('2h');
  });
});

describe('feed', () => {
  it('seeds newest-first from the oldest-first snapshot, scoped to the site', () => {
    const recent = [hit({ ts: 1 }), hit({ ts: 2, siteId: 2 }), hit({ ts: 3 })];
    expect(seedFeed(recent, 1).map((h) => h.ts)).toEqual([3, 1]);
    expect(seedFeed(recent, 'all').map((h) => h.ts)).toEqual([3, 2, 1]);
  });

  it('prepends live hits and stays bounded', () => {
    let feed = seedFeed([], 'all');
    for (let i = 0; i < 150; i++) feed = pushFeed(feed, hit({ ts: i }));
    expect(feed).toHaveLength(100);
    expect(feed[0]?.ts).toBe(149);
  });
});

describe('visitorTally', () => {
  it('groups newest-first hits by alias, ranks by count and keeps the latest place', () => {
    const now = 100 * 60_000;
    const hits = [
      hit({ ts: now - 1_000, visitor: visitor('Bashful Badger', 1) }), // newest: no geo yet
      hit({ ts: now - 2_000, visitor: visitor('Bashful Badger', 1), city: 'Hanoi', country: 'VN' }),
      hit({ ts: now - 3_000, visitor: visitor('Bashful Badger', 1), city: 'Hue', country: 'VN' }),
      hit({ ts: now - 4_000, visitor: visitor('Zesty Zebra', 2, 3), country: 'DE', siteId: 3 }),
      // Outside the window: same visitor, still not counted.
      hit({ ts: now - TALLY_WINDOW_MS - 1, visitor: visitor('Zesty Zebra', 2, 3), siteId: 3 }),
    ];
    expect(visitorTally(hits, now)).toEqual([
      {
        ref: 'ref-1-Bashful Badger',
        name: 'Bashful Badger',
        color: 1,
        count: 3,
        siteId: 1,
        city: 'Hanoi',
        country: 'VN',
        engagedMs: undefined,
      },
      // siteId follows the newest hit, like the place fields
      {
        ref: 'ref-3-Zesty Zebra',
        name: 'Zesty Zebra',
        color: 2,
        count: 1,
        siteId: 3,
        city: undefined,
        country: 'DE',
        engagedMs: undefined,
      },
    ]);
  });

  it('breaks count ties by name and caps the list', () => {
    const now = 60_000;
    const names = ['Merry Marmot', 'Curious Capybara', 'Zany Zebra', 'Amiable Aardvark'];
    const hits = names.flatMap((name, i) =>
      Array.from({ length: 9 - i }, (_, j) => hit({ ts: now - j, visitor: visitor(name) })),
    );
    hits.push(hit({ ts: now, visitor: visitor('Keen Kiwi') }));
    hits.push(hit({ ts: now, visitor: visitor('Jaunty Jackrabbit') }));

    const tally = visitorTally(hits, now);
    expect(tally.map((row) => row.name)).toEqual([
      'Merry Marmot', // 9 hits … down to 6
      'Curious Capybara',
      'Zany Zebra',
      'Amiable Aardvark',
      'Jaunty Jackrabbit', // 1 hit each — alphabetical
      'Keen Kiwi',
    ]);
    const capped = visitorTally(
      Array.from({ length: 12 }, (_, i) => hit({ ts: now, visitor: visitor(`Visitor ${i}`) })),
      now,
    );
    expect(capped).toHaveLength(8);
  });
});

describe('visitor engagement', () => {
  const entries = [
    engagement({ name: 'Observant Ocelot', engagedMs: 100_000, siteId: 1 }),
    engagement({ name: 'Observant Ocelot', engagedMs: 60_000, siteId: 2 }),
    engagement({ name: 'Quiet Quokka', engagedMs: 0, siteId: 1 }),
  ];

  it('keys engagement per (site, visitor) — one name on two sites is two visitors', () => {
    // Visitor ids are salted per site, so the same person on two sites is two
    // visitors by our identity model; two strangers can also draw one name.
    // Either way, summing them into one figure invents a person.
    expect(engagementByName(entries, 'all')).toEqual(
      new Map([
        ['ref-1-Observant Ocelot', 100_000],
        ['ref-2-Observant Ocelot', 60_000],
      ]),
    );
    expect(engagementByName(entries, 2)).toEqual(new Map([['ref-2-Observant Ocelot', 60_000]]));
    expect(engagementByName(entries, 3)).toEqual(new Map());
  });

  it('gives a shared name one row per site, each with its own hits and time', () => {
    const now = 60_000;
    const hits = [
      hit({
        ts: now,
        siteId: 1,
        visitor: visitor('Observant Ocelot'),
        city: 'Masterton',
        country: 'NZ',
      }),
      hit({ ts: now - 1_000, siteId: 1, visitor: visitor('Observant Ocelot') }),
      hit({ ts: now - 2_000, siteId: 2, visitor: visitor('Observant Ocelot', 0, 2) }),
      hit({ ts: now - 3_000, siteId: 1, visitor: visitor('Quiet Quokka') }),
    ];
    const rows = visitorTally(hits, now, engagementByName(entries, 'all'));
    const one = rows.find((row) => row.siteId === 1 && row.name === 'Observant Ocelot');
    const two = rows.find((row) => row.siteId === 2 && row.name === 'Observant Ocelot');
    if (one === undefined || two === undefined) throw new Error('expected a row per site');

    expect(one).toMatchObject({ count: 2, engagedMs: 100_000 });
    expect(two).toMatchObject({ count: 1, engagedMs: 60_000 });
    expect(visitorMeta(one, 'Masterton, NZ', 'deep-timeline.org')).toBe(
      '2 hits · 1m 40s · Masterton, NZ · deep-timeline.org',
    );

    // Nothing on the clock yet: the row reads `1 hit`, never `1 hit · 0s`.
    const quokka = rows.find((row) => row.name === 'Quiet Quokka');
    expect(quokka?.engagedMs).toBeUndefined();
    expect(quokka === undefined ? '' : visitorMeta(quokka)).toBe('1 hit');
  });

  it('walks one visitor′s trail: their site, their window, newest first', () => {
    const now = 60 * 60_000;
    const mine = { ref: 'ref-1-Observant Ocelot' };
    const hits = [
      hit({ ts: now - 1_000, siteId: 1, visitor: visitor('Observant Ocelot'), path: '/newest' }),
      // Same name, other site: a different visitor, never this visitor's step.
      hit({
        ts: now - 2_000,
        siteId: 2,
        visitor: visitor('Observant Ocelot', 0, 2),
        path: '/theirs',
      }),
      hit({ ts: now - 3_000, siteId: 1, visitor: visitor('Observant Ocelot'), path: '/older' }),
      // Outside the tally window the row is counted over.
      hit({
        ts: now - TALLY_WINDOW_MS - 1,
        siteId: 1,
        visitor: visitor('Observant Ocelot'),
        path: '/ages',
      }),
    ];
    expect(visitorTrail(hits, mine, now).map((step) => step.label)).toEqual(['/newest', '/older']);
  });

  it('carries the region onto the row, so a tally row can print the state too', () => {
    const now = 60_000;
    const hits = [
      hit({ ts: now, visitor: visitor('Observant Ocelot') }), // unlocated, must not blank
      hit({
        ts: now - 1_000,
        visitor: visitor('Observant Ocelot'),
        city: 'Wake Forest',
        region: 'North Carolina',
        country: 'US',
      }),
    ];
    const row = visitorTally(hits, now)[0];
    expect(row).toMatchObject({ city: 'Wake Forest', region: 'North Carolina', country: 'US' });
    expect(placeOf(row ?? {})).toBe('Wake Forest, NC');
  });

  it('leaves the tally alone when no engagement has arrived', () => {
    const rows = visitorTally([hit({ ts: 0, visitor: visitor('Quiet Quokka') })], 0);
    expect(rows[0]?.engagedMs).toBeUndefined();
  });
});

describe('countryTally', () => {
  it('counts inside the window, drops unknown geo, ranks and scales', () => {
    const now = 100 * 60_000;
    const hits = [
      hit({ ts: now - 1_000, country: 'US' }),
      hit({ ts: now - 2_000, country: 'US' }),
      hit({ ts: now - 3_000, country: 'DE' }),
      hit({ ts: now - 3_000 }), // no geo
      hit({ ts: now - TALLY_WINDOW_MS - 1, country: 'JP' }), // outside the 30-min window
    ];
    expect(countryTally(hits, now)).toEqual([
      { country: 'US', count: 2, pct: '100.0' },
      { country: 'DE', count: 1, pct: '50.0' },
    ]);
  });
});

describe('collapseRuns', () => {
  const S = 1_000;
  /** The feed's order: newest first. */
  const feed = (...chrono: RealtimeHit[]): RealtimeHit[] => [...chrono].reverse();
  const v = visitor('Merry Magpie');

  /**
   * The visit that prompted all of this: one page view and six heartbeats over
   * 90 s, which the old feed rendered as a single row saying `1m 30s` with no
   * sign of where the time came from — and, after a restart, said the same
   * thing for a reason that had nothing to do with this page.
   */
  it('turns a page view and its heartbeats into one row worth 90 s', () => {
    const hits = feed(
      hit({ ts: 0, visitor: v, path: '/era' }),
      ...Array.from({ length: 6 }, (_, i) =>
        hit({ ts: (i + 1) * 15 * S, type: 'ping', visitor: v, path: '/era' }),
      ),
    );
    const runs = collapseRuns(hits);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pageMs).toBe(90 * S);
    expect(runs[0]?.hits).toHaveLength(7);
    expect(runs[0]?.actions).toBe(0);
  });

  /**
   * The number a run shows must be the number `query/dwell.ts` would attribute,
   * or the feed and the time-on-page card describe the same visit differently.
   * The load-bearing half is the LAST hit of a run: the gap it opens is closed
   * by the next page's hit, and belongs to the page being left.
   */
  it('gives the leaving gap to the page being left, as dwell does', () => {
    const runs = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/a' }),
        hit({ ts: 5 * S, visitor: v, path: '/b' }),
        hit({ ts: 9 * S, visitor: v, path: '/c' }),
      ),
    );
    // 5 s on /a, 4 s on /b, and /c unmeasured — nothing has followed it yet.
    expect(runs.map((run) => run.pageMs)).toEqual([undefined, 4 * S, 5 * S]);
  });

  it('clamps a gap, so wandering off banks one heartbeat and not the absence', () => {
    const runs = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/a' }),
        hit({ ts: 10 * 60 * S, type: 'ping', visitor: v, path: '/a' }),
        hit({ ts: 10 * 60 * S + S, visitor: v, path: '/b' }),
      ),
    );
    expect(runs.at(-1)?.pageMs).toBe(PING_CLAMP_MS + S);
  });

  // The newest row of a live visit is being measured, not brief: a run reads as
  // having no time rather than 0 s, the same honesty `measured_sessions` keeps.
  it('leaves the newest run unmeasured rather than calling it zero', () => {
    const runs = collapseRuns(feed(hit({ ts: 0, visitor: v, path: '/only' })));
    expect(runs[0]?.pageMs).toBeUndefined();
  });

  it('counts what the visitor did, so an action never folds into the time', () => {
    const runs = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/post' }),
        hit({ ts: 15 * S, type: 'ping', visitor: v, path: '/post' }),
        hit({ ts: 20 * S, type: 'event', visitor: v, path: '/post', eventAction: 'subscribe' }),
        hit({ ts: 25 * S, type: 'outlink', visitor: v, path: '/post' }),
        hit({ ts: 30 * S, visitor: v, path: '/next' }),
      ),
    );
    expect(runs.at(-1)?.actions).toBe(2);
    // A hit type this code has never seen is an action by default, not absorbed.
    const future = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/post' }),
        hit({ ts: S, type: 'download', visitor: v, path: '/post' }),
      ),
    );
    expect(future[0]?.actions).toBe(1);
  });

  it('breaks a run on the visitor, the site, the page, or a new visit', () => {
    const other = visitor('Brisk Bittern');
    const runs = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/a' }),
        hit({ ts: S, visitor: other, path: '/a' }), // different visitor
        hit({ ts: 2 * S, visitor: v, path: '/a', siteId: 2 }), // different site
        hit({ ts: 3 * S, visitor: v, path: '/b' }), // different page
        hit({ ts: 3 * S + SESSION_TIMEOUT_MS + S, visitor: v, path: '/b' }), // new visit
      ),
    );
    expect(runs).toHaveLength(5);
  });

  it('keeps a returning reader′s two stays on one page apart', () => {
    const runs = collapseRuns(
      feed(
        hit({ ts: 0, visitor: v, path: '/a' }),
        hit({ ts: 5 * S, visitor: v, path: '/b' }),
        hit({ ts: 10 * S, visitor: v, path: '/a' }),
      ),
    );
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.latest.path)).toEqual(['/a', '/b', '/a']);
  });
});
