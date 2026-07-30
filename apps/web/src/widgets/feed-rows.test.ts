import { describe, expect, it } from 'vitest';
import { actionLabel, placeLabel } from '../lib/realtime.ts';

/**
 * What a feed row says. That only ONE file draws the row is held by
 * `src/ownership.test.ts`, along with every other shared rendering.
 */
describe('feed row labels', () => {
  const hit = (over: Record<string, unknown> = {}) =>
    ({
      siteId: 1,
      ts: 0,
      type: 'pageview',
      visitor: { name: 'Amiable Aardvark', color: 0 },
      ...over,
    }) as Parameters<typeof placeLabel>[0];

  it('prints city with country, country alone, then Unknown', () => {
    expect(placeLabel(hit({ city: 'Masterton', country: 'NZ' }))).toBe('Masterton, NZ');
    expect(placeLabel(hit({ country: 'NZ' }))).toBe('New Zealand');
    expect(placeLabel(hit())).toBe('Unknown');
  });

  it('prints an event as category · action, and anything else as its path', () => {
    expect(
      actionLabel(hit({ type: 'event', eventCategory: 'signup', eventAction: 'created' })),
    ).toBe('signup · created');
    expect(actionLabel(hit({ type: 'event', eventAction: 'created' }))).toBe('created');
    expect(actionLabel(hit({ path: '/blog' }))).toBe('/blog');
    expect(actionLabel(hit())).toBe('/');
  });
});
