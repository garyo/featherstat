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

  // The stored region is the geo database's own word — a NAME from DB-IP City
  // Lite, a code from the Matomo importer. Both must print as the code.
  it('prints the state for US and CA — the address line people expect', () => {
    expect(placeLabel(hit({ city: 'Wake Forest', region: 'North Carolina', country: 'US' }))).toBe(
      'Wake Forest, NC',
    );
    expect(placeLabel(hit({ city: 'Toronto', region: 'Ontario', country: 'CA' }))).toBe(
      'Toronto, ON',
    );
    expect(placeLabel(hit({ city: 'Boston', region: 'MA', country: 'US' }))).toBe('Boston, MA');
  });

  it('prints the country elsewhere, region or not — `Exeter, GB`, never `Exeter, Devon`', () => {
    expect(placeLabel(hit({ city: 'Exeter', region: 'Devon', country: 'GB' }))).toBe('Exeter, GB');
    expect(placeLabel(hit({ city: 'Hanoi', country: 'VN' }))).toBe('Hanoi, VN');
  });

  it('falls back to the country when a US hit has no state, or an unmapped one', () => {
    expect(placeLabel(hit({ city: 'Wake Forest', country: 'US' }))).toBe('Wake Forest, US');
    expect(placeLabel(hit({ city: 'Nowhere', region: 'Freedonia', country: 'US' }))).toBe(
      'Nowhere, US',
    );
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
