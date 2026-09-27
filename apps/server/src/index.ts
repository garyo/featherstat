import { Hono } from 'hono';
import type { Principal } from './auth/principal.ts';
import type { Db } from './db/index.ts';
import type { HitSink } from './pipeline/index.ts';
import type { RealtimeHub } from './realtime/hub.ts';
import { createRealtimeRoutes } from './realtime/sse.ts';
import { createAssetRoutes } from './routes/assets.ts';
import { createQueryRoutes, type ExecuteQuery, type QueryRateLimits } from './routes/query.ts';
import { createSiteRoutes } from './routes/sites.ts';
import { createTrackRoutes } from './routes/track.ts';

const dropHits: HitSink = () => undefined;

export interface AppOptions {
  /** Receives normalized hits — `createPipeline` supplies the real one; omitted, they drop. */
  sink?: HitSink;
  /** Mounts the query API and the site directory. */
  db?: Db;
  /** Mounts the realtime stream. */
  hub?: RealtimeHub;
  /** Re-reads a gated principal, so an open stream learns of a revocation (auth.refresh). */
  refreshPrincipal?: (principal: Principal) => Principal | undefined;
  /** Built tracker bundles; defaults to `packages/tracker/dist` (a bundled server must pass it). */
  assetsDir?: string;
  /** Batch runner override — main.ts supplies the worker read pool's. */
  executeQuery?: ExecuteQuery;
  /** Shared query budgets — the ops shell passes one set to here and to `/mcp`. */
  queryLimits?: QueryRateLimits;
}

/** Without `db` or `hub`, only tracking and the tracker bundles are served. */
export function createApp({
  sink = dropHits,
  db,
  hub,
  assetsDir,
  executeQuery,
  queryLimits,
  refreshPrincipal,
}: AppOptions = {}): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', createTrackRoutes(sink));
  app.route('/', createAssetRoutes({ dir: assetsDir }));
  if (db !== undefined) {
    app.route('/', createQueryRoutes(db, { execute: executeQuery, limits: queryLimits }));
    app.route('/', createSiteRoutes(db));
  }
  if (hub !== undefined) {
    app.route('/', createRealtimeRoutes(hub, { refresh: refreshPrincipal }));
  }
  return app;
}
