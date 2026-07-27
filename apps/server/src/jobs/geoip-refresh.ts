import { createWriteStream, statSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { MmdbProvider } from '../pipeline/geo.ts';

/** Matches the `main.ts` default, so both halves point at the same file. */
export const DEFAULT_MMDB_PATH = 'dbip-city-lite.mmdb';

/**
 * Public resolver addresses used to prove the downloaded database answers
 * lookups. Every real City edition locates at least one; no visitor data is
 * involved (CLAUDE.md invariant 3).
 */
const SANITY_IPS = ['8.8.8.8', '1.1.1.1', '9.9.9.9'] as const;

/** Injected so tests never touch the network; production passes `globalThis.fetch`. */
export type Fetcher = (url: string) => Promise<Response>;

export interface GeoipRefreshOptions {
  /** Destination `.mmdb` — the same path the pipeline's `MmdbProvider` reads. */
  path: string;
  fetch?: Fetcher;
  now?: () => number;
}

export interface GeoipRefreshResult {
  /** `YYYY-MM` of the edition that landed: the previous month if this one is unpublished. */
  month: string;
  url: string;
  /** Size of the installed database. */
  bytes: number;
}

/**
 * Monthly GeoIP refresh (docs/01 R4): download the dated DB-IP City Lite,
 * gunzip it beside the destination, prove it parses, then swap it in with one
 * atomic rename. Any failure leaves the database in use untouched — a broken
 * download must never cost us working geo data.
 */
export async function refreshGeoipDatabase(
  options: GeoipRefreshOptions,
): Promise<GeoipRefreshResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now?.() ?? Date.now();
  /** Early in a month the current edition may not exist yet; last month's does. */
  const months = [monthKey(now, 0), monthKey(now, 1)];
  // Same directory as the destination: rename() is only atomic within a filesystem.
  // Pid-suffixed so a concurrent CLI run and the in-process job never interleave.
  const temp = `${options.path}.download.${process.pid}`;
  const refused: string[] = [];

  try {
    for (const month of months) {
      const url = editionUrl(month);
      const response = await fetcher(url);
      if (!response.ok || response.body === null) {
        refused.push(`${url} → HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined); // release the socket
        continue;
      }
      await download(response.body, temp);
      verifyMmdb(temp);
      const { size } = await stat(temp);
      await rename(temp, options.path);
      return { month, url, bytes: size };
    }
  } finally {
    await rm(temp, { force: true });
  }
  throw new Error(`no DB-IP City Lite edition available (${refused.join('; ')})`);
}

/** The installed database's mtime doubles as the job's last-run time across restarts. */
export function geoipInstalledAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

async function download(body: AsyncIterable<Uint8Array>, temp: string): Promise<void> {
  // Streamed, never buffered: the City edition dwarfs the process RSS budget.
  await pipeline(body, createGunzip(), createWriteStream(temp));
}

/**
 * A truncated download, an error page, or a corrupt gzip tail all parse as
 * garbage; opening the file with the reader the pipeline itself uses is the
 * cheapest proof that what we are about to install works.
 */
function verifyMmdb(path: string): void {
  const provider = new MmdbProvider(path);
  if (SANITY_IPS.every((ip) => provider.lookup(ip) === null)) {
    throw new Error(`downloaded database failed its sanity lookups: ${path}`);
  }
}

/** DB-IP publishes a dated City Lite edition every month, free and keyless (docs/02). */
function editionUrl(month: string): string {
  return `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;
}

/** `YYYY-MM`, UTC, `monthsBack` months before `now`. */
function monthKey(now: number, monthsBack: number): string {
  const date = new Date(now);
  date.setUTCDate(1); // before shifting: month arithmetic on a 31st overflows
  date.setUTCMonth(date.getUTCMonth() - monthsBack);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
