import { serve } from '@hono/node-server';
import { createSecuredApp } from './auth/app.ts';
import { openDb } from './db/index.ts';
import { DEFAULT_MMDB_PATH, startJobs } from './jobs/index.ts';
import { MmdbProvider } from './pipeline/geo.ts';
import { createPipeline } from './pipeline/index.ts';
import { teeSinkFromEnv } from './pipeline/tee.ts';
import { createRealtimeHub } from './realtime/hub.ts';

/** One path for both readers: the pipeline reads this file, the refresh job replaces it. */
const mmdbPath = process.env.GEOIP_MMDB_PATH ?? DEFAULT_MMDB_PATH;

const db = openDb(process.env.DB_PATH ?? 'analytics.db');
const pipeline = createPipeline(db, { geo: new MmdbProvider(mmdbPath) });
const hub = createRealtimeHub(db);
pipeline.onHit((event) => hub.record(event));
pipeline.onFlush((summary) => hub.recordFlush(summary));

// Tee mode (docs/06): during the bake, every hit is also forwarded to the live Matomo.
const tee = teeSinkFromEnv(pipeline.sink);
if (tee !== undefined) console.log(`forwarding hits to ${process.env.MATOMO_FORWARD_URL}`);

const jobs = startJobs(db, {
  mmdbPath,
  // Downloading a few hundred MB is opt-in; the CLI is the usual first install.
  installMissingMmdb: process.env.GEOIP_AUTO === '1' || process.env.GEOIP_AUTO === 'true',
  onError: (job, error) => console.error(`job ${job} failed:`, error),
});

const port = Number(process.env.PORT ?? 8080);
// The secured shell, NEVER bare createApp: it adds the session gate in front of
// every dashboard read, the admin API, /metrics and the SPA (docs/02 § Security
// posture). src/auth/app.test.ts + main.test.ts hold this wiring in place.
const { app } = createSecuredApp({ sink: tee?.sink ?? pipeline.sink, db, hub, pipeline });
const server = serve({ fetch: app.fetch, port });
console.log(`analytics server listening on :${port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    jobs.stop();
    pipeline.shutdown(); // final flush — queued beacons land before exit
    db.close();
    process.exit(0);
  });
}
