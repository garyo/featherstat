import { serve } from '@hono/node-server';
import { createSecuredApp } from './auth/app.ts';
import { DEV_DB_PATH, openDb } from './db/index.ts';
import { DEFAULT_MMDB_PATH, startJobs } from './jobs/index.ts';
import { readNtfySettings } from './notify/index.ts';
import { startExclusionRefresh } from './pipeline/exclusions.ts';
import { MmdbProvider } from './pipeline/geo.ts';
import { createPipeline } from './pipeline/index.ts';
import { teeSinkFromEnv } from './pipeline/tee.ts';
import { QueryPool } from './query/pool/pool.ts';
import { createRealtimeHub } from './realtime/hub.ts';

/** One path for both readers: the pipeline reads this file, the refresh job replaces it. */
const mmdbPath = process.env.GEOIP_MMDB_PATH ?? DEFAULT_MMDB_PATH;

const dbPath = process.env.DB_PATH ?? DEV_DB_PATH;
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

// Hostname exclusion rules are resolved here, on a timer, and never on the hot
// path: ingest only reads the address set this keeps current (docs/03 § Exclusions).
const exclusionRefresh = startExclusionRefresh(pipeline.exclusions);

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
  refreshExclusions: exclusionRefresh.refresh,
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

// The bound port, not the configured one: PORT=0 asks the OS for a free port,
// and whoever spawned us learns which from this line.
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`analytics server listening on :${info.port}`);
});

/** In-flight queries get this long at shutdown — well inside Docker's 10 s stop grace. */
const QUERY_DRAIN_MS = 3_000;

/**
 * The final flush comes first, before anything that can take time: queued
 * beacons must land even if the container is killed at the end of its stop
 * grace. A second flush after the query drain lands hits whose requests were
 * already in flight when the listener closed, and retries a first that failed —
 * so the exit code says whether anything queued was lost.
 */
async function shutdown(): Promise<never> {
  server.close();
  jobs.stop();
  exclusionRefresh.stop();
  let flushed = false;
  try {
    pipeline.shutdown();
    await pool?.close(QUERY_DRAIN_MS);
    flushed = pipeline.shutdown();
  } catch (error) {
    console.error('shutdown:', error);
  }
  if (!flushed) console.error('shutdown: the final flush failed — queued hits were not written');
  db.close();
  process.exit(flushed ? 0 : 1);
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void shutdown();
  });
}
