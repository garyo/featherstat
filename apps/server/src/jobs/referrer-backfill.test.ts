import { describe, expect, it } from 'vitest';
import { binId, event, openTestDb, session, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  dataVersion,
  getSetting,
  insertEvents,
  setSetting,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { requestReferrerBackfill, runReferrerBackfill } from './referrer-backfill.ts';

/**
 * The referrer backfill (docs/03 § Attribution): chunked, watermarked,
 * idempotent — always re-derived from COALESCE(ref_domain_raw, ref_domain), so
 * any sequence of runs converges on the same rows.
 */

function seed(db: Db, ref: { domain: string | null; raw?: string | null }): void {
  withWriteTransaction(db, () => {
    insertEvents(db, [
      event({ ref_domain: ref.domain, ref_domain_raw: ref.raw ?? null, ref_type: 'social' }),
    ]);
    upsertSessions(db, [
      session({ ref_domain: ref.domain, ref_domain_raw: ref.raw ?? null, ref_type: 'social' }),
    ]);
  });
}

interface RefState {
  ref_domain: string | null;
  ref_domain_raw: string | null;
}

function stateOf(db: Db, table: 'events' | 'sessions'): RefState {
  return stmt<RefState>(db, `SELECT ref_domain, ref_domain_raw FROM ${table}`).get() as RefState;
}

describe('referrer backfill', () => {
  it('is enqueued by the migration that adds the column', () => {
    const db = openTestDb();
    expect(getSetting(db, 'referrer_backfill:events')).toBe('0');
    expect(getSetting(db, 'referrer_backfill:sessions')).toBe('0');
    db.close();
  });

  it('canonicalizes both tables and bumps the epoch', async () => {
    const db = openTestDb();
    seed(db, { domain: 'go.bsky.app' }); // history as v2 wrote it before this change
    const before = dataVersion(db);
    const result = await runReferrerBackfill(db);
    expect(result.completed).toBe(true);
    expect(result.rows).toBe(2); // one event + one session
    for (const table of ['events', 'sessions'] as const) {
      expect(stateOf(db, table)).toEqual({
        ref_domain: 'bsky.app',
        ref_domain_raw: 'go.bsky.app',
      });
    }
    expect(dataVersion(db)).toBeGreaterThan(before); // history rewritten → epoch bumped
    expect(getSetting(db, 'referrer_backfill:events')).toBeUndefined();
    expect(getSetting(db, 'referrer_backfill:sessions')).toBeUndefined();
    db.close();
  });

  it('re-derives from the raw base, so any sequence of runs converges', async () => {
    const db = openTestDb();
    // Already canonicalized once, then the tables changed: `news.google.com` is
    // now kept distinct, so the stored value has to come back.
    seed(db, { domain: 'google.com', raw: 'news.google.com' });
    await runReferrerBackfill(db);
    expect(stateOf(db, 'events')).toEqual({
      ref_domain: 'news.google.com',
      ref_domain_raw: null, // agrees with the base again
    });

    const settled = dataVersion(db);
    withWriteTransaction(db, () => requestReferrerBackfill(db));
    const again = await runReferrerBackfill(db);
    expect(again.rows).toBe(0); // converged
    expect(dataVersion(db)).toBe(settled); // no rewrite, no epoch bump
    db.close();
  });

  it('reclassifies host-derived types, and only those', async () => {
    const db = openTestDb();
    withWriteTransaction(db, () => {
      insertEvents(db, [
        // An alias collapse that reaches a search/social entry the raw host missed.
        event({ session_id: binId(1), ref_domain: 'fb.me', ref_type: 'referral' }),
        // Campaign and internal come from the landing URL and the site's own
        // domains — neither is in this row, so neither may be re-decided here.
        event({ session_id: binId(2), ref_domain: 'go.bsky.app', ref_type: 'campaign' }),
        event({ session_id: binId(3), ref_domain: 'blog.one.test', ref_type: 'internal' }),
      ]);
    });
    withWriteTransaction(db, () => requestReferrerBackfill(db));
    await runReferrerBackfill(db);
    const rows = stmt<{ ref_domain: string; ref_type: string }>(
      db,
      'SELECT ref_domain, ref_type FROM events ORDER BY rowid',
    ).all() as Array<{ ref_domain: string; ref_type: string }>;
    expect(rows).toEqual([
      { ref_domain: 'facebook.com', ref_type: 'social' },
      { ref_domain: 'bsky.app', ref_type: 'campaign' },
      { ref_domain: 'one.test', ref_type: 'internal' },
    ]);
    db.close();
  });

  it('resumes across chunks and leaves rows without a referrer alone', async () => {
    const db = openTestDb();
    withWriteTransaction(db, () => {
      insertEvents(db, [
        ...Array.from({ length: 7 }, (_, i) =>
          event({ session_id: binId(i + 10), ref_domain: 'm.facebook.com' }),
        ),
        event({ session_id: binId(99), ref_domain: null, ref_type: 'direct' }),
      ]);
    });
    withWriteTransaction(db, () => requestReferrerBackfill(db));
    // Tiny chunks: several transactions must still converge on the same state.
    const result = await runReferrerBackfill(db, { batchSize: 2 });
    expect(result.rows).toBe(7); // the direct row was never a candidate
    const rows = stmt<RefState>(
      db,
      'SELECT ref_domain, ref_domain_raw FROM events WHERE ref_domain IS NOT NULL',
    ).all() as RefState[];
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row).toEqual({ ref_domain: 'facebook.com', ref_domain_raw: 'm.facebook.com' });
    }
    db.close();
  });

  it('rebuilds the ref_domain rollup marginals after a rewrite', async () => {
    const db = openTestDb();
    seed(db, { domain: 'go.bsky.app' });
    syncRollups(db); // rollups now say ref_domain = 'go.bsky.app'
    await runReferrerBackfill(db);
    const values = stmt<string>(
      db,
      'SELECT DISTINCT dim_value FROM rollup_dim_day WHERE dim_id = 3 AND dim_null = 0',
    )
      .pluck()
      .all();
    expect(values).toEqual(['bsky.app']);
    db.close();
  });

  it('does nothing once its watermarks are drained', async () => {
    const db = openTestDb();
    seed(db, { domain: 'bsky.app' }); // already canonical
    await runReferrerBackfill(db); // drains the migration's enqueue
    expect(await runReferrerBackfill(db)).toEqual({ completed: false, rows: 0 });
    db.close();
  });
});

describe('the epoch survives a crash mid-rewrite', () => {
  /**
   * Invariant 10's failure mode, reproduced: a run rewrites rows and dies before
   * its epilogue, and the run that resumes it finds nothing left to change.
   * Gating the bump on rows changed *this run* would skip it, and every ETag
   * cut before the rewrite would answer 304 over moved history forever.
   */
  it('bumps even when the resuming run changes nothing itself', async () => {
    const db = openTestDb();
    seed(db, { domain: 'go.bsky.app' });
    await runReferrerBackfill(db);
    const settled = dataVersion(db);

    // The crash: rows already rewritten, the epilogue never reached. Re-arm the
    // watermarks and restore the dirty flag the dead run had committed.
    withWriteTransaction(db, () => {
      requestReferrerBackfill(db);
      setSetting(db, 'referrer_backfill:dirty', '1');
    });

    const result = await runReferrerBackfill(db);
    expect(result.rows).toBe(0); // nothing left to do — the rewrite already landed
    expect(dataVersion(db)).toBeGreaterThan(settled); // …and the epoch still moved
    expect(getSetting(db, 'referrer_backfill:dirty')).toBeUndefined(); // flag cleared
    db.close();
  });

  it('leaves the epoch alone when nothing was ever rewritten', async () => {
    const db = openTestDb();
    seed(db, { domain: 'bsky.app' }); // already canonical
    const before = dataVersion(db);
    const result = await runReferrerBackfill(db);
    expect(result.rows).toBe(0);
    expect(dataVersion(db)).toBe(before);
    db.close();
  });
});

describe('re-arming when the built-in tables change', () => {
  it('runs itself again after the fingerprint moves, without a migration', async () => {
    const db = openTestDb();
    seed(db, { domain: 'bsky.app' });
    await runReferrerBackfill(db);
    const stamped = getSetting(db, 'referrer_backfill:tables');
    expect(stamped).toBeDefined();

    // A second run with the same tables must NOT re-scan.
    withWriteTransaction(db, () => setSetting(db, 'referrer_backfill:dirty', '1'));
    await runReferrerBackfill(db);
    expect(getSetting(db, 'referrer_backfill:tables')).toBe(stamped);

    // Editing a table (simulated by an older stamp) re-arms both watermarks.
    withWriteTransaction(db, () => setSetting(db, 'referrer_backfill:tables', 'stale'));
    const result = await runReferrerBackfill(db);
    expect(result.completed).toBe(true);
    expect(getSetting(db, 'referrer_backfill:tables')).toBe(stamped);
    db.close();
  });
});
