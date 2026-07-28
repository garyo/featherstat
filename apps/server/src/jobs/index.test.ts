import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb, session } from '../../test/rows.ts';
import {
  type Db,
  insertEvents,
  setSetting,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import type { Fetcher } from './geoip-refresh.ts';
import { type Scheduler, startJobs } from './index.ts';
import { RETENTION_DAYS_KEY } from './retention.ts';

const NOW = Date.UTC(2026, 6, 27, 12);

let db: Db;
let dir: string;
let mmdbPath: string;
let scheduler: Scheduler | undefined;
let logged: string[];

/** Never reached in these tests unless the GeoIP job actually runs. */
function stubFetch(): { fetch: Fetcher; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
  };
}

beforeEach(() => {
  db = openTestDb();
  dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  mmdbPath = join(dir, 'dbip-city-lite.mmdb');
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logged.push(line);
  });
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

describe('startJobs', () => {
  it('leaves the first GeoIP download to the manual script', async () => {
    const { fetch, urls } = stubFetch();
    scheduler = startJobs(db, { mmdbPath, fetch, now: () => NOW });

    await scheduler.tick();

    expect(urls).toEqual([]);
    expect(logged.join('\n')).toContain('geoip-refresh');
  });

  it('refreshes an installed database that has gone stale', async () => {
    writeFileSync(mmdbPath, 'stale but present');
    const twoMonthsAgo = (NOW - 60 * DAY_MS) / 1000;
    utimesSync(mmdbPath, twoMonthsAgo, twoMonthsAgo);
    const { fetch, urls } = stubFetch();
    const failures: string[] = [];

    scheduler = startJobs(db, {
      mmdbPath,
      fetch,
      now: () => NOW,
      onError: (job) => failures.push(job),
    });
    await scheduler.tick();

    expect(urls).toEqual([
      'https://download.db-ip.com/free/dbip-city-lite-2026-07.mmdb.gz',
      'https://download.db-ip.com/free/dbip-city-lite-2026-06.mmdb.gz',
    ]);
    expect(failures).toEqual(['geoip-refresh']); // the stub publishes nothing
  });

  it('leaves a database installed this month alone', async () => {
    writeFileSync(mmdbPath, 'fresh');
    const { fetch, urls } = stubFetch();

    scheduler = startJobs(db, { mmdbPath, fetch, now: () => Date.now() });
    await scheduler.tick();

    expect(urls).toEqual([]);
  });

  it('prunes at boot once retention is configured', async () => {
    const old = NOW - 100 * DAY_MS;
    withWriteTransaction(db, () => {
      insertEvents(db, [event({ ts: old })]);
      upsertSessions(db, [session({ started_at: old, last_seen_at: old })]);
      setSetting(db, RETENTION_DAYS_KEY, '30');
    });

    scheduler = startJobs(db, { mmdbPath, fetch: stubFetch().fetch, now: () => NOW });
    await scheduler.tick();

    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    expect(logged.join('\n')).toContain('retention: deleted 1 events, 1 sessions');
  });
});
