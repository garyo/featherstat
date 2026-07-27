/** Hourly re-check: the jobs are daily and monthly, so the tick needs no precision. */
const DEFAULT_CHECK_INTERVAL_MS = 3_600_000;
/** A failed run retries after this instead of a full interval — a monthly job must not stall a month. */
const RETRY_DELAY_MS = 6 * 3_600_000;

export interface Job {
  name: string;
  /** Minimum time between runs. */
  everyMs: number;
  /**
   * Last successful run as recorded outside the process (a file mtime, a
   * settings row). Absent — or never run — makes the job due at boot.
   */
  lastRunAt?: () => number | undefined;
  run: () => Promise<void> | void;
}

export interface SchedulerOptions {
  /** How often due-ness is re-checked. */
  checkIntervalMs?: number;
  now?: () => number;
  onError?: (job: string, error: unknown) => void;
}

export interface Scheduler {
  /** Runs everything due right now; resolves once those jobs have settled. */
  tick(): Promise<void>;
  /** Stops the timer. In-flight work is left to finish. */
  stop(): void;
}

/**
 * In-process job timing (docs/02 § Background jobs): no cron container, no
 * scheduler dependency — a single interval that asks each job whether it is due.
 */
export function startScheduler(jobs: readonly Job[], options: SchedulerOptions = {}): Scheduler {
  const now = options.now ?? Date.now;
  const onError =
    options.onError ??
    ((job: string, error: unknown) => console.error(`job ${job} failed:`, error));
  const nextRun = new Map<string, number>();
  let inFlight: Promise<void> | undefined;

  const runDue = async (): Promise<void> => {
    for (const job of jobs) {
      if (now() < (nextRun.get(job.name) ?? dueAt(job))) continue;
      try {
        await job.run();
        nextRun.set(job.name, now() + job.everyMs);
      } catch (error) {
        onError(job.name, error);
        nextRun.set(job.name, now() + RETRY_DELAY_MS);
      }
    }
  };

  /** One pass at a time: a slow download must not overlap the next check. */
  const tick = (): Promise<void> => {
    inFlight ??= runDue().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const timer = setInterval(
    () => void tick(),
    options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
  );
  timer.unref?.(); // a pending check must never hold the process open
  void tick(); // catch up at boot on whatever went stale while we were down

  return { tick, stop: () => clearInterval(timer) };
}

function dueAt(job: Job): number {
  const last = job.lastRunAt?.();
  return last === undefined ? 0 : last + job.everyMs;
}
