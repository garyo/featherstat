import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMmdb } from '../../test/mmdb.ts';
import { MmdbProvider } from '../pipeline/geo.ts';
import { type Fetcher, geoipInstalledAt, refreshGeoipDatabase } from './geoip-refresh.ts';

// ---------------------------------------------------------------------------

/** 2026-07-27 — the URL months are July and, on fallback, June. */
const NOW = Date.UTC(2026, 6, 27);
const CURRENT_URL = 'https://download.db-ip.com/free/dbip-city-lite-2026-07.mmdb.gz';
const PREVIOUS_URL = 'https://download.db-ip.com/free/dbip-city-lite-2026-06.mmdb.gz';

/** Serves the given body per URL; anything unlisted 404s, as DB-IP does. */
function stubFetch(bodies: Record<string, Buffer>): { fetch: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetcher = (url) => {
    urls.push(url);
    const body = bodies[url];
    return Promise.resolve(
      body === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(new Uint8Array(body)),
    );
  };
  return { fetch, urls };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geoip-'));
  path = join(dir, 'dbip-city-lite.mmdb');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function installed(): string[] {
  return readdirSync(dir);
}

describe('refreshGeoipDatabase', () => {
  it('installs the current month edition and leaves no temp file behind', async () => {
    const { fetch, urls } = stubFetch({ [CURRENT_URL]: gzipSync(buildMmdb('Boston')) });

    const result = await refreshGeoipDatabase({ path, fetch, now: () => NOW });

    expect(result).toEqual({ month: '2026-07', url: CURRENT_URL, bytes: expect.any(Number) });
    expect(urls).toEqual([CURRENT_URL]);
    expect(installed()).toEqual(['dbip-city-lite.mmdb']);
    expect(new MmdbProvider(path).lookup('8.8.8.8')).toMatchObject({
      country: 'US',
      city: 'Boston',
    });
  });

  it('falls back to the previous month while the current one is unpublished', async () => {
    const { fetch, urls } = stubFetch({ [PREVIOUS_URL]: gzipSync(buildMmdb('Cambridge')) });

    const result = await refreshGeoipDatabase({ path, fetch, now: () => Date.UTC(2026, 6, 1) });

    expect(result.month).toBe('2026-06');
    expect(urls).toEqual([CURRENT_URL, PREVIOUS_URL]);
    expect(new MmdbProvider(path).lookup('1.1.1.1')).toMatchObject({ city: 'Cambridge' });
  });

  it('steps back over a year boundary, from the 31st', async () => {
    const { fetch, urls } = stubFetch({});

    await expect(
      refreshGeoipDatabase({ path, fetch, now: () => Date.UTC(2026, 0, 31) }),
    ).rejects.toThrow(/no DB-IP City Lite edition available/);

    expect(urls).toEqual([
      'https://download.db-ip.com/free/dbip-city-lite-2026-01.mmdb.gz',
      'https://download.db-ip.com/free/dbip-city-lite-2025-12.mmdb.gz',
    ]);
  });

  it('rejects a download that is not gzip and keeps the installed database', async () => {
    writeFileSync(path, buildMmdb('Boston'));
    const { fetch } = stubFetch({ [CURRENT_URL]: Buffer.from('<html>error page</html>') });

    await expect(refreshGeoipDatabase({ path, fetch, now: () => NOW })).rejects.toThrow();

    expect(new MmdbProvider(path).lookup('8.8.8.8')).toMatchObject({ city: 'Boston' });
    expect(installed()).toEqual(['dbip-city-lite.mmdb']);
  });

  it('rejects a well-formed gzip that is not a database, without swapping', async () => {
    writeFileSync(path, buildMmdb('Boston'));
    const { fetch } = stubFetch({ [CURRENT_URL]: gzipSync(Buffer.alloc(4096, 0x7f)) });

    await expect(refreshGeoipDatabase({ path, fetch, now: () => NOW })).rejects.toThrow(
      /failed its sanity lookups/,
    );

    expect(new MmdbProvider(path).lookup('8.8.8.8')).toMatchObject({ city: 'Boston' });
    expect(installed()).toEqual(['dbip-city-lite.mmdb']);
  });

  it('rejects a truncated database, without swapping', async () => {
    const previous = buildMmdb('Boston');
    writeFileSync(path, previous);
    const { fetch } = stubFetch({
      [CURRENT_URL]: gzipSync(buildMmdb('Truncated').subarray(0, 20)),
    });

    await expect(refreshGeoipDatabase({ path, fetch, now: () => NOW })).rejects.toThrow();

    expect(readFileSync(path).equals(previous)).toBe(true);
  });

  it('keeps the installed database when every month 404s', async () => {
    const previous = buildMmdb('Boston');
    writeFileSync(path, previous);
    const { fetch, urls } = stubFetch({});

    await expect(refreshGeoipDatabase({ path, fetch, now: () => NOW })).rejects.toThrow(
      /no DB-IP City Lite edition available/,
    );

    expect(urls).toEqual([CURRENT_URL, PREVIOUS_URL]);
    expect(readFileSync(path).equals(previous)).toBe(true);
  });
});

describe('geoipInstalledAt', () => {
  it('reports the installed database mtime and undefined when there is none', async () => {
    expect(geoipInstalledAt(path)).toBeUndefined();
    const before = Date.now();
    await refreshGeoipDatabase({
      path,
      fetch: stubFetch({ [CURRENT_URL]: gzipSync(buildMmdb('Boston')) }).fetch,
      now: () => NOW,
    });
    expect(geoipInstalledAt(path)).toBeGreaterThanOrEqual(before - 1000);
  });
});
