import type { QueryRequest, QueryResponse } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { canonicalJson, createQueryClient, QueryError } from './api.ts';

const request: QueryRequest = {
  site: 4,
  range: { preset: '30d' },
  queries: [{ id: 'kpis', metrics: ['visitors', 'pageviews'] }],
};

const payload: QueryResponse = {
  results: { kpis: { rows: [{ visitors: 1841, pageviews: 3902 }] } },
  meta: { generatedInMs: 3.2, dataVersion: 91 },
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

  it('picks up the new body when the ETag moved on', async () => {
    const fresh: QueryResponse = { results: {}, meta: { generatedInMs: 1, dataVersion: 92 } };
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
