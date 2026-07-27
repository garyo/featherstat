import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Job, type Scheduler, startScheduler } from './scheduler.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let clock = Date.UTC(2026, 6, 27, 12);
const now = () => clock;
let scheduler: Scheduler | undefined;

/** Runs the scheduler with a controllable clock; `advance` also fires due checks. */
function start(
  jobs: readonly Job[],
  overrides: { onError?: (job: string, e: unknown) => void } = {},
) {
  scheduler = startScheduler(jobs, { now, checkIntervalMs: HOUR_MS, ...overrides });
  return scheduler;
}

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += HOUR_MS) {
    clock += HOUR_MS;
    await vi.advanceTimersByTimeAsync(HOUR_MS);
  }
}

function counter(overrides: Partial<Job> = {}): Job & { calls: number } {
  const job = {
    name: 'job',
    everyMs: DAY_MS,
    calls: 0,
    run: () => {
      job.calls += 1;
    },
    ...overrides,
  };
  return job;
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = Date.UTC(2026, 6, 27, 12);
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
});

describe('startScheduler', () => {
  it('runs a job that has never run at boot', async () => {
    const job = counter();
    start([job]);

    await scheduler?.tick();

    expect(job.calls).toBe(1);
  });

  it('runs a stale job at boot and lets a fresh one wait out its interval', async () => {
    const boot = clock;
    const stale = counter({ name: 'stale', lastRunAt: () => boot - 2 * DAY_MS });
    const fresh = counter({ name: 'fresh', lastRunAt: () => boot - HOUR_MS });
    start([stale, fresh]);

    await scheduler?.tick();
    expect([stale.calls, fresh.calls]).toEqual([1, 0]);

    // 23 h after boot the fresh job's day is up; the stale one restarted its own.
    await advance(23 * HOUR_MS);
    expect([stale.calls, fresh.calls]).toEqual([1, 1]);
  });

  it('runs again once the interval has passed, not on every check', async () => {
    const job = counter();
    start([job]);
    await scheduler?.tick();

    await advance(DAY_MS - HOUR_MS);
    expect(job.calls).toBe(1);

    await advance(HOUR_MS);
    expect(job.calls).toBe(2);
  });

  it('reports a failure and retries it before the full interval', async () => {
    const failures: string[] = [];
    const job = counter({
      everyMs: 30 * DAY_MS,
      run: () => {
        job.calls += 1;
        throw new Error('boom');
      },
    });
    start([job], { onError: (name) => failures.push(name) });

    await scheduler?.tick();
    expect([job.calls, failures]).toEqual([1, ['job']]);

    await advance(5 * HOUR_MS);
    expect(job.calls).toBe(1);

    await advance(HOUR_MS);
    expect(job.calls).toBe(2);
  });

  it('keeps a failing job from blocking the ones after it', async () => {
    const failing = counter({
      name: 'failing',
      run: () => Promise.reject(new Error('boom')),
    });
    const healthy = counter({ name: 'healthy' });
    start([failing, healthy], { onError: () => undefined });

    await scheduler?.tick();

    expect(healthy.calls).toBe(1);
  });

  it('never overlaps runs — a slow job holds the next check', async () => {
    let release = (): void => undefined;
    const job = counter({
      everyMs: 0,
      run: () =>
        new Promise<void>((resolve) => {
          job.calls += 1;
          release = resolve;
        }),
    });
    start([job]);

    await advance(3 * HOUR_MS);
    expect(job.calls).toBe(1);

    release();
    await advance(HOUR_MS);
    expect(job.calls).toBe(2);
  });

  it('stops checking after stop()', async () => {
    const job = counter();
    start([job]);
    await scheduler?.tick();
    scheduler?.stop();

    await advance(10 * DAY_MS);

    expect(job.calls).toBe(1);
  });
});
