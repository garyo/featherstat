import type { SiteWindow } from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSite, type Db, openDb, withWriteTransaction } from '../db/index.ts';
import { boundsParams, type CompilableMetricQuery } from './compiler.ts';
import { compileRollupMetricQuery } from './rollup-compiler.ts';

/**
 * The rollup reads' access paths (migration 105). The totals — `dim_id 0`,
 * behind every KPI tile and time series — must be answered from the partial
 * covering index alone; on the primary key they would walk every dimension's
 * rows of every day in the window to find one row per site-day.
 */

const windows: SiteWindow[] = [
  { siteId: 1, timezone: 'UTC', from: '2026-07-01', to: '2026-09-28' },
  { siteId: 2, timezone: 'UTC', from: '2026-07-01', to: '2026-09-28' },
];

let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'] });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'] });
  });
});

afterAll(() => {
  db.close();
});

function plan(query: Omit<CompilableMetricQuery, 'id'>): string[] {
  const compiled = compileRollupMetricQuery({ id: 'q', ...query }, [], windows);
  return compiled.statements.map((statement) =>
    (
      db
        .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...boundsParams(windows), ...statement.params) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | '),
  );
}

describe('rollup read access paths', () => {
  it('answers event totals from the covering totals index', () => {
    for (const bucket of [undefined, 'day', 'month'] as const) {
      expect(plan({ metrics: ['pageviews', 'visitors'], bucket })).toEqual([
        expect.stringContaining('USING COVERING INDEX ix_rollup_dim_day_total'),
      ]);
    }
    // Derived keys read the same rows.
    expect(plan({ metrics: ['pageviews'], dim: 'weekday', dim2: 'site' })).toEqual([
      expect.stringContaining('USING COVERING INDEX ix_rollup_dim_day_total'),
    ]);
  });

  it('answers session totals from the covering totals index', () => {
    expect(plan({ metrics: ['visits', 'bounce_rate', 'avg_engagement'], bucket: 'day' })).toEqual([
      expect.stringContaining('USING COVERING INDEX ix_rollup_sessions_day_total'),
    ]);
  });

  it('leaves a dimension breakdown on the primary key', () => {
    expect(plan({ metrics: ['pageviews'], dim: 'path' })).toEqual([
      expect.stringContaining('USING PRIMARY KEY'),
    ]);
  });
});
