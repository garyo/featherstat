import type { RealtimeHit } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { countryTally, pushFeed, relativeAgo, seedFeed, visitorTally } from './realtime.ts';

const hit = (over: Partial<RealtimeHit>): RealtimeHit => ({
  siteId: 1,
  ts: 0,
  type: 'pageview',
  visitor: { name: 'Amiable Aardvark', color: 0 },
  ...over,
});

const visitor = (name: string, color = 0) => ({ name, color });

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
      hit({ ts: now - 4_000, visitor: visitor('Zesty Zebra', 2), country: 'DE' }),
      hit({ ts: now - 31 * 60_000, visitor: visitor('Zesty Zebra', 2) }), // outside the window
    ];
    expect(visitorTally(hits, now)).toEqual([
      { name: 'Bashful Badger', color: 1, count: 3, city: 'Hanoi', country: 'VN' },
      { name: 'Zesty Zebra', color: 2, count: 1, city: undefined, country: 'DE' },
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

describe('countryTally', () => {
  it('counts inside the window, drops unknown geo, ranks and scales', () => {
    const now = 100 * 60_000;
    const hits = [
      hit({ ts: now - 1_000, country: 'US' }),
      hit({ ts: now - 2_000, country: 'US' }),
      hit({ ts: now - 3_000, country: 'DE' }),
      hit({ ts: now - 3_000 }), // no geo
      hit({ ts: now - 31 * 60_000, country: 'JP' }), // outside the 30-min window
    ];
    expect(countryTally(hits, now)).toEqual([
      { country: 'US', count: 2, pct: '100.0' },
      { country: 'DE', count: 1, pct: '50.0' },
    ]);
  });
});
