import { Hono, type MiddlewareHandler } from 'hono';
import { observeWriteTransactions } from '../db/index.ts';
import { type AppOptions, createApp } from '../index.ts';
import type { Pipeline } from '../pipeline/index.ts';
import { createAdminRoutes } from '../routes/admin.ts';
import { createMetricsRoutes, Metrics } from '../routes/metrics.ts';
import { createSpaRoutes } from '../routes/spa.ts';
import { type Auth, type AuthEnv, type AuthOptions, createAuth } from './auth.ts';

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
// bounce (invariant 4), so it stays public even before the route exists.
const PUBLIC_API_PATHS = new Set([
  '/api/admin/me',
  '/api/admin/setup',
  '/api/admin/login',
  '/api/collect',
]);

/** Small, static response headers — the backstop for the render discipline docs/02 relies on. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

export interface SecuredAppOptions extends AppOptions {
  auth?: AuthOptions;
  /** Feeds the ingest counters on `/metrics`. */
  pipeline?: Pipeline;
  /** Defaults to env METRICS_TOKEN; absent, `/metrics` is a 404. */
  metricsToken?: string;
  /** Built SPA directory; defaults to env WEB_DIR; absent, no SPA is served. */
  webDir?: string;
}

export interface SecuredApp {
  app: Hono<AuthEnv>;
  /** Undefined on a tracking-only server (no db — nothing gated is mounted). */
  auth: Auth | undefined;
  metrics: Metrics;
}

export function createSecuredApp(options: SecuredAppOptions = {}): SecuredApp {
  const {
    auth: authOptions,
    pipeline,
    metricsToken = process.env.METRICS_TOKEN,
    webDir = process.env.WEB_DIR,
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

  if (appOptions.db !== undefined) {
    const db = appOptions.db;
    observeWriteTransactions(db, (ms) => metrics.flush.observe(ms));
    const createdAuth = createAuth(db, authOptions);
    auth = createdAuth;
    app.use('/api/*', (c, next) =>
      PUBLIC_API_PATHS.has(c.req.path) ? next() : createdAuth.gate(c, next),
    );
    app.use('/api/query', timed(metrics));
    app.use('/api/realtime', sseGauge(metrics));
    app.route('/', createAdminRoutes(db, createdAuth));
  }

  app.route('/', createMetricsRoutes({ metrics, db: appOptions.db, token: metricsToken }));
  app.route('/', createApp(appOptions));
  if (webDir !== undefined) app.route('/', createSpaRoutes({ dir: webDir }));

  return { app, auth, metrics };
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
