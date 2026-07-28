import { BATCH_INTERVAL_MS, type Hit, type HitContext } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, GOOGLEBOT_UA, T0 } from '../../test/rows.ts';
import { createSite, type Db, getBotDrops, openDb, withWriteTransaction } from '../db/index.ts';
import type { GeoProvider } from './geo.ts';
import type { Pipeline } from './index.ts';
import { createPipeline } from './index.ts';

const BOSTON: GeoProvider = {
  lookup: () => ({
    country: 'US',
    region: 'Massachusetts',
    city: 'Boston',
    lat: 42.36,
    lon: -71.06,
  }),
};

function hit(overrides: Partial<Hit> = {}): Hit {
  return { siteId: 1, type: 'pageview', url: 'https://example.com/a', ...overrides };
}

function ctx(overrides: Partial<HitContext> = {}): HitContext {
  return {
    ip: '203.0.113.5',
    userAgent: DESKTOP_UA,
    acceptLanguage: 'en-US,en;q=0.9',
    receivedAt: T0,
    ...overrides,
  };
}

let db: Db;
let pipeline: Pipeline;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'Example', domains: ['example.com'] });
  });
  pipeline = createPipeline(db, { geo: BOSTON });
});

afterEach(() => {
  pipeline.shutdown();
  db.close();
  vi.useRealTimers();
});

describe('createPipeline', () => {
  it('enriches a pageview end-to-end and lands it on the batch interval', () => {
    pipeline.sink([hit()], ctx());
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);

    const event = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(event.type).toBe('pageview');
    expect(event.hostname).toBe('example.com');
    expect(event.path).toBe('/a');
    expect(event.browser).toBe('Chrome');
    expect(event.os).toBe('Windows');
    expect(event.device_type).toBe('desktop');
    expect(event.lang).toBe('en-US');
    expect(event.country).toBe('US');
    expect(event.city).toBe('Boston');
    expect(event.local_date).toBe('2026-07-27');
    expect(event.local_hour).toBe(10);
    expect(event.visitor_id).toHaveLength(8);

    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(session.pageviews).toBe(1);
    expect(session.ref_type).toBe('direct');
    expect(session.country).toBe('US');
  });

  it('drops bot traffic before storage and counts it per site and local day', () => {
    pipeline.sink([hit()], ctx({ userAgent: GOOGLEBOT_UA }));
    pipeline.sink([hit()], ctx({ userAgent: GOOGLEBOT_UA }));
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    expect(getBotDrops(db, 1, '2026-07-27')).toBe(2);
  });

  it('drops hits for unknown sites', () => {
    pipeline.sink([hit({ siteId: 99 })], ctx());
    pipeline.flush();
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
  });

  it('stores pings as rows that update engagement but not pageviews', () => {
    pipeline.sink([hit()], ctx());
    pipeline.sink([hit({ type: 'ping' })], ctx({ receivedAt: T0 + 10_000 }));
    pipeline.flush();
    const types = db.prepare('SELECT type FROM events ORDER BY seq').pluck().all();
    expect(types).toEqual(['pageview', 'ping']);
    const session = db.prepare('SELECT pageviews, engaged_ms FROM sessions').get();
    expect(session).toEqual({ pageviews: 1, engaged_ms: 10_000 });
  });

  it('notifies onFlush hooks with the sites that changed', () => {
    const hook = vi.fn();
    pipeline.onFlush(hook);
    pipeline.sink([hit()], ctx());
    vi.advanceTimersByTime(BATCH_INTERVAL_MS);
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0].siteIds).toEqual([1]);
  });

  it('recovers open sessions across a restart and keeps seq counting', () => {
    pipeline.sink([hit()], ctx());
    pipeline.shutdown();

    vi.setSystemTime(T0 + 60_000);
    pipeline = createPipeline(db, { geo: BOSTON });
    pipeline.sink([hit({ url: 'https://example.com/b' })], ctx({ receivedAt: T0 + 60_000 }));
    pipeline.flush();

    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    const rows = db.prepare('SELECT seq, session_id FROM events ORDER BY seq').all() as Array<{
      seq: number;
      session_id: Buffer;
    }>;
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]?.session_id).toEqual(rows[1]?.session_id);
    const session = db.prepare('SELECT pageviews, engaged_ms, exit_path FROM sessions').get();
    expect(session).toEqual({ pageviews: 2, engaged_ms: 20_000, exit_path: '/b' });
  });
});
