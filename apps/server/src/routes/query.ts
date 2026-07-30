import { createHash } from 'node:crypto';
import { QueryRequestSchema, type SiteWindow } from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthVariables } from '../auth/auth.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import { type Db, dataVersion, schemaVersion } from '../db/index.ts';
import { executeQueryRequest, resolveSiteWindows, UnknownSiteError } from '../query/executor.ts';
import { clientIp } from './track.ts';

/**
 * POST /api/query — the batched query endpoint (docs/04 § 3). This is not a
 * beacon: invalid bodies get a 400 with the zod issues. The ETag is a strong
 * hash of (data version, schema version, canonicalized request, resolved
 * per-site windows), so an unchanged dashboard revalidates with a 304 and zero
 * query work — and a preset like `today` still expires at site-local midnight,
 * when its window moves even though no data did.
 */
/** 32 queries × 16 filters of 2 KB values still fit comfortably — beyond this is abuse. */
const MAX_QUERY_BODY_BYTES = 1024 * 1024;

/**
 * What a batch is allowed to cost, and how often (docs/04 § 3 "Rate limit").
 *
 * A stored dashboard is a client-authored query plan executed server-side, and
 * better-sqlite3 is synchronous: while a batch runs it owns the event loop that
 * also answers beacons, which must stay fast (invariant 4). The response-size
 * budget bounds one answer; these bound how many of them anyone can ask for.
 *
 * Sized against the cadence the client actually produces, not against a guess.
 * The only automatic source of batches is `createRevalidator`, debounced to one
 * per REVALIDATE_DEBOUNCE_MS (3 s) per open view — 20/min, and on a live
 * instance every one of them executes, because the ETag hashes a data version
 * that moves with each flush. So the per-session budget is six such views
 * saturated for a full minute, which no reader produces and a runaway `$effect`
 * reaches instantly. The global budget is five such sessions at once; at the
 * docs/02 p95 batch budget of 50 ms that is half the event loop, which is the
 * point past which protecting ingest matters more than answering a dashboard.
 * `test/contract/rate-limit.test.ts` holds these against the client's cadence.
 */
export const QUERY_BATCHES_PER_SESSION = 120;
export const QUERY_BATCHES_GLOBAL = 600;
export const QUERY_WINDOW_MS = 60_000;
/** The one key the whole-instance budget accrues under. */
const GLOBAL_KEY = '*';

/** Mounted behind the session gate in the ops shell, bare in a tracking-only app. */
type QueryEnv = { Variables: Partial<AuthVariables> };

export function createQueryRoutes(db: Db): Hono<QueryEnv> {
  const app = new Hono<QueryEnv>();
  const sessionBatches = new RateLimiter(QUERY_BATCHES_PER_SESSION, QUERY_WINDOW_MS);
  const globalBatches = new RateLimiter(QUERY_BATCHES_GLOBAL, QUERY_WINDOW_MS);

  app.post('/api/query', bodyLimit({ maxSize: MAX_QUERY_BODY_BYTES }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = QueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid query request', issues: parsed.error.issues }, 400);
    }

    const now = Date.now();
    let windows: SiteWindow[];
    try {
      windows = resolveSiteWindows(db, parsed.data.site, parsed.data.range, now);
    } catch (error) {
      if (error instanceof UnknownSiteError) return c.json({ error: error.message }, 404);
      throw error;
    }

    const canonicalBody = canonicalize(parsed.data);
    const schema = schemaVersion(db);
    const current = etag(dataVersion(db), schema, canonicalBody, windows);
    if (anyMatch(c.req.header('if-none-match'), current)) {
      return c.body(null, 304, { ETag: current });
    }

    // Below the 304: a revalidation that answers from the ETag costs a hash and
    // is never charged. Only batches the server is about to execute are — and
    // they are charged BEFORE the work, so a query that throws still counts.
    const key = principal(c);
    if (sessionBatches.exhausted(key, now) || globalBatches.exhausted(GLOBAL_KEY, now)) {
      // The SPA holds its last good response and says so rather than blanking
      // (views/batch.ts), so this degrades to a stale dashboard plus a retry.
      return c.json({ error: 'too many query batches — try again in a minute' }, 429, {
        'Retry-After': String(QUERY_WINDOW_MS / 1000),
      });
    }
    sessionBatches.charge(key, now);
    globalBatches.charge(GLOBAL_KEY, now);

    const response = executeQueryRequest(db, parsed.data, { now });
    // Re-derived from the executed snapshot's version, in case a flush landed in between.
    const tag = etag(response.meta.dataVersion, schema, canonicalBody, windows);
    return c.json(response, 200, { ETag: tag });
  });
  return app;
}

/**
 * Who is metered. `/api/query` sits behind the session gate, so every request
 * that reaches it in production names a principal the server minted itself —
 * a better key than the address it arrived from, in both directions: a roaming
 * phone or a cookie replayed from a botnet keeps ONE budget however many
 * addresses it uses, and an office (or a Tailscale exit node) behind a single
 * NAT does not throttle itself. That is the difference from `/share/:token` and
 * `/api/admin/login`, which are unauthenticated and therefore keyed on the IP
 * because nothing better exists there — and are held to a tighter budget for
 * exactly that reason. The IP is only the fallback for a tracking-only app
 * mounted without the ops shell, where there is no session to name.
 *
 * Session ids are 64 hex chars and an address never is, so the two key spaces
 * cannot collide.
 */
function principal(c: Context<QueryEnv>): string {
  return c.get('sessionId') ?? clientIp(c);
}

function anyMatch(ifNoneMatch: string | undefined, current: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((candidate) => candidate.trim() === current);
}

function etag(
  version: number,
  schema: number,
  canonicalBody: string,
  windows: readonly SiteWindow[],
): string {
  const resolved = windows.map((w) => `${w.siteId}:${w.timezone}:${w.from}:${w.to}`).join(',');
  const hash = createHash('sha256')
    .update(`${version}|${schema}|${canonicalBody}|${resolved}`)
    .digest('base64url');
  return `"${hash}"`;
}

/** JSON with object keys sorted, so key order alone can never produce a distinct ETag. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}
