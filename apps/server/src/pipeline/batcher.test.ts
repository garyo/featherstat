import { BATCH_INTERVAL_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, missing, session } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  getBotDrops,
  openDb,
  tombstoneSite,
  withWriteTransaction,
} from '../db/index.ts';
import { WriteBatcher } from './batcher.ts';

function count(db: Db, table: 'events' | 'sessions'): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

let db: Db;
let batcher: WriteBatcher;

beforeEach(() => {
  vi.useFakeTimers();
  db = openDb(':memory:');
  batcher = new WriteBatcher(db);
});

afterEach(() => {
  batcher.stop();
  db.close();
  vi.useRealTimers();
});

describe('WriteBatcher', () => {
  it('flushes queued events and sessions on the batch interval', () => {
    batcher.start();
    batcher.addEvent(event());
    batcher.addSession(session());
    vi.advanceTimersByTime(BATCH_INTERVAL_MS - 1);
    expect(count(db, 'events')).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count(db, 'events')).toBe(1);
    expect(count(db, 'sessions')).toBe(1);
    expect(batcher.pending).toBe(0);
  });

  it('upserts one row per dirty session — its state at flush time wins', () => {
    // The sessionizer mutates one live row per open session; re-adding it is a no-op.
    const row = session({ pageviews: 1 });
    batcher.addSession(row);
    row.pageviews = 2;
    row.engaged_ms = 9_000;
    batcher.addSession(row);
    const summary = batcher.flush();
    expect(summary?.sessions).toBe(1);
    expect(db.prepare('SELECT pageviews, engaged_ms FROM sessions').get()).toEqual({
      pageviews: 2,
      engaged_ms: 9_000,
    });
  });

  it('accumulates bot drops and flushes them in the same transaction', () => {
    batcher.addBotDrop(1, '2023-11-14');
    batcher.addBotDrop(1, '2023-11-14');
    batcher.addBotDrop(2, '2023-11-14');
    const summary = batcher.flush();
    expect(summary?.botDrops).toBe(3);
    expect(getBotDrops(db, 1, '2023-11-14')).toBe(2);
    expect(getBotDrops(db, 2, '2023-11-14')).toBe(1);
  });

  it('skips empty flushes and never calls hooks for them', () => {
    const hook = vi.fn();
    batcher.onFlush(hook);
    batcher.start();
    vi.advanceTimersByTime(BATCH_INTERVAL_MS * 5);
    expect(batcher.flush()).toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
  });

  it('reports flushed sites to onFlush hooks (SSE version-tick source)', () => {
    const hook = vi.fn();
    batcher.onFlush(hook);
    batcher.addEvent(event({ site_id: 1 }));
    batcher.addEvent(event({ site_id: 3, seq: 2 }));
    batcher.addSession(session({ site_id: 1 }));
    batcher.flush();
    expect(hook).toHaveBeenCalledOnce();
    const summary = hook.mock.calls[0]?.[0];
    expect(summary.events).toBe(2);
    expect(summary.sessions).toBe(1);
    expect([...summary.siteIds].sort()).toEqual([1, 3]);
  });

  it('keeps a failed flush queued and lands it once writes recover', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    batcher.addEvent(event());
    batcher.addSession(session());
    batcher.addBotDrop(1, '2023-11-14');
    db.pragma('query_only = ON'); // writes now fail, as if the disk were full
    expect(batcher.flush()).toBeUndefined();
    expect(batcher.pending).toBe(3); // nothing dropped: seq/counters must stay consistent
    db.pragma('query_only = OFF');
    const summary = batcher.flush();
    expect(summary?.events).toBe(1);
    expect(count(db, 'events')).toBe(1);
    expect(count(db, 'sessions')).toBe(1);
    expect(getBotDrops(db, 1, '2023-11-14')).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('stop() halts the timer and flushes what is queued', () => {
    batcher.start();
    batcher.addEvent(event());
    batcher.stop();
    expect(count(db, 'events')).toBe(1);
    batcher.addEvent(event({ seq: 2 }));
    vi.advanceTimersByTime(BATCH_INTERVAL_MS * 3);
    expect(count(db, 'events')).toBe(1); // timer is gone; nothing flushed it
  });

  it('drops what a site deleted since it queued — rows, drops, rollups — and lands the rest', () => {
    withWriteTransaction(db, () => {
      createSite(db, { id: 1, name: 'one', domains: [] });
      createSite(db, { id: 2, name: 'two', domains: [] });
    });
    batcher.addEvent(event({ site_id: 1 }));
    batcher.addSession(session({ site_id: 1 }));
    batcher.addBotDrop(1, '2023-11-14');
    batcher.addExcludedDrop(1, '2023-11-14');
    batcher.addMissing(missing({ site_id: 1 }));
    batcher.addEvent(event({ site_id: 2 }));
    batcher.addMissing(missing({ site_id: 2 }));
    batcher.addSession(session({ id: new Uint8Array(8).fill(9), site_id: 2 }));
    withWriteTransaction(db, () => tombstoneSite(db, 1, 0));

    const summary = batcher.flush();

    expect(summary).toEqual({
      events: 1,
      sessions: 1,
      botDrops: 0,
      excludedDrops: 0,
      missing: 1,
      siteIds: [2],
    });
    expect(batcher.pending).toBe(0);
    for (const table of [
      'events',
      'sessions',
      'missing_hits',
      'missing_daily',
      'bot_drops',
      'excluded_drops',
      'rollup_dim_day',
    ]) {
      const rows = db.prepare(`SELECT COUNT(*) FROM ${table} WHERE site_id = 1`).pluck().get();
      expect(rows, table).toBe(0);
    }
    expect(
      db.prepare('SELECT COUNT(*) FROM rollup_dim_day WHERE site_id = 2').pluck().get(),
    ).not.toBe(0);
  });

  it('stop() reports a failed final flush, and a second stop() retries it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    batcher.addEvent(event());
    batcher.beforeCommit = () => {
      batcher.beforeCommit = undefined;
      throw new Error('disk full');
    };

    expect(batcher.stop()).toBe(false);
    expect(count(db, 'events')).toBe(0);
    expect(batcher.stop()).toBe(true);
    expect(count(db, 'events')).toBe(1);
    error.mockRestore();
  });
});
