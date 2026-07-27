import { Hono } from 'hono';
import type { HitSink } from './pipeline/index.ts';
import { createTrackRoutes } from './routes/track.ts';

const dropHits: HitSink = () => undefined;

/** `sink` receives normalized hits — `createPipeline` supplies the real one; the default drops them. */
export function createApp(sink: HitSink = dropHits): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', createTrackRoutes(sink));
  return app;
}
