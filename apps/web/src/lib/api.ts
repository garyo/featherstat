import type { QueryRequest, QueryResponse } from '@analytics/shared';

/**
 * The client half of the one-fetch rule (docs/05): a view hands over the whole
 * batch its widgets declared and gets one response back.
 *
 * The request is canonicalized (object keys sorted) before it is sent, so it is
 * both the wire body and the cache key — the same view state always produces the
 * same bytes, which is exactly what the server's ETag hashes. A remembered ETag
 * goes out as `If-None-Match`; a 304 then costs one round trip and zero query
 * work on either side, which is what makes SSE-driven revalidation cheap.
 */

const DEFAULT_ENDPOINT = '/api/query';
/** Bounded: a session that wanders across ranges and filters must not grow a cache forever. */
const DEFAULT_CACHE_ENTRIES = 32;

/** The slice of `fetch` this client uses — tests supply their own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface QueryClientOptions {
  endpoint?: string;
  fetch?: FetchLike;
  /** Distinct request bodies whose ETag + result stay revalidatable (LRU). */
  cacheEntries?: number;
}

export interface QueryOptions {
  signal?: AbortSignal;
}

export interface QueryClient {
  query(request: QueryRequest, options?: QueryOptions): Promise<QueryResponse>;
}

/** A batch the server refused (400 unknown vocabulary, 404 unknown site, 5xx). */
export class QueryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

interface CacheEntry {
  etag: string;
  response: QueryResponse;
}

export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
  // Insertion-ordered, so the oldest key is the first one — a Map is the whole LRU.
  const cache = new Map<string, CacheEntry>();

  return {
    async query(request, { signal } = {}) {
      const body = canonicalJson(request);
      const cached = cache.get(body);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cached !== undefined) headers['if-none-match'] = cached.etag;

      const response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal });

      if (response.status === 304) {
        if (cached === undefined) {
          throw new QueryError(304, 'not modified, but this client holds no cached result');
        }
        cache.delete(body);
        cache.set(body, cached); // most recently used
        return cached.response;
      }
      if (!response.ok) throw new QueryError(response.status, await errorMessage(response));

      // Our own server's shape; `packages/shared` types it and the batch envelope
      // carries per-query errors, so a malformed body would be a server bug.
      const payload = (await response.json()) as QueryResponse;
      const etag = response.headers.get('etag');
      if (etag !== null) remember(cache, body, { etag, response: payload }, cacheEntries);
      return payload;
    },
  };
}

function remember(
  cache: Map<string, CacheEntry>,
  key: string,
  entry: CacheEntry,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, entry);
  for (const oldest of cache.keys()) {
    if (cache.size <= limit) break;
    cache.delete(oldest);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON — fall through to the status line
  }
  return `query failed: ${response.status} ${response.statusText}`.trimEnd();
}

/**
 * JSON with object keys sorted — the mirror of the server's canonicalization
 * (apps/server/src/routes/query.ts), so key order alone never splits a cache
 * entry or an ETag.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}
