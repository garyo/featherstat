import { serve } from '@hono/node-server';
import { openDb } from './db/index.ts';
import { createApp } from './index.ts';
import { MmdbProvider } from './pipeline/geo.ts';
import { createPipeline } from './pipeline/index.ts';
import { createRealtimeHub } from './realtime/hub.ts';

const db = openDb(process.env.DB_PATH ?? 'analytics.db');
const pipeline = createPipeline(db, {
  geo: new MmdbProvider(process.env.GEOIP_DB ?? 'dbip-city-lite.mmdb'),
});
const hub = createRealtimeHub(db);
pipeline.onHit((event) => hub.record(event));
pipeline.onFlush((summary) => hub.recordFlush(summary));

const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: createApp({ sink: pipeline.sink, db, hub }).fetch, port });
console.log(`analytics server listening on :${port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    pipeline.shutdown(); // final flush — queued beacons land before exit
    db.close();
    process.exit(0);
  });
}
