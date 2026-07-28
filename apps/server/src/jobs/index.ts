import { DAY_MS } from '@featherstat/shared';
import type { Db } from '../db/index.ts';
import {
  DEFAULT_MMDB_PATH,
  type Fetcher,
  geoipInstalledAt,
  refreshGeoipDatabase,
} from './geoip-refresh.ts';
import { runRetention } from './retention.ts';
import { type Job, type Scheduler, type SchedulerOptions, startScheduler } from './scheduler.ts';

export { DEFAULT_MMDB_PATH, type Fetcher, refreshGeoipDatabase } from './geoip-refresh.ts';
export { RETENTION_DAYS_KEY, retentionDays, runRetention } from './retention.ts';
export type { Job, Scheduler, SchedulerOptions } from './scheduler.ts';

/**
 * A hair longer than the longest month: every run then lands in a month we have
 * not downloaded yet, instead of re-fetching the edition already installed.
 */
const GEOIP_INTERVAL_MS = 31 * DAY_MS;

export interface JobsOptions extends SchedulerOptions {
  /** The `.mmdb` the pipeline reads — the refresh replaces exactly this file. */
  mmdbPath?: string;
  /**
   * Download the *first* database too. Off by default: a fresh install (or a
   * `node --watch` restart) should not pull a few hundred MB unasked —
   * `bun run --cwd apps/server geoip-refresh` does that deliberately.
   */
  installMissingMmdb?: boolean;
  fetch?: Fetcher;
}

/**
 * The in-process background jobs of docs/02: monthly GeoIP refresh and optional
 * retention pruning. Returns the scheduler so the caller can stop it on SIGTERM.
 */
export function startJobs(db: Db, options: JobsOptions = {}): Scheduler {
  const mmdbPath = options.mmdbPath ?? process.env.GEOIP_MMDB_PATH ?? DEFAULT_MMDB_PATH;
  const jobs: Job[] = [];

  if (geoipInstalledAt(mmdbPath) !== undefined || options.installMissingMmdb === true) {
    jobs.push({
      name: 'geoip-refresh',
      everyMs: GEOIP_INTERVAL_MS,
      lastRunAt: () => geoipInstalledAt(mmdbPath),
      run: async () => {
        const { url, bytes } = await refreshGeoipDatabase({
          path: mmdbPath,
          fetch: options.fetch,
          now: options.now,
        });
        console.log(`geoip: installed ${url} (${bytes} bytes) as ${mmdbPath}`);
      },
    });
  } else {
    console.log(
      `geoip: no database at ${mmdbPath} — run 'bun run --cwd apps/server geoip-refresh' to install one`,
    );
  }

  jobs.push({
    name: 'retention',
    everyMs: DAY_MS,
    run: async () => {
      const { days, events, sessions } = await runRetention(db, { now: options.now });
      if (events > 0 || sessions > 0) {
        console.log(
          `retention: deleted ${events} events, ${sessions} sessions older than ${days}d`,
        );
      }
    },
  });

  return startScheduler(jobs, options);
}
