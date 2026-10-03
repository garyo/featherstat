import { DAY_MS } from '@featherstat/shared';
import type { Db } from '../db/index.ts';
import { type AlertNotifier, runAlerts } from './alerts.ts';
import { backupLastRunAt, runBackup } from './backup.ts';
import { runCampaignBackfill } from './campaign-backfill.ts';
import { digestLastRunAt, runDigest } from './digest.ts';
import {
  DEFAULT_MMDB_PATH,
  type Fetcher,
  geoipInstalledAt,
  refreshGeoipDatabase,
} from './geoip-refresh.ts';
import { runMissingBackfill } from './missing-backfill.ts';
import { runPropScrubs } from './prop-scrub.ts';
import { runReconcile } from './reconcile.ts';
import { runReferrerBackfill } from './referrer-backfill.ts';
import { runRetention } from './retention.ts';
import { type Job, type Scheduler, type SchedulerOptions, startScheduler } from './scheduler.ts';
import { runSitePurges } from './site-purge.ts';
import { runTimezoneBackfills } from './timezone-backfill.ts';

export {
  ALERT_RULES_KEY,
  type AlertNotifier,
  type AlertsResult,
  readAlertRules,
  runAlerts,
  writeAlertRules,
} from './alerts.ts';
export {
  BACKUP_DIR_KEY,
  BACKUP_KEEP_KEY,
  type BackupResult,
  backupKeep,
  DEFAULT_BACKUP_KEEP,
  runBackup,
} from './backup.ts';
export {
  type CampaignBackfillResult,
  requestCampaignBackfill,
  runCampaignBackfill,
} from './campaign-backfill.ts';
export { DIGEST_LAST_RUN_KEY, type DigestResult, digestLastRunAt, runDigest } from './digest.ts';
export { DEFAULT_MMDB_PATH, type Fetcher, refreshGeoipDatabase } from './geoip-refresh.ts';
export { type MissingBackfillResult, runMissingBackfill } from './missing-backfill.ts';
export { type PropScrubResult, requestPropScrub, runPropScrubs } from './prop-scrub.ts';
export { type ReconcileResult, runReconcile } from './reconcile.ts';
export {
  type ReferrerBackfillResult,
  requestReferrerBackfill,
  runReferrerBackfill,
} from './referrer-backfill.ts';
export { RETENTION_DAYS_KEY, retentionDays, runRetention } from './retention.ts';
export type { Job, Scheduler, SchedulerOptions } from './scheduler.ts';
export { requestSitePurge, runSitePurges, type SitePurgeResult } from './site-purge.ts';
export {
  requestTimezoneBackfill,
  runTimezoneBackfills,
  type TimezoneBackfillResult,
} from './timezone-backfill.ts';

/**
 * A hair longer than the longest month: every run then lands in a month we have
 * not downloaded yet, instead of re-fetching the edition already installed.
 */
const GEOIP_INTERVAL_MS = 31 * DAY_MS;

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

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
  /** Feeds /metrics' repair counter (routes/metrics.ts) — drift is a defect signal. */
  onRollupRepairs?: (days: number) => void;
  /**
   * The ntfy notifier's post/configured pair (createSecuredApp returns it) —
   * turns on the hourly alert evaluation and the weekly digest. Both jobs skip
   * themselves while ntfy is unconfigured, so registering them is free.
   */
  notify?: AlertNotifier;
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
    name: 'rollup-reconcile',
    everyMs: DAY_MS,
    run: async () => {
      const { checked, repaired, cells } = await runReconcile(db, { now: options.now });
      if (repaired > 0) {
        options.onRollupRepairs?.(repaired);
        console.error(
          `rollup-reconcile: repaired ${repaired}/${checked} site-day(s), ${cells} drifted cell(s)`,
        );
      }
    },
  });

  // The route that enqueues a prop scrub also kicks it directly; this entry is
  // the resume path — a watermark a crash left behind drains at boot (the
  // scheduler runs never-run jobs immediately) and on the hourly re-check.
  jobs.push({
    name: 'prop-scrub',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, rows } = await runPropScrubs(db);
      if (completed > 0) {
        console.log(`prop-scrub: removed a key from ${rows} event row(s), ${completed} scrub(s)`);
      }
    },
  });

  // Same shape as prop-scrub: the site-delete route kicks the purge directly;
  // this entry is the resume path for a watermark a crash left behind.
  jobs.push({
    name: 'site-purge',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, rows } = await runSitePurges(db);
      if (completed > 0) {
        console.log(`site-purge: removed ${rows} row(s) across ${completed} deleted site(s)`);
      }
    },
  });

  // Same shape as prop-scrub: the alias route kicks the backfill directly;
  // this entry is the resume path for a watermark a crash left behind.
  jobs.push({
    name: 'campaign-backfill',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, rows } = await runCampaignBackfill(db);
      if (completed && rows > 0) {
        console.log(`campaign-backfill: renormalized utm values on ${rows} row(s)`);
      }
    },
  });

  // Same shape as site-purge: the site PATCH kicks the backfill when the zone
  // changes; this entry is the resume path for a watermark a crash left behind.
  jobs.push({
    name: 'timezone-backfill',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, rows } = await runTimezoneBackfills(db, { now: options.now });
      if (completed > 0) {
        console.log(`timezone-backfill: re-dated ${rows} row(s) across ${completed} site(s)`);
      }
    },
  });

  // Enqueued by migration 101, not by a route: canonicalizing stored referrers
  // is a one-time upgrade, and this entry is what drains it (the scheduler runs
  // a never-run job immediately) and what resumes a watermark a crash left.
  jobs.push({
    name: 'referrer-backfill',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, rows } = await runReferrerBackfill(db);
      if (completed && rows > 0) {
        console.log(`referrer-backfill: canonicalized ref_domain on ${rows} row(s)`);
      }
    },
  });

  // Enqueued by migration 106: moving the not-found page views already recorded
  // as traffic is a one-time upgrade. Daily, because a visit still live when it
  // first ran is left for the next run (missing-backfill.ts).
  jobs.push({
    name: 'missing-backfill',
    everyMs: DAY_MS,
    run: async () => {
      const { completed, moved, visits } = await runMissingBackfill(db, { now: options.now });
      if (completed && moved > 0) {
        console.log(
          `missing-backfill: moved ${moved} not-found page view(s), ${visits} visit(s) removed`,
        );
      }
    },
  });

  const notify = options.notify;
  if (notify !== undefined) {
    jobs.push({
      name: 'alerts',
      everyMs: HOUR_MS,
      run: () => {
        const { evaluated, fired } = runAlerts(db, notify, { now: options.now });
        if (fired > 0) console.log(`alerts: ${fired}/${evaluated} rule(s) fired`);
      },
    });

    // Weekly, with the last run persisted in a settings row — a restart
    // mid-week must not re-send, and a boot past the boundary must catch up.
    jobs.push({
      name: 'weekly-digest',
      everyMs: WEEK_MS,
      lastRunAt: () => digestLastRunAt(db),
      run: () => {
        const { skipped, sites } = runDigest(db, notify, { now: options.now });
        if (!skipped) console.log(`weekly-digest: posted for ${sites} site(s)`);
      },
    });
  }

  // Nightly VACUUM INTO copy, off until Settings → Data names a directory. The
  // last run persists in a settings row so a restart never re-vacuums a night.
  jobs.push({
    name: 'backup',
    everyMs: DAY_MS,
    lastRunAt: () => backupLastRunAt(db),
    run: () => {
      const { skipped, file, pruned } = runBackup(db, { now: options.now });
      if (!skipped) {
        console.log(`backup: wrote ${file}${pruned.length > 0 ? `, pruned ${pruned.length}` : ''}`);
      }
    },
  });

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
