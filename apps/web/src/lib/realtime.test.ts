import type { RealtimeHit } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { countryTally, pushFeed, relativeAgo, seedFeed } from './realtime.ts';

const hit = (over: Partial<RealtimeHit>): RealtimeHit => ({
  siteId: 1,
  ts: 0,
  type: 'pageview',
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
