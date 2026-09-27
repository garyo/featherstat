import { createHash, randomBytes } from 'node:crypto';
import {
  collectBatch,
  type Dashboard,
  hourlyWhenIntraday,
  type QueryRequest,
  type QueryResponse,
  RangeSchema,
  readStoredDashboard,
  type SiteWindow,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  type Db,
  dataVersion,
  getDashboard,
  getShareToken,
  insertShareToken,
  revokeShareTokens,
  schemaVersion,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest, resolveSiteWindows, UnknownSiteError } from '../query/executor.ts';
import { expandSegments, resolveDerived } from '../query/stored.ts';
import { parseDashboardId, siteOf, writableBy } from './dashboards.ts';
import { batchEtag, canonicalize, ifNoneMatchHits } from './etag.ts';
import { clientIp } from './track.ts';

/**
 * Share links (docs/02 § Security posture, docs/04 § 5): mint/revoke live under
 * the admin session; `GET /share/:token` is public and read-only. The raw token
 * is returned exactly once at mint time — only its sha256 is stored, so the DB
 * never holds anything presentable.
 *
 * The public route answers ONLY the stored dashboard's own query batch,
 * assembled server-side from the validated layout. It accepts no client-supplied
 * QueryRequest — that would turn a read-only link into the whole query API. The
 * one client knob is `?range=<preset>`, a whitelisted enum feeding the
 * server-built request (query vocabulary, never anything freer).
 */

const TOKEN_BYTES = 32;
/** base64url of TOKEN_BYTES random bytes — anything else can't be ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_SHARE_RANGE = '30d';

/**
 * The one public route that executes a query batch — and better-sqlite3 is
 * synchronous, so each execution briefly owns the event loop that also answers
 * ingest (CLAUDE.md invariant 4). These budgets cap what a link holder can make
 * the server compute: enough for a roomful of people opening a link at once,
 * nowhere near enough to keep the loop saturated. 304 revalidations are free —
 * only executed batches are counted.
 */
const SHARE_BATCHES_PER_IP = 30;
const SHARE_BATCHES_GLOBAL = 240;
const SHARE_WINDOW_MS = 60_000;

/** `GET /share/:token` body: the dashboard JSON plus its batch, one response. */
export interface ShareView {
  dashboard: Dashboard;
  results: QueryResponse['results'];
  meta: QueryResponse['meta'];
}

export function createShareRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const ipBatches = new RateLimiter(SHARE_BATCHES_PER_IP, SHARE_WINDOW_MS);
  const globalBatches = new RateLimiter(SHARE_BATCHES_GLOBAL, SHARE_WINDOW_MS);

  // Public pages behind a secret URL: a crawler that ever sees one must not
  // index the data it unlocks.
  app.use('/share/*', async (c, next) => {
    await next();
    c.res.headers.set('X-Robots-Tag', 'noindex');
  });

  // Mint responses carry the raw token — never cacheable.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  app.post('/api/admin/dashboards/:id/share', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined || !writableBy(c.get('principal'), siteOf(row))) {
      return c.json({ error: `unknown dashboard ${id}` }, 404);
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    withWriteTransaction(db, () =>
      insertShareToken(db, { token_hash: sha256(token), dashboard_id: id, created_at: auth.now() }),
    );
    return c.json({ token }, 201);
  });

  app.delete('/api/admin/dashboards/:id/share', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined || !writableBy(c.get('principal'), siteOf(row))) {
      return c.json({ error: `unknown dashboard ${id}` }, 404);
    }
    const revoked = withWriteTransaction(db, () => revokeShareTokens(db, id, auth.now()));
    return c.json({ revoked });
  });

  app.get('/share/:token', (c) => {
    const raw = c.req.param('token');
    // Unknown, revoked and malformed all answer identically — a probe learns nothing.
    if (!TOKEN_SHAPE.test(raw)) return unknownLink(c);
    const token = getShareToken(db, sha256(raw));
    if (token === undefined || token.revoked_at !== null) return unknownLink(c);
    const dashboard = getDashboard(db, token.dashboard_id);
    if (dashboard === undefined) return unknownLink(c);

    const range = RangeSchema.safeParse({ preset: c.req.query('range') ?? DEFAULT_SHARE_RANGE });
    if (!range.success || !('preset' in range.data)) {
      return c.json({ error: 'range must be a preset (7d, 30d, …)' }, 400);
    }

    // Re-validate the stored JSON column and carry it to the current vocabulary
    // (CLAUDE.md: zod at every boundary, JSON columns included). The write path
    // validated it, but this endpoint is public and executes what it reads — a
    // migration, rollback or manual edit must degrade to an error here, never
    // reach the compiler unchecked. The upgrade stays in memory: a read-only
    // link does not write, least of all on the one public route that executes.
    const layout = readStoredDashboard(dashboard.layout);
    if (layout === undefined) {
      console.error(`share: stored dashboard ${dashboard.id} has an invalid layout`);
      return c.json(
        { error: 'this dashboard is misconfigured — ask its owner to re-save it' },
        500,
      );
    }

    // The SAME batch the in-app view would run (packages/shared): widget queries
    // plus their derived companions (sparklines, browsers, per-site pages), the
    // same previous-period compare, the same hourly rewrite for the intraday presets.
    const assembled: QueryRequest = {
      site: layout.site,
      range: range.data,
      compare: 'previous',
      queries: hourlyWhenIntraday(collectBatch(layout).queries, range.data.preset),
    };

    // A stored widget's filters may name saved segments; they expand here for
    // the same reasons as /api/query — the worker-facing request carries no
    // refs, and the ETag hashes the expanded trees plus any derived-metric
    // definitions, so editing either expires the link's caches. A ref to a
    // segment that no longer exists degrades like any other broken layout.
    const expansion = expandSegments(db, assembled);
    if (!expansion.ok) {
      console.error(`share: dashboard ${dashboard.id}: ${expansion.message}`);
      return c.json(
        { error: 'this dashboard is misconfigured — ask its owner to re-save it' },
        500,
      );
    }
    const request = expansion.request;
    const derived = resolveDerived(db, request);

    const now = Date.now();
    let windows: SiteWindow[];
    try {
      windows = resolveSiteWindows(db, request.site, request.range, now);
    } catch (error) {
      if (error instanceof UnknownSiteError) return unknownLink(c);
      throw error;
    }

    // ETag exactly like /api/query, with the dashboard's identity and edit time
    // folded in — a layout change must expire caches even when data didn't move.
    const canonical = canonicalize({
      id: dashboard.id,
      updatedAt: dashboard.updated_at,
      request,
      derived,
    });
    const schema = schemaVersion(db);
    const current = batchEtag(dataVersion(db), schema, canonical, windows, now);
    if (ifNoneMatchHits(c.req.header('if-none-match'), current)) {
      return c.body(null, 304, cacheHeaders(current));
    }

    if (!ipBatches.allow(clientIp(c), auth.now()) || !globalBatches.allow('*', auth.now())) {
      return c.json({ error: 'too many requests — try again in a minute' }, 429, {
        'Retry-After': '60',
      });
    }

    const response = executeQueryRequest(db, request, { now, derived });
    const tag = batchEtag(response.meta.dataVersion, schema, canonical, windows, now);
    const body: ShareView = {
      dashboard: layout,
      results: response.results,
      // dataVersion is a global write counter across ALL sites — inside the
      // hashed ETag it revalidates caches, but it must not ride readable in a
      // public body where it meters other sites' write volume. The windows do
      // ride along: without them a share page could only guess at the range it
      // is showing, which is exactly how it came to render different window
      // semantics from the in-app dashboard.
      meta: {
        generatedInMs: response.meta.generatedInMs,
        dataVersion: 0,
        windows: response.meta.windows,
      },
    };
    return c.json(body, 200, cacheHeaders(tag));
  });

  // Read-only means read-only: no verb on a share URL accepts a body.
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/share/:token', (c) =>
    c.json({ error: 'share links are read-only' }, 405, { Allow: 'GET, HEAD' }),
  );

  return app;
}

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function unknownLink(c: Context): Response {
  return c.json({ error: 'unknown share link' }, 404);
}

/** The token rides in the URL: shared caches must never store what it unlocks. */
function cacheHeaders(tag: string): Record<string, string> {
  return { ETag: tag, 'Cache-Control': 'private, no-cache' };
}
