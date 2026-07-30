import { readFileSync, statSync } from 'node:fs';
import { type CityResponse, Reader } from 'mmdb-lib';

export interface GeoResult {
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** ISO 3166-2 subdivision code without the country prefix (`MA`, `ENG`) — the
   * form the Matomo importer already writes, so both paths group together. */
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

/** How often a live provider re-stats its file for a newer edition. */
const RECHECK_EVERY_MS = 60_000;

/**
 * City-level lookups from a local `.mmdb` (DB-IP City Lite; GeoLite2 is the same
 * format). Loaded lazily on first lookup; a missing or unreadable file degrades
 * to null lookups so the server runs fine without geo data. The file's mtime is
 * re-checked (at most once a minute) so the monthly refresh job's atomic swap —
 * or a download that finished after a failed first load — takes effect in the
 * running process, no restart needed.
 */
export class MmdbProvider implements GeoProvider {
  private reader: Reader<CityResponse> | null = null;
  /** mtime of the loaded file; null = nothing loaded (missing/unreadable). */
  private loadedMtimeMs: number | null = null;
  private nextCheckAt = 0;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  lookup(ip: string): GeoResult | null {
    this.ensureFresh();
    if (this.reader === null || ip === '') return null;
    try {
      const record = this.reader.get(ip);
      return record === null ? null : geoFromCity(record);
    } catch {
      return null;
    }
  }

  private ensureFresh(): void {
    const now = this.now();
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + RECHECK_EVERY_MS;
    const mtime = this.statMtime();
    if (mtime === this.loadedMtimeMs) return; // same edition (or still missing)
    this.reader = mtime === null ? null : this.load();
    this.loadedMtimeMs = this.reader === null ? null : mtime;
  }

  private statMtime(): number | null {
    try {
      return statSync(this.path).mtimeMs;
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
    region: record.subdivisions?.[0]?.iso_code ?? null,
    city: record.city?.names.en ?? null,
    lat: record.location?.latitude ?? null,
    lon: record.location?.longitude ?? null,
  };
}
