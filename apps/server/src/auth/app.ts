import { Hono, type MiddlewareHandler } from 'hono';
import { observeWriteTransactions } from '../db/index.ts';
import { type AppOptions, createApp } from '../index.ts';
import {
  createNtfyIntegration,
  type NtfyNotifier,
  type NtfyNotifierOptions,
} from '../notify/index.ts';
import type { Pipeline } from '../pipeline/index.ts';
import { createAdminRoutes } from '../routes/admin.ts';
import { createAlertRoutes } from '../routes/alerts.ts';
import { createAnnotationRoutes } from '../routes/annotations.ts';
import { createCampaignRoutes } from '../routes/campaigns.ts';
import { createDashboardRoutes } from '../routes/dashboards.ts';
import { createDerivedMetricRoutes } from '../routes/derived.ts';
import { createGoalRoutes } from '../routes/goals.ts';
import { createMcpRoutes } from '../routes/mcp.ts';
import { createMetricsRoutes, Metrics } from '../routes/metrics.ts';
import { createQueryRateLimits } from '../routes/query.ts';
import { createSegmentRoutes } from '../routes/segments.ts';
import { createShareRoutes } from '../routes/share.ts';
import { createSpaRoutes } from '../routes/spa.ts';
import { createUserRoutes } from '../routes/users.ts';
import { createViewerRoutes } from '../routes/viewers.ts';
import { type Auth, type AuthEnv, type AuthOptions, createAuth } from './auth.ts';
import { isManagerRoute } from './routes-policy.ts';

/**
 * `createApp` wrapped in the ops shell (docs/02 § Security posture, docs/01
 * R15): the session gate in front of every dashboard read, admin routes,
 * `/metrics`, and — when `webDir` points at `apps/web/dist` — the SPA itself.
 *
 * Production entry point: `main.ts` swaps `createApp` for this. Tracking
 * endpoints, tracker bundles and `/healthz` stay public (invariant 4).
 */

/**
 * The whole API surface is gated BY PREFIX (docs/02: "Dashboard + admin API:
 * session auth") with an explicit public allowlist — a route added tomorrow is
 * born authenticated instead of silently open. The auth lifecycle must be
 * reachable without a session; everything else under `/api/` needs one.
 */
// `/api/collect` is the native tracking endpoint (docs/04 § 2): beacons never
// bounce (invariant 4), so it is public despite living under the gated prefix.
const PUBLIC_API_PATHS = new Set([
  '/api/admin/me',
  '/api/admin/setup',
  '/api/admin/login',
  '/api/collect',
]);

/**
 * The data-out surface third-party callers may reach cross-origin with a
 * Bearer token (docs/04 § 5): the query API and the site directory it needs to
 * name sites. Exactly these — CORS on a cookie-authenticated response would
 * tear down the same-origin wall that protects sessions, so cookie responses
 * get NO CORS headers and every other route stays same-origin entirely.
 * (The CSP's `connect-src 'self'` is response-side — it governs what OUR pages
 * may fetch, and says nothing to a third-party caller. This allowlist does.)
 */
// `/mcp` rides along: MCP clients authenticate with the same Bearer tokens and
// may be browser-based, so it gets exactly the on-Bearer CORS treatment.
const CORS_API_PATHS = new Set(['/api/query', '/api/sites', '/mcp']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/**
 * Registered BEFORE the session gate, which knows nothing of OPTIONS: a
 * preflight carries no credentials and grants nothing — it only asks whether a
 * real request may be attempted — so it is answered here, unauthenticated,
 * where the gate would otherwise 401 it and break every cross-origin caller.
 * The real request is then gated as ever; its response carries CORS headers
 * exactly when it presented an Authorization header, which the gate answers as
 * Bearer or 401s — never silently as the cookie — so a browser session's
 * response is never the one being exposed.
 */
const corsOnBearer: MiddlewareHandler = async (c, next) => {
  if (!CORS_API_PATHS.has(c.req.path)) return next();
  if (c.req.method === 'OPTIONS') return c.body(null, 204, CORS_HEADERS);
  await next();
  if (c.req.header('authorization') !== undefined) {
    for (const [name, value] of Object.entries(CORS_HEADERS)) c.res.headers.set(name, value);
  }
};

/** Small, static response headers — the backstop for the render discipline docs/02 relies on. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  /**
   * A private admin surface has no business in an index — and a crawlable,
   * unexplained password form is exactly the shape Google's deceptive-page
   * classifier flags (it flagged this deployment's validation hostname in
   * July 2026). Tracking endpoints carry it harmlessly: nothing here is meant
   * to be found by search.
   */
  'X-Robots-Tag': 'noindex, nofollow',
};

export interface SecuredAppOptions extends AppOptions {
  auth?: AuthOptions;
  /** Feeds the ingest counters on `/metrics`. */
  pipeline?: Pipeline;
  /** Defaults to env METRICS_TOKEN; absent, `/metrics` is a 404. */
  metricsToken?: string;
  /** Built SPA directory; defaults to env WEB_DIR; absent, no SPA is served. */
  webDir?: string;
  /** Notifier knobs (clock, fetch, cooldown); the feature itself is turned on by its settings rows. */
  ntfy?: NtfyNotifierOptions;
  /** Re-resolves hostname exclusion rules after an admin write; main.ts owns the timer. */
  refreshExclusions?: () => Promise<void>;
}

export interface SecuredApp {
  app: Hono<AuthEnv>;
  /** Undefined on a tracking-only server (no db — nothing gated is mounted). */
  auth: Auth | undefined;
  metrics: Metrics;
  /** Undefined on a tracking-only server; idle until `/api/admin/ntfy` is configured. */
  ntfy: NtfyNotifier | undefined;
}

export function createSecuredApp(options: SecuredAppOptions = {}): SecuredApp {
  const {
    auth: authOptions,
    pipeline,
    metricsToken = process.env.METRICS_TOKEN,
    webDir = process.env.WEB_DIR,
    ntfy: ntfyOptions,
    ...appOptions
  } = options;
  // The bundled server (Docker) points these at its own directories via env.
  appOptions.assetsDir ??= process.env.ASSETS_DIR;

  const metrics = new Metrics();
  pipeline?.onFlush((summary) => metrics.recordFlush(summary));

  // The gate lives on `db` (sessions are rows); mounting gated surfaces without
  // it would type-check and serve them open — refuse instead of trusting luck.
  if (appOptions.db === undefined && appOptions.hub !== undefined) {
    throw new Error('realtime requires db: the session gate that protects it lives there');
  }

  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  });
  let auth: Auth | undefined;
  let ntfy: NtfyNotifier | undefined;

  if (appOptions.db !== undefined) {
    const db = appOptions.db;
    observeWriteTransactions(db, (ms) => metrics.flush.observe(ms));
    const createdAuth = createAuth(db, authOptions);
    auth = createdAuth;
    // One set of query budgets for BOTH executing surfaces (/api/query, /mcp):
    // a token keeps a single budget however it asks.
    const queryLimits = createQueryRateLimits();
    appOptions.queryLimits = queryLimits;
    appOptions.refreshPrincipal = createdAuth.refresh;
    app.use('/api/*', corsOnBearer);
    app.use('/mcp', corsOnBearer);
    app.use('/api/*', (c, next) =>
      PUBLIC_API_PATHS.has(c.req.path) ? next() : createdAuth.gate(c, next),
    );
    // The whole admin surface is the write surface: one wall, before any
    // router — a viewer or token principal reads dashboards and data, never
    // this. The lifecycle paths above stay reachable for login itself. The
    // wall dispatches on the routes-policy classification: an explicit list
    // of manager routes opens to users (whose handlers then scope per object,
    // canManageSite), and everything else defaults to admin-only.
    app.use('/api/admin/*', (c, next) => {
      if (PUBLIC_API_PATHS.has(c.req.path)) return next();
      const wall = isManagerRoute(c.req.method, c.req.path)
        ? createdAuth.requireManager
        : createdAuth.requireAdmin;
      return wall(c, next);
    });
    app.use('/api/query', timed(metrics));
    app.use('/api/realtime', sseGauge(metrics));
    // Order matters: these routers gate `/api/admin/*` wholesale, so they mount
    // AFTER the admin router — its public lifecycle handlers (`me`, `setup`,
    // `login`) are then reached first and end the chain before those gates run.
    app.route(
      '/',
      createAdminRoutes(db, createdAuth, {
        propRegistry: pipeline?.props,
        campaignAliases: pipeline?.campaignAliases,
        exclusions: pipeline?.exclusions,
        refreshExclusions: options.refreshExclusions,
      }),
    );
    app.route('/', createDashboardRoutes(db, createdAuth));
    // Query-layer objects (docs/04 § 3): reads for any gated principal, writes
    // under the admin wall above.
    app.route('/', createSegmentRoutes(db, createdAuth));
    app.route('/', createDerivedMetricRoutes(db, createdAuth));
    app.route('/', createGoalRoutes(db, createdAuth));
    app.route(
      '/',
      createCampaignRoutes(db, createdAuth, { aliasCache: pipeline?.campaignAliases }),
    );
    // Annotations (docs/04 § 3, § 5) and alert rules (docs/04 § 5): admin-only
    // writes under the wall above; annotations reach readers opt-in on the
    // query batch, alerts reach them through ntfy.
    app.route('/', createAnnotationRoutes(db, createdAuth));
    app.route('/', createAlertRoutes(db, createdAuth));
    // Minting/revoking are admin surfaces; `GET /share/:token` rides in the same
    // router and stays public — it is not under `/api/`, so the prefix gate skips it.
    app.route('/', createShareRoutes(db, createdAuth));
    // Same shape again: viewer admin under the wall, `POST /invite/:token` public.
    app.route('/', createViewerRoutes(db, createdAuth));
    // And again: users admin under the wall, `POST /claim/:token` public.
    app.route('/', createUserRoutes(db, createdAuth));
    // MCP (docs/04 § 6): outside /api, token-Bearer only, gated in its router.
    app.route(
      '/',
      createMcpRoutes(db, createdAuth, { execute: appOptions.executeQuery, limits: queryLimits }),
    );
    const notifications = createNtfyIntegration(db, pipeline, createdAuth, ntfyOptions);
    ntfy = notifications.notifier;
    app.route('/', notifications.routes);
  }

  app.route('/', createMetricsRoutes({ metrics, db: appOptions.db, token: metricsToken }));
  app.route('/', createApp(appOptions));
  // Explicit refusal, not just the header: crawlers ask for this file first,
  // and a self-hosted analytics console should never be indexed anywhere.
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
  if (webDir !== undefined) app.route('/', createSpaRoutes({ dir: webDir }));

  return { app, auth, metrics, ntfy };
}

/** Registered after the gate, so unauthorized rejections never skew the summary. */
function timed(metrics: Metrics): MiddlewareHandler<AuthEnv> {
  return async (_c, next) => {
    const started = performance.now();
    await next();
    metrics.query.observe(performance.now() - started);
  };
}

/**
 * The SSE client gauge. Streams only end by abort, which `@hono/node-server`
 * surfaces on the request signal; non-stream responses (400s) close on return.
 */
function sseGauge(metrics: Metrics): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    metrics.sseOpened();
    let open = true;
    const close = (): void => {
      if (open) {
        open = false;
        metrics.sseClosed();
      }
    };
    const signal = c.req.raw.signal;
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
    await next();
    if (c.res.status !== 200) close();
  };
}
