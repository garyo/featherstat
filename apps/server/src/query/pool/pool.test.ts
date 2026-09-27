import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryRequest, QueryResponse } from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { event, session, syncRollups } from '../../../test/rows.ts';
import {
  createSite,
  type Db,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../../db/index.ts';
import { executeQueryRequest } from '../executor.ts';
import { PoolSaturatedError, QueryPool } from './pool.ts';
import type { PoolReply } from './protocol.ts';

/**
 * Workers spawned from vitest do not inherit its transform pipeline, so they
 * get the same flags the project's own node scripts use (package.json), plus
 * the alias hook that teaches plain node the workspace import.
 */
const EXEC_ARGV = [
  '--experimental-transform-types',
  '--disable-warning=ExperimentalWarning',
  '--import',
  fileURLToPath(new URL('../../../test/replay/shared-alias.ts', import.meta.url)),
];

const FIXTURE_URL = new URL('./fixture-worker.ts', import.meta.url);

const NOW = Date.UTC(2023, 10, 14, 18);
const REQUEST: QueryRequest = {
  site: 1,
  range: { from: '2023-11-14', to: '2023-11-14' },
  queries: [{ id: 'kpis', metrics: ['visitors', 'pageviews', 'visits'] }],
} as QueryRequest;

/** The failure-path tests drive the private submit with fixture-only jobs. */
function submit(pool: QueryPool, job: { kind: string; ms?: number }): Promise<PoolReply> {
  const internals = pool as unknown as { submit(job: object): Promise<PoolReply>; nextId: number };
  return internals.submit({ ...job, id: internals.nextId++ });
}

describe('QueryPool against the real worker', () => {
  let dir: string;
  let db: Db;
  let pool: QueryPool;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pool-test-'));
    const path = join(dir, 'analytics.db');
    db = openDb(path);
    withWriteTransaction(db, () => {
      createSite(db, { id: 1, name: 'one', domains: ['one.test'] });
      insertEvents(db, [event(), event({ path: '/b', seq: 2 })]);
      upsertSessions(db, [session({ pageviews: 2 })]);
    });
    syncRollups(db);
    pool = new QueryPool(path, { size: 1, execArgv: EXEC_ARGV });
  });

  afterAll(async () => {
    await pool.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('executes off the main thread', async () => {
    await expect(pool.ping()).resolves.not.toBe(0);
  });

  it('answers a batch identically to inline execution (timings aside)', async () => {
    const pooled = await pool.execute(REQUEST, NOW);
    const inline = executeQueryRequest(db, REQUEST, { now: NOW });
    const withoutMs = (results: QueryResponse['results']): unknown =>
      Object.fromEntries(
        Object.entries(results).map(([id, entry]) => [id, { ...entry, ms: undefined }]),
      );
    expect(withoutMs(pooled.results)).toEqual(withoutMs(inline.results));
    expect(pooled.meta.dataVersion).toBe(inline.meta.dataVersion);
    expect(pooled.meta.windows).toEqual(inline.meta.windows);
  });

  it('sees writes committed after the worker connection opened', async () => {
    const before = await pool.execute(REQUEST, NOW);
    withWriteTransaction(db, () => insertEvents(db, [event({ path: '/c', seq: 3 })]));
    syncRollups(db);
    const after = await pool.execute(REQUEST, NOW);
    const pageviews = (r: QueryResponse): unknown =>
      (r.results.kpis as { rows: Array<Record<string, unknown>> }).rows[0]?.pageviews;
    expect(pageviews(before)).toBe(2);
    expect(pageviews(after)).toBe(3);
    expect(after.meta.dataVersion).toBeGreaterThan(before.meta.dataVersion);
  });

  it('carries derived-metric definitions across the pool boundary', async () => {
    const request: QueryRequest = {
      ...REQUEST,
      queries: [{ id: 'q', metrics: ['d:views_each'] }],
    } as QueryRequest;
    const derived = { views_each: 'pageviews / visits' };
    const pooled = await pool.execute(request, NOW, undefined, derived);
    const inline = executeQueryRequest(db, request, { now: NOW, derived });
    const rows = (r: QueryResponse): unknown => (r.results.q as { rows: unknown }).rows;
    expect(rows(pooled)).toEqual(rows(inline));
    // Without the definitions the worker refuses honestly, per query.
    const missing = await pool.execute(request, NOW);
    expect(missing.results.q).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('rejects after close instead of hanging', async () => {
    const path = join(dir, 'analytics.db');
    const closing = new QueryPool(path, { size: 1, execArgv: EXEC_ARGV });
    await closing.close();
    await expect(closing.execute(REQUEST, NOW)).rejects.toThrow(/closed/);
  });
});

describe('QueryPool failure paths (fixture worker)', () => {
  let pool: QueryPool;

  beforeAll(() => {
    // The fixture never opens the db; any real path satisfies the init shape.
    pool = new QueryPool(':fixture:', {
      size: 1,
      maxQueue: 0,
      timeoutMs: 300,
      workerUrl: FIXTURE_URL,
      execArgv: EXEC_ARGV,
    });
  });

  afterAll(async () => {
    await pool.close();
  });

  it('replaces a wedged worker after the timeout and keeps serving', async () => {
    await expect(submit(pool, { kind: 'sleep', ms: 5_000 })).rejects.toThrow(/timed out/);
    await expect(pool.ping()).resolves.not.toBe(0);
  });

  it('rejects the in-flight job when a worker crashes, then recovers', async () => {
    await expect(submit(pool, { kind: 'crash' })).rejects.toThrow(/exited/);
    await expect(pool.ping()).resolves.not.toBe(0);
  });

  it('refuses new work while saturated instead of queueing without bound', async () => {
    const running = submit(pool, { kind: 'sleep', ms: 150 });
    // The worker is now busy and maxQueue is 0: the next job must bounce.
    await expect(pool.ping()).rejects.toThrow(PoolSaturatedError);
    await expect(running).resolves.toMatchObject({ ok: true });
    await expect(pool.ping()).resolves.not.toBe(0);
  });
});

describe('QueryPool close (fixture worker)', () => {
  function fixturePool(timeoutMs: number): QueryPool {
    return new QueryPool(':fixture:', {
      size: 1,
      timeoutMs,
      workerUrl: FIXTURE_URL,
      execArgv: EXEC_ARGV,
    });
  }

  it('settles when the watchdog replaces a wedged worker mid-close', async () => {
    const pool = fixturePool(300);
    await pool.ping(); // the worker is up, so the sleep starts at once
    const wedged = expect(submit(pool, { kind: 'sleep', ms: 5_000 })).rejects.toThrow(/timed out/);
    const started = performance.now();

    await pool.close();

    await wedged;
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('stops waiting for in-flight work after the grace it was given', async () => {
    const pool = fixturePool(60_000);
    await pool.ping();
    const cut = expect(submit(pool, { kind: 'sleep', ms: 5_000 })).rejects.toThrow(/exited/);
    const started = performance.now();

    await pool.close(100);

    await cut;
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('still lets a job that finishes inside the grace answer', async () => {
    const pool = fixturePool(60_000);
    await pool.ping();
    const running = submit(pool, { kind: 'sleep', ms: 50 });

    await pool.close(5_000);

    await expect(running).resolves.toMatchObject({ ok: true });
  });
});
