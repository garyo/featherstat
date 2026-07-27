import { readFileSync } from 'node:fs';
import { type CityResponse, Reader } from 'mmdb-lib';

export interface GeoResult {
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** Purely local lookups — no network calls anywhere in the pipeline. */
export interface GeoProvider {
  lookup(ip: string): GeoResult | null;
}

export class NullProvider implements GeoProvider {
  lookup(): null {
    return null;
  }
}

/**
 * City-level lookups from a local `.mmdb` (DB-IP City Lite; GeoLite2 is the same
 * format). Loaded lazily on first lookup; a missing or unreadable file degrades
 * to null lookups so the server runs fine without geo data.
 */
export class MmdbProvider implements GeoProvider {
  /** `undefined` = not yet loaded; `null` = load failed, stay degraded. */
  private reader: Reader<CityResponse> | null | undefined;

  constructor(private readonly path: string) {}

  lookup(ip: string): GeoResult | null {
    if (this.reader === undefined) this.reader = this.load();
    if (this.reader === null || ip === '') return null;
    try {
      const record = this.reader.get(ip);
      return record === null ? null : geoFromCity(record);
    } catch {
      return null;
    }
  }

  private load(): Reader<CityResponse> | null {
    try {
      return new Reader<CityResponse>(readFileSync(this.path));
    } catch {
      return null;
    }
  }
}

/** Maps an mmdb city record to the stored columns — city centroid, never the IP (docs/03). */
export function geoFromCity(record: CityResponse): GeoResult {
  return {
    country: record.country?.iso_code ?? null,
    region: record.subdivisions?.[0]?.names.en ?? null,
    city: record.city?.names.en ?? null,
    lat: record.location?.latitude ?? null,
    lon: record.location?.longitude ?? null,
  };
}
