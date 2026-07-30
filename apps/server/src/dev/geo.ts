import type { GeoProvider, GeoResult } from '../pipeline/geo.ts';

/**
 * Deterministic geo for the seeded dev database: the corpus uses RFC 5737
 * TEST-NET addresses that no real mmdb can locate, which left the Countries
 * card, the realtime tally and the flags unverifiable out of the box. Each
 * address maps stably to one of a small city list — same seed, same map.
 */

/** Regions are ISO 3166-2 subdivision codes, as a real mmdb reports them. */
const CITIES: readonly GeoResult[] = [
  { country: 'US', region: 'MA', city: 'Boston', lat: 42.36, lon: -71.06 },
  { country: 'US', region: 'CA', city: 'San Francisco', lat: 37.77, lon: -122.42 },
  { country: 'DE', region: 'BE', city: 'Berlin', lat: 52.52, lon: 13.41 },
  { country: 'GB', region: 'ENG', city: 'London', lat: 51.51, lon: -0.13 },
  { country: 'FR', region: 'IDF', city: 'Paris', lat: 48.86, lon: 2.35 },
  { country: 'JP', region: '13', city: 'Tokyo', lat: 35.68, lon: 139.69 },
  { country: 'AU', region: 'NSW', city: 'Sydney', lat: -33.87, lon: 151.21 },
  { country: 'BR', region: 'SP', city: 'São Paulo', lat: -23.55, lon: -46.63 },
  { country: 'CA', region: 'ON', city: 'Toronto', lat: 43.65, lon: -79.38 },
  { country: 'NL', region: 'NH', city: 'Amsterdam', lat: 52.37, lon: 4.9 },
  { country: 'IN', region: 'KA', city: 'Bengaluru', lat: 12.97, lon: 77.59 },
  { country: 'SE', region: 'AB', city: 'Stockholm', lat: 59.33, lon: 18.07 },
];

export class DevGeoProvider implements GeoProvider {
  lookup(ip: string): GeoResult | null {
    if (ip === '') return null;
    let hash = 0;
    for (let i = 0; i < ip.length; i++) hash = (hash * 31 + ip.charCodeAt(i)) >>> 0;
    // A slice of addresses stays unlocated, like real traffic does.
    if (hash % 7 === 0) return null;
    return CITIES[hash % CITIES.length] ?? null;
  }
}
