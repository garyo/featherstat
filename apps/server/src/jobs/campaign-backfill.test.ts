import { describe, expect, it } from 'vitest';
import { binId, event, openTestDb, session, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  dataVersion,
  getSetting,
  insertEvents,
  replaceCampaignAliases,
  setSetting,
  stmt,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { requestCampaignBackfill, runCampaignBackfill } from './campaign-backfill.ts';

/**
 * The alias backfill (docs/03 § Campaigns): chunked, watermarked, idempotent —
 * always re-derived from COALESCE(utm_*_raw, utm_*), so any sequence of alias
 * edits converges, and removing an alias restores the canonicalized original.
 */

function seed(db: Db, utm: { source: string | null; sourceRaw?: string | null }): void {
  withWriteTransaction(db, () => {
    insertEvents(db, [
      event({
        utm_source: utm.source,
        utm_source_raw: utm.sourceRaw ?? null,
        utm_medium: 'cpc',
      }),
    ]);
    upsertSessions(db, [
      session({
        utm_source: utm.source,
        utm_source_raw: utm.sourceRaw ?? null,
        utm_medium: 'cpc',
      }),
    ]);
  });
}

interface UtmState {
  utm_source: string | null;
  utm_source_raw: string | null;
}

function stateOf(db: Db, table: 'events' | 'sessions'): UtmState {
  return stmt<UtmState>(db, `SELECT utm_source, utm_source_raw FROM ${table}`).get() as UtmState;
}

function enqueue(db: Db): void {
  withWriteTransaction(db, () => requestCampaignBackfill(db));
}

describe('campaign backfill', () => {
  it('rewrites both tables from the raw base and bumps the epoch', async () => {
    const db = openTestDb();
    seed(db, { source: 'email', sourceRaw: ' Email ' });
    const before = dataVersion(db);
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, 1, [{ field: 'source', alias: 'email', canonical: 'newsletter' }]);
      requestCampaignBackfill(db);
    });
    const result = await runCampaignBackfill(db);
    expect(result.completed).toBe(true);
    expect(result.rows).toBe(2); // one event + one session
    for (const table of ['events', 'sessions'] as const) {
      expect(stateOf(db, table)).toEqual({
        utm_source: 'newsletter',
        utm_source_raw: ' Email ', // the as-received value survives re-aliasing
      });
    }
    expect(dataVersion(db)).toBeGreaterThan(before); // history rewritten → epoch bumped
    expect(getSetting(db, 'campaign_backfill:events')).toBeUndefined();
    expect(getSetting(db, 'campaign_backfill:sessions')).toBeUndefined();
    db.close();
  });

  it('is idempotent, and NULLs raw when value and base agree again', async () => {
    const db = openTestDb();
    // History already rewritten by an earlier alias: current differs from raw.
    seed(db, { source: 'newsletter', sourceRaw: 'email' });
    // The alias is now GONE — the backfill must restore the canonical original.
    enqueue(db);
    await runCampaignBackfill(db);
    expect(stateOf(db, 'events')).toEqual({ utm_source: 'email', utm_source_raw: null });

    const settled = dataVersion(db);
    enqueue(db);
    const again = await runCampaignBackfill(db);
    expect(again.rows).toBe(0); // nothing to change — converged
    expect(dataVersion(db)).toBe(settled); // no rewrite, no epoch bump
    db.close();
  });

  it('resumes across chunks and leaves untouched fields alone', async () => {
    const db = openTestDb();
    withWriteTransaction(db, () => {
      insertEvents(
        db,
        Array.from({ length: 7 }, (_, i) =>
          event({ session_id: binId(i + 10), utm_source: 'Email', utm_campaign: 'keep' }),
        ),
      );
    });
    enqueue(db);
    // Tiny chunks: several transactions must still converge on the same state.
    await runCampaignBackfill(db, { batchSize: 2 });
    const rows = stmt<{ s: string; r: string | null; c: string }>(
      db,
      'SELECT utm_source AS s, utm_source_raw AS r, utm_campaign AS c FROM events',
    ).all() as Array<{ s: string; r: string | null; c: string }>;
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.s).toBe('email'); // canonicalized (no alias rows at all)
      expect(row.r).toBe('Email');
      expect(row.c).toBe('keep');
    }
    db.close();
  });

  it('rebuilds the utm rollup marginals after a rewrite', async () => {
    const db = openTestDb();
    seed(db, { source: 'email' });
    syncRollups(db); // rollups now say utm_source = 'email'
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, 1, [{ field: 'source', alias: 'email', canonical: 'newsletter' }]);
      requestCampaignBackfill(db);
    });
    await runCampaignBackfill(db);
    const values = stmt<string>(
      db,
      'SELECT DISTINCT dim_value FROM rollup_dim_day WHERE dim_id = 5 AND dim_null = 0',
    )
      .pluck()
      .all();
    expect(values).toEqual(['newsletter']);
    db.close();
  });

  it('does nothing when no backfill is enqueued', async () => {
    const db = openTestDb();
    seed(db, { source: 'email' });
    const result = await runCampaignBackfill(db);
    expect(result).toEqual({ completed: false, rows: 0 });
    db.close();
  });
});

describe('the epoch survives a crash mid-rewrite', () => {
  /**
   * Invariant 10's failure mode: a run rewrites rows and dies before its
   * epilogue, and the run that resumes it finds nothing left to change. Gating
   * the bump on rows changed *this run* would skip it, leaving every ETag cut
   * before the rewrite answering 304 over moved history forever.
   */
  it('bumps even when the resuming run changes nothing itself', async () => {
    const db = openTestDb();
    withWriteTransaction(db, () =>
      replaceCampaignAliases(db, 0, [{ field: 'source', alias: 'tw', canonical: 'twitter' }]),
    );
    seed(db, { source: 'tw' });
    withWriteTransaction(db, () => requestCampaignBackfill(db));
    await runCampaignBackfill(db); // the rewrite that lands, and settles
    const settled = dataVersion(db);

    // The crash: rows already rewritten, the epilogue never reached.
    withWriteTransaction(db, () => {
      requestCampaignBackfill(db);
      setSetting(db, 'campaign_backfill:dirty', '1');
    });

    const result = await runCampaignBackfill(db);
    expect(result.rows).toBe(0);
    expect(dataVersion(db)).toBeGreaterThan(settled);
    expect(getSetting(db, 'campaign_backfill:dirty')).toBeUndefined();
    db.close();
  });
});
