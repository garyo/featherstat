import {
  type AnnotationInfo,
  isQueryError,
  localClock,
  type Query,
  type QueryRequest,
  QueryRequestSchema,
  type QueryResponse,
  resultToCsv,
  type SiteWindow,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthVariables } from '../auth/auth.ts';
import { readableSites } from '../auth/principal.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  annotationsVersion,
  type Db,
  dataVersion,
  listAnnotations,
  listSites,
  schemaVersion,
} from '../db/index.ts';
import { executeQueryRequest, resolveSiteWindows, UnknownSiteError } from '../query/executor.ts';
import type { GoalDefinitions } from '../query/goals.ts';
import { PoolSaturatedError } from '../query/pool/pool.ts';
import { expandSegments, resolveDerived, resolveGoals } from '../query/stored.ts';
import { batchEtag, canonicalize, ifNoneMatchHits } from './etag.ts';
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
/**
 * The token rate class (docs/04 § 5). An API token is a script, not a reader:
 * extraction wants a few big answers, never a 3-second revalidation loop, so
 * its budget is a quarter of a session's — enough for one batch every two
 * seconds sustained, far beyond any honest export. Tokens share the global
 * bucket above: however a caller authenticates, the instance-wide ceiling on
 * synchronous query work is one number.
 */
export const TOKEN_BATCHES_PER_MIN = 30;
/** The one key the whole-instance budget accrues under. */
const GLOBAL_KEY = '*';

/** Mounted behind the session gate in the ops shell, bare in a tracking-only app. */
type QueryEnv = { Variables: Partial<AuthVariables> };

/** How a batch runs: inline on this thread by default, on the read pool in main.ts. */
export type ExecuteQuery = (
  request: QueryRequest,
  now: number,
  allowedSites?: readonly number[],
  derived?: Readonly<Record<string, string>>,
  goals?: GoalDefinitions,
) => QueryResponse | Promise<QueryResponse>;

/**
 * The three query budgets as one sharable object: `/api/query` and `/mcp` are
 * two surfaces over the same synchronous read path, so a token keeps ONE
 * budget across both — separate limiter instances would double every ceiling.
 */
export interface QueryRateLimits {
  session: RateLimiter;
  token: RateLimiter;
  global: RateLimiter;
}

export function createQueryRateLimits(): QueryRateLimits {
  return {
    session: new RateLimiter(QUERY_BATCHES_PER_SESSION, QUERY_WINDOW_MS),
    token: new RateLimiter(TOKEN_BATCHES_PER_MIN, QUERY_WINDOW_MS),
    global: new RateLimiter(QUERY_BATCHES_GLOBAL, QUERY_WINDOW_MS),
  };
}

export interface QueryRouteOptions {
  execute?: ExecuteQuery;
  /** Shared with the MCP routes by the ops shell; defaults to a private set. */
  limits?: QueryRateLimits;
}

export function createQueryRoutes(db: Db, options: QueryRouteOptions = {}): Hono<QueryEnv> {
  const execute: ExecuteQuery =
    options.execute ??
    ((request, now, allowedSites, derived, goals) =>
      executeQueryRequest(db, request, { now, allowedSites, derived, goals }));
  const app = new Hono<QueryEnv>();
  const {
    session: sessionBatches,
    token: tokenBatches,
    global: globalBatches,
  } = options.limits ?? createQueryRateLimits();

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

    // Stored query-layer objects resolve BEFORE the ETag is derived, so the
    // canonical body below hashes the EXPANDED request plus the derived-metric
    // definitions — editing a segment or a derived metric expires every cached
    // answer with zero bookkeeping (query/stored.ts). Segments are named by the
    // same operator's UI, so an unknown or unreadable one is a 400, not a skip.
    const expansion = expandSegments(db, parsed.data);
    if (!expansion.ok) return c.json({ error: expansion.message }, 400);
    const request = expansion.request;
    const derived = resolveDerived(db, request);
    const goals = resolveGoals(db, request);

    // CSV negotiation (docs/04 § 3): one query per CSV, resolved before the
    // ETag so an unanswerable selection 400s without charging or executing.
    const csvQuery = csvQueryOf(c, request);
    if (csvQuery !== undefined && 'badRequest' in csvQuery) {
      return c.json({ error: csvQuery.badRequest }, 400);
    }

    const now = Date.now();
    // The one scoping chokepoint (docs/04 § 5): a non-admin principal's
    // readable set bounds both the resolved windows (and so the ETag) and the
    // execution itself; out-of-scope answers exactly like nonexistent.
    const who = c.get('principal');
    const allowedSites =
      who === undefined || who.kind === 'admin'
        ? undefined
        : readableSites(
            who,
            listSites(db).map((site) => site.id),
          );
    let windows: SiteWindow[];
    try {
      windows = resolveSiteWindows(db, request.site, request.range, now, allowedSites);
    } catch (error) {
      if (error instanceof UnknownSiteError) return c.json({ error: error.message }, 404);
      throw error;
    }

    // The format (and the selected query) is part of what the tag covers: a
    // CSV body and a JSON body answer the same question differently, and a 304
    // minted against one must never validate a cache holding the other.
    // `annotations_version` joins the hash ONLY for annotation-opted requests
    // (the flag itself is in `request`): an annotation edit must expire the
    // dashboards that show notes, not every cached batch on the instance.
    const canonicalBody = canonicalize({
      request,
      compareFilter: expansion.compareFilter,
      derived,
      goals,
      format: csvQuery === undefined ? undefined : `csv:${csvQuery.id}`,
      annotationsVersion: request.annotations === true ? annotationsVersion(db) : undefined,
    });
    const schema = schemaVersion(db);
    const current = batchEtag(dataVersion(db), schema, canonicalBody, windows, now);
    if (ifNoneMatchHits(c.req.header('if-none-match'), current)) {
      return c.body(null, 304, { ETag: current });
    }

    // Below the 304: a revalidation that answers from the ETag costs a hash and
    // is never charged. Only batches the server is about to execute are — and
    // they are charged BEFORE the work, so a query that throws still counts.
    const key = principal(c);
    // Token principals meter in their own class (docs/04 § 5); everyone shares
    // the global bucket, so the instance-wide ceiling stays one number.
    const callerBatches = c.get('principal')?.kind === 'token' ? tokenBatches : sessionBatches;
    if (callerBatches.exhausted(key, now) || globalBatches.exhausted(GLOBAL_KEY, now)) {
      // The SPA holds its last good response and says so rather than blanking
      // (views/batch.ts), so this degrades to a stale dashboard plus a retry.
      return c.json({ error: 'too many query batches — try again in a minute' }, 429, {
        'Retry-After': String(QUERY_WINDOW_MS / 1000),
      });
    }
    callerBatches.charge(key, now);
    globalBatches.charge(GLOBAL_KEY, now);

    let response: QueryResponse;
    try {
      response = await execute(request, now, allowedSites, derived, goals);
    } catch (error) {
      // A full pool is load, not failure — same degraded path as the limiter.
      if (error instanceof PoolSaturatedError) {
        return c.json({ error: 'too many query batches — try again in a minute' }, 429, {
          'Retry-After': String(QUERY_WINDOW_MS / 1000),
        });
      }
      throw error;
    }
    // Annotations attach HERE, on the main thread: `executeQueryRequest` may
    // have run on the worker pool, whose protocol carries pure query work, and
    // an annotation is a cheap read the route can make itself. The share route
    // never sets the flag — share links stay minimal (docs/04 § 3).
    if (request.annotations === true) {
      response.meta.annotations = annotationsFor(db, windows);
    }
    // Re-derived from the executed snapshot's version, in case a flush landed in between.
    const tag = batchEtag(response.meta.dataVersion, schema, canonicalBody, windows, now);
    if (csvQuery !== undefined) {
      const entry = response.results[csvQuery.id];
      if (entry === undefined || isQueryError(entry)) {
        // An honest per-query refusal has no rows to serialize; in a JSON batch
        // it rides beside its siblings, but it IS this whole response.
        return c.json(
          { error: entry?.error.message ?? `no result for query '${csvQuery.id}'` },
          400,
        );
      }
      const headers: Record<string, string> = {
        ETag: tag,
        'Content-Type': 'text/csv; charset=utf-8',
      };
      const first = windows[0];
      if (first !== undefined) headers['X-Featherstat-Window'] = `${first.from}/${first.to}`;
      return c.body(resultToCsv(csvQuery, entry), 200, headers);
    }
    return c.json(response, 200, { ETag: tag });
  });
  return app;
}

/**
 * Which query a CSV response serializes (docs/04 § 3): `?format=csv` or an
 * `Accept: text/csv` asks for one, `?query=<id>` picks it from a batch, and a
 * single-query batch needs no picking. `undefined` = the response is JSON.
 */
function csvQueryOf(
  c: Context<QueryEnv>,
  request: QueryRequest,
): Query | { badRequest: string } | undefined {
  const wantsCsv =
    c.req.query('format') === 'csv' || (c.req.header('accept') ?? '').includes('text/csv');
  if (!wantsCsv) return undefined;
  const selected = c.req.query('query');
  if (selected !== undefined) {
    const query = request.queries.find((candidate) => candidate.id === selected);
    return query ?? { badRequest: `csv: no query '${selected}' in this batch` };
  }
  const only = request.queries[0];
  if (request.queries.length === 1 && only !== undefined) return only;
  return { badRequest: 'csv needs exactly one query — pass ?query=<id>' };
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
  const who = c.get('principal');
  if (who?.kind === 'token') return `token:${who.tokenId}`;
  return c.get('sessionId') ?? clientIp(c);
}

/**
 * The stored notes this request's resolved windows cover (docs/04 § 3): a note
 * matches a window when its site matches (a null-site note matches every site)
 * and its instant falls inside it — by the window's own instants for a rolling
 * window, otherwise by the note's site-local date, the same calendar the
 * window's bounds are stated in.
 */
function annotationsFor(db: Db, windows: readonly SiteWindow[]): AnnotationInfo[] {
  return listAnnotations(db)
    .filter((row) =>
      windows.some((window) => {
        if (row.site_id !== null && row.site_id !== window.siteId) return false;
        if (window.fromTs !== undefined && window.toTs !== undefined) {
          return row.ts >= window.fromTs && row.ts < window.toTs;
        }
        const date = localClock(window.timezone, row.ts).date;
        return date >= window.from && date <= window.to;
      }),
    )
    .map((row) => ({ id: row.id, siteId: row.site_id, ts: row.ts, text: row.text }));
}
