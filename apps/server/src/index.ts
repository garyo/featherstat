import { Hono } from 'hono';
import type { Db } from './db/index.ts';
import type { HitSink } from './pipeline/index.ts';
import type { RealtimeHub } from './realtime/hub.ts';
import { createRealtimeRoutes } from './realtime/sse.ts';
import { createQueryRoutes } from './routes/query.ts';
import { createTrackRoutes } from './routes/track.ts';

const dropHits: HitSink = () => undefined;

export interface AppOptions {
  /** Receives normalized hits — `createPipeline` supplies the real one; omitted, they drop. */
  sink?: HitSink;
  /** Mounts the query API. */
  db?: Db;
  /** Mounts the realtime stream. */
  hub?: RealtimeHub;
}

/** Without `db` or `hub`, only tracking runs. */
export function createApp({ sink = dropHits, db, hub }: AppOptions = {}): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', createTrackRoutes(sink));
  if (db !== undefined) app.route('/', createQueryRoutes(db));
  if (hub !== undefined) app.route('/', createRealtimeRoutes(hub));
  return app;
}
