import {
  isQueryError,
  type QueryRequest,
  type QueryResponse,
  type SiteWindow,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { resultAxes } from '../widgets/axis.ts';
import { canonicalJson, createQueryClient, QueryError } from './api.ts';

const request: QueryRequest = {
  site: 4,
  range: { preset: '30d' },
  queries: [{ id: 'kpis', metrics: ['visitors', 'pageviews'] }],
};

const WINDOW: SiteWindow = {
  siteId: 4,
  timezone: 'America/New_York',
  from: '2026-06-30',
  to: '2026-07-29',
};

const payload: QueryResponse = {
  results: { kpis: { rows: [{ visitors: 1841, pageviews: 3902 }] } },
  meta: { generatedInMs: 3.2, dataVersion: 91, windows: [WINDOW] },
};

interface Call {
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(script: Array<() => Response>): {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    fetch: (_input, init) => {
      calls.push({
        headers: (init.headers ?? {}) as Record<string, string>,
        body: String(init.body),
      });
      const next = script[index];
      index += 1;
      if (next === undefined) throw new Error('fetch script exhausted');
      return Promise.resolve(next());
    },
  };
}

const ok =
  (etag: string, body: QueryResponse = payload) =>
  () =>
    new Response(JSON.stringify(body), { status: 200, headers: { ETag: etag } });
const notModified = () => () => new Response(null, { status: 304 });

describe('query client', () => {
  it('remembers the ETag and reuses the cached result on 304', async () => {
    const { fetch, calls } = fakeFetch([ok('"v1"'), notModified()]);
    const client = createQueryClient({ fetch });

    const first = await client.query(request);
    const second = await client.query(request);

    expect(first).toEqual(payload);
    expect(second).toEqual(payload);
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(calls[1]?.headers['if-none-match']).toBe('"v1"');
  });

  it('keys the cache on the canonical request, not on key order', async () => {
    const { fetch, calls } = fakeFetch([ok('"v1"'), notModified()]);
    const client = createQueryClient({ fetch });

    await client.query(request);
    await client.query({ queries: request.queries, range: request.range, site: request.site });

    expect(calls[1]?.headers['if-none-match']).toBe('"v1"');
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });

  it('revalidates a different view state on its own entry', async () => {
    const { fetch, calls } = fakeFetch([ok('"v1"'), ok('"v2"'), notModified()]);
    const client = createQueryClient({ fetch });

    await client.query(request);
    await client.query({ ...request, range: { preset: '7d' } });
    await client.query({ ...request, range: { preset: '7d' } });

    expect(calls[1]?.headers['if-none-match']).toBeUndefined();
    expect(calls[2]?.headers['if-none-match']).toBe('"v2"');
  });

  /**
   * The 304 path hands back a body that was generated minutes (or hours) ago.
   * `meta.windows` and `result.axis` are pure functions of the window the ETag
   * itself hashes, so they cannot have gone stale — and the one thing that CAN
   * have moved, the clock, is applied by the reader (widgets/axis.ts), so an
   * idle `today` chart still grows on a revalidation that executed no queries.
   */
  it('replays the window and axis on a 304, and the reader’s clock still extends it', async () => {
    const today: SiteWindow = {
      siteId: 4,
      timezone: 'UTC',
      from: '2026-07-29',
      to: '2026-07-29',
    };
    const hours = Array.from(
      { length: 24 },
      (_, h) => `2026-07-29 ${String(h).padStart(2, '0')}:00`,
    );
    const hourly: QueryResponse = {
      results: {
        series: {
          rows: [{ bucket: '2026-07-29 09:00', visitors: 3 }],
          bucket: 'hour',
          axis: [{ siteId: 4, keys: hours, clip: '2026-07-29 10:00' }],
        },
      },
      meta: { generatedInMs: 1, dataVersion: 91, windows: [today] },
    };
    const { fetch } = fakeFetch([ok('"h1"', hourly), notModified()]);
    const client = createQueryClient({ fetch });

    await client.query(request);
    const replayed = await client.query(request);
    expect(replayed.meta.windows).toEqual([today]);

    const result = replayed.results.series;
    if (result === undefined || isQueryError(result)) throw new Error('no series result');
    const lastKeyAt = (iso: string): string | undefined =>
      resultAxes(result, replayed.meta.windows, Date.parse(iso))[0]?.keys.at(-1);

    expect(lastKeyAt('2026-07-29T10:20:00Z')).toBe('2026-07-29 10:00');
    expect(lastKeyAt('2026-07-29T11:05:00Z')).toBe('2026-07-29 11:00');
  });

  it('picks up the new body when the ETag moved on', async () => {
    const fresh: QueryResponse = {
      results: {},
      meta: { generatedInMs: 1, dataVersion: 92, windows: [WINDOW] },
    };
    const { fetch, calls } = fakeFetch([ok('"v1"'), ok('"v2"', fresh), notModified()]);
    const client = createQueryClient({ fetch });

    await client.query(request);
    expect(await client.query(request)).toEqual(fresh);
    expect(await client.query(request)).toEqual(fresh);
    expect(calls[2]?.headers['if-none-match']).toBe('"v2"');
  });

  it('evicts the least recently used entry once the cache is full', async () => {
    const { fetch, calls } = fakeFetch([ok('"v1"'), ok('"v2"'), ok('"v3"')]);
    const client = createQueryClient({ fetch, cacheEntries: 1 });

    await client.query(request);
    await client.query({ ...request, range: { preset: '7d' } });
    await client.query(request);

    expect(calls[2]?.headers['if-none-match']).toBeUndefined();
  });

  it('treats an unsolicited 304 as an error rather than an empty dashboard', async () => {
    const { fetch } = fakeFetch([notModified()]);
    const client = createQueryClient({ fetch });

    await expect(client.query(request)).rejects.toBeInstanceOf(QueryError);
  });

  it('surfaces the server error message', async () => {
    const { fetch } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'unknown site id 9' }), { status: 404 }),
    ]);
    const client = createQueryClient({ fetch });

    await expect(client.query(request)).rejects.toThrow('unknown site id 9');
  });

  it('does not cache a response the server left untagged', async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response(JSON.stringify(payload), { status: 200 }),
      ok('"v1"'),
    ]);
    const client = createQueryClient({ fetch });

    await client.query(request);
    await client.query(request);

    expect(calls[1]?.headers['if-none-match']).toBeUndefined();
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }, 3] })).toBe('{"a":[{"x":1,"y":2},3],"b":1}');
  });

  it('drops undefined members, matching the server canonicalization', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
