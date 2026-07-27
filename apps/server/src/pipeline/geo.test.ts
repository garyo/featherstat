import { describe, expect, it } from 'vitest';
import { geoFromCity, MmdbProvider, NullProvider } from './geo.ts';

describe('NullProvider', () => {
  it('always returns null', () => {
    expect(new NullProvider().lookup()).toBeNull();
  });
});

describe('MmdbProvider', () => {
  it('tolerates a missing database file and degrades to null lookups', () => {
    const provider = new MmdbProvider('/nonexistent/geo.mmdb');
    expect(provider.lookup('203.0.113.9')).toBeNull();
    expect(provider.lookup('203.0.113.9')).toBeNull();
  });

  it('returns null for an empty ip', () => {
    expect(new MmdbProvider('/nonexistent/geo.mmdb').lookup('')).toBeNull();
  });
});

describe('geoFromCity', () => {
  it('maps a full city record to the stored columns', () => {
    expect(
      geoFromCity({
        country: { geoname_id: 1, iso_code: 'US', names: { en: 'United States' } },
        subdivisions: [{ geoname_id: 2, iso_code: 'MA', names: { en: 'Massachusetts' } }],
        city: { geoname_id: 3, names: { en: 'Boston' } },
        location: { accuracy_radius: 20, latitude: 42.36, longitude: -71.06 },
      }),
    ).toEqual({ country: 'US', region: 'Massachusetts', city: 'Boston', lat: 42.36, lon: -71.06 });
  });

  it('fills missing records with nulls', () => {
    expect(geoFromCity({})).toEqual({
      country: null,
      region: null,
      city: null,
      lat: null,
      lon: null,
    });
  });
});
