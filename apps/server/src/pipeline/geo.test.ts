import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMmdb } from '../../test/mmdb.ts';
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

  it('picks up a database installed AFTER a failed first load (boot race heals)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    const path = join(dir, 'city.mmdb');
    let clock = 1_000_000;
    const provider = new MmdbProvider(path, () => clock);
    try {
      expect(provider.lookup('8.8.8.8')).toBeNull(); // hit arrives before the download lands
      writeFileSync(path, buildMmdb('Boston'));
      expect(provider.lookup('8.8.8.8')).toBeNull(); // within the recheck window: still degraded
      clock += 61_000;
      expect(provider.lookup('8.8.8.8')?.city).toBe('Boston'); // healed, no restart
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reloads when the refresh job swaps the file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    const path = join(dir, 'city.mmdb');
    let clock = 1_000_000;
    const provider = new MmdbProvider(path, () => clock);
    try {
      writeFileSync(path, buildMmdb('Boston'));
      expect(provider.lookup('8.8.8.8')?.city).toBe('Boston');
      writeFileSync(path, buildMmdb('Cambridge'));
      utimesSync(path, new Date(), new Date(Date.now() + 5_000)); // distinct mtime
      expect(provider.lookup('8.8.8.8')?.city).toBe('Boston'); // old edition until the recheck
      clock += 61_000;
      expect(provider.lookup('8.8.8.8')?.city).toBe('Cambridge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    ).toEqual({ country: 'US', region: 'MA', city: 'Boston', lat: 42.36, lon: -71.06 });
  });

  it('takes the subdivision CODE, not its name — the importer writes codes too', () => {
    const record = geoFromCity({
      country: { geoname_id: 1, iso_code: 'US', names: { en: 'United States' } },
      subdivisions: [{ geoname_id: 2, iso_code: 'NC', names: { en: 'North Carolina' } }],
      city: { geoname_id: 3, names: { en: 'Wake Forest' } },
    });
    expect(record.region).toBe('NC');
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
