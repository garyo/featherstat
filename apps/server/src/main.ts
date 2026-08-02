import { serve } from '@hono/node-server';
import { createSecuredApp } from './auth/app.ts';
import { openDb } from './db/index.ts';
import { DEFAULT_MMDB_PATH, startJobs } from './jobs/index.ts';
import { readNtfySettings } from './notify/index.ts';
import { MmdbProvider } from './pipeline/geo.ts';
import { createPipeline } from './pipeline/index.ts';
import { teeSinkFromEnv } from './pipeline/tee.ts';
import { QueryPool } from './query/pool/pool.ts';
import { createRealtimeHub } from './realtime/hub.ts';

/** One path for both readers: the pipeline reads this file, the refresh job replaces it. */
const mmdbPath = process.env.GEOIP_MMDB_PATH ?? DEFAULT_MMDB_PATH;

const dbPath = process.env.DB_PATH ?? 'analytics.db';
const db = openDb(dbPath);

/**
 * Query batches leave the event loop (docs/02): workers open their own
 * read-only connections, so this needs a file — a `:memory:` database (tests,
 * scratch runs) falls back to inline execution in the route.
 *
 * Dev runs this file as TypeScript and the Docker image runs the esbuild
 * bundle; the worker entry must match: source next to us in dev, the
 * separately-bundled `query-worker.js` beside `main.js` in the image.
 */
const pool =
  dbPath === ':memory:'
    ? undefined
    : new QueryPool(dbPath, {
        workerUrl: import.meta.url.endsWith('.ts')
          ? new URL('./query/pool/worker.ts', import.meta.url)
          : new URL('./query-worker.js', import.meta.url),
      });
const pipeline = createPipeline(db, { geo: new MmdbProvider(mmdbPath) });
const hub = createRealtimeHub(db);
pipeline.onHit((event) => hub.record(event));
pipeline.onFlush((summary) => hub.recordFlush(summary));

// Tee mode (docs/06): during the bake, every hit is also forwarded to the live Matomo.
const tee = teeSinkFromEnv(pipeline.sink);
if (tee !== undefined) console.log(`forwarding hits to ${process.env.MATOMO_FORWARD_URL}`);

const port = Number(process.env.PORT ?? 8080);
// The secured shell, NEVER bare createApp: it adds the session gate in front of
// every dashboard read, the admin API, /metrics and the SPA (docs/02 § Security
// posture). src/auth/app.test.ts + main.test.ts hold this wiring in place.
const { app, metrics, ntfy } = createSecuredApp({
  sink: tee?.sink ?? pipeline.sink,
  db,
  hub,
  pipeline,
  executeQuery:
    pool === undefined
      ? undefined
      : (request, now, allowedSites, derived, goals) =>
          pool.execute(request, now, allowedSites, derived, goals),
});

const jobs = startJobs(db, {
  mmdbPath,
  // Downloading a few hundred MB is opt-in; the CLI is the usual first install.
  installMissingMmdb: process.env.GEOIP_AUTO === '1' || process.env.GEOIP_AUTO === 'true',
  onError: (job, error) => console.error(`job ${job} failed:`, error),
  onRollupRepairs: (days) => metrics.recordRollupRepairs(days),
  // Alerts + weekly digest ride the notifier; both skip while ntfy is unconfigured.
  notify: ntfy,
});

// ntfy delivery turns on from the settings rows (docs/01 R16), editable at
// runtime — this line only reports what the DB already says at boot.
const notifications = readNtfySettings(db);
if (notifications.url !== undefined) {
  console.log(`ntfy notifications configured: ${notifications.rules.length} rule(s)`);
}

const server = serve({ fetch: app.fetch, port });
console.log(`analytics server listening on :${port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    jobs.stop();
    void (pool?.close() ?? Promise.resolve()).finally(() => {
      pipeline.shutdown(); // final flush — queued beacons land before exit
      db.close();
      process.exit(0);
    });
  });
}
