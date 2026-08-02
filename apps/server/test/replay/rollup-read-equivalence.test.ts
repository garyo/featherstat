import {
  type Bucket,
  DAY_MS,
  type Dimension,
  type FilterNode,
  isQueryError,
  MetricSchema,
  type ResultRow,
  type SiteWindow,
} from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSite,
  type Db,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../../src/db/index.ts';
import {
  type CompilableMetricQuery,
  compileMetricQuery,
  queryMeasures,
} from '../../src/query/compiler.ts';
import { resolveSiteWindows, runCompiled } from '../../src/query/executor.ts';
import { planMetricRoute } from '../../src/query/planner.ts';
import { compileRollupMetricQuery } from '../../src/query/rollup-compiler.ts';
import { rebuildRollupDay } from '../../src/rollup/rebuild.ts';
import { binId, event, session } from '../rows.ts';
import { generateCorpus } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * The READ half of the rollup ratchet (docs/03 § Rollups, CLAUDE.md invariant
 * 6): for every query shape the planner routes to rollups, forced-rollup and
 * forced-raw execution over the real replay corpus must return identical rows
 * AND an identical `measures` header. The matrix is machine-generated — every
 * metric × dimension × bucket, plus the filter shapes — so a new metric or
 * dimension is in the net the day it lands.
 *
 * Shapes the planner routes to raw are asserted as decisions, not executed
 * twice; the uid suite at the bottom proves the sharpest of those rules
 * (distinct counts never sum across days) would actually produce a WRONG
 * number if the planner ever relaxed it.
 */

const corpus = generateCorpus();

/** Midday of the corpus's last day, exactly as read.ts pins the bench clock. */
const NOW = corpus.endMs - 43_200_000;

let db: Db;
let windows90: SiteWindow[];
let windowsOneDay: SiteWindow[];

/** A whole local day well inside the corpus for every timezone in it. */
const ONE_DAY = new Date(corpus.endMs - 5 * DAY_MS).toISOString().slice(0, 10);

beforeAll(() => {
  db = openReplayDb(corpus);
  windows90 = resolveSiteWindows(db, 'all', { preset: '90d' }, NOW);
  windowsOneDay = resolveSiteWindows(db, 'all', { from: ONE_DAY, to: ONE_DAY }, NOW);
}, 180_000);

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// The harness: compile both stores, diff measures byte-for-byte and rows as a
// canonically-ordered set (plus the visible (bucket, first metric) sequence,
// which both stores' ORDER BY pins even where group-key ties do not).
// ---------------------------------------------------------------------------

/** REALs accumulate in different orders per store; verify.ts's tolerance, applied. */
function rounded(row: ResultRow): ResultRow {
  const out: ResultRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'number' ? Number(value.toFixed(6)) : value;
  }
  return out;
}

function canonical(rows: ResultRow[]): ResultRow[] {
  return rows.map(rounded).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function assertEquivalent(
  query: CompilableMetricQuery,
  filters: FilterNode[],
  windows: SiteWindow[],
  label: string,
): void {
  const rollup = compileRollupMetricQuery(query, filters, windows);
  const raw = compileMetricQuery(query, filters, windows);
  if (isQueryError(raw)) {
    throw new Error(`${label}: planner said rollup but raw refused: ${raw.error.message}`);
  }
  // The measures header must be BYTE-identical: a client may never learn which
  // store answered.
  expect(JSON.stringify(queryMeasures(rollup)), label).toBe(JSON.stringify(queryMeasures(raw)));

  const rollupRows = runCompiled(db, rollup, windows);
  const rawRows = runCompiled(db, raw, windows);
  expect(canonical(rollupRows), label).toEqual(canonical(rawRows));
  // Where SQL pins the visible order (time, then leading metric), both stores
  // must present it identically even when full rows tie.
  const first = query.metrics[0] as string;
  const visible = (rows: ResultRow[]): unknown[] =>
    rows.map((row) => [row.bucket ?? null, rounded(row)[first] ?? null]);
  expect(visible(rollupRows), label).toEqual(visible(rawRows));
}

// ---------------------------------------------------------------------------
// Matrix A — every metric × dimension × bucket, unfiltered, 90d over all sites
// ---------------------------------------------------------------------------

const DIMS: readonly (Dimension | undefined)[] = [
  undefined,
  'path', // events-side rolled
  'country', // both-sides rolled
  'ref_domain', // both-sides rolled, NULL-heavy (direct traffic)
  'entry_path', // sessions-side rolled
  'title', // raw-only
  'weekday', // derived
  'site', // derived
  'local_hour', // hour grain
];

const BUCKETS: readonly (Bucket | undefined)[] = [undefined, 'day', 'week', 'month', 'hour'];

describe('rollup read equivalence — metric × dim × bucket over the corpus', () => {
  const shapes: Array<{ query: CompilableMetricQuery; label: string }> = [];
  for (const metric of MetricSchema.options) {
    for (const dim of DIMS) {
      for (const bucket of BUCKETS) {
        shapes.push({
          query: { id: 'q', metrics: [metric], dim, bucket },
          label: `${metric} × ${dim ?? '(none)'} @ ${bucket ?? '(total)'}`,
        });
      }
    }
  }

  it('every rollup-routed shape answers identically from both stores @ 90d', () => {
    let routed = 0;
    for (const { query, label } of shapes) {
      if (planMetricRoute(query, [], windows90) !== 'rollup') continue;
      routed += 1;
      assertEquivalent(query, [], windows90, label);
    }
    // The matrix must actually exercise the rollup path at scale, or a planner
    // that answered 'raw' for everything would pass vacuously.
    expect(routed).toBeGreaterThan(100);
  }, 120_000);

  it('single-day windows unlock the distinct metrics — still identical', () => {
    let routed = 0;
    for (const { query, label } of shapes) {
      if (query.bucket !== undefined) continue;
      if (planMetricRoute(query, [], windowsOneDay) !== 'rollup') continue;
      routed += 1;
      assertEquivalent(query, [], windowsOneDay, `${label} (single day)`);
    }
    expect(routed).toBeGreaterThan(10);
    // The day rule really widened: visitors totals answer from rollups here…
    expect(planMetricRoute({ id: 'q', metrics: ['visitors'] }, [], windowsOneDay)).toBe('rollup');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Matrix B — filter shapes
// ---------------------------------------------------------------------------

const P = '/docs';

const FILTER_SHAPES: ReadonlyArray<{ name: string; filters: FilterNode[] }> = [
  { name: 'eq path', filters: [{ dim: 'path', op: 'eq', value: P }] },
  { name: 'eq country', filters: [{ dim: 'country', op: 'eq', value: 'US' }] },
  { name: 'neq path', filters: [{ dim: 'path', op: 'neq', value: P }] },
  { name: 'in paths', filters: [{ dim: 'path', op: 'in', value: [P, '/pricing'] }] },
  { name: 'starts', filters: [{ dim: 'path', op: 'starts', value: '/doc' }] },
  { name: 'glob', filters: [{ dim: 'path', op: 'glob', value: '/*s' }] },
  { name: 'is_null ref', filters: [{ dim: 'ref_domain', op: 'is_null' }] },
  {
    name: 'any tree',
    filters: [
      {
        any: [
          { dim: 'path', op: 'eq', value: P },
          { dim: 'path', op: 'starts', value: '/p' },
        ],
      },
    ],
  },
  { name: 'not eq', filters: [{ not: { dim: 'path', op: 'eq', value: P } }] },
  { name: 'not is_null', filters: [{ not: { dim: 'ref_domain', op: 'is_null' } }] },
  { name: 'weekday eq', filters: [{ dim: 'weekday', op: 'eq', value: '1' }] },
  { name: 'session scope', filters: [{ dim: 'path', op: 'eq', value: P, scope: 'session' }] },
  {
    name: 'joint dims',
    filters: [
      { dim: 'path', op: 'eq', value: P },
      { dim: 'country', op: 'eq', value: 'US' },
    ],
  },
];

describe('rollup read equivalence — filter shapes', () => {
  it('every rollup-routed filtered shape answers identically from both stores', () => {
    let routed = 0;
    for (const { name, filters } of FILTER_SHAPES) {
      for (const metric of ['pageviews', 'visitors', 'visits', 'bounce_rate'] as const) {
        for (const dim of [undefined, 'path', 'country'] as const) {
          for (const bucket of [undefined, 'day'] as const) {
            const query: CompilableMetricQuery = { id: 'q', metrics: [metric], dim, bucket };
            const label = `${name} | ${metric} × ${dim ?? '(none)'} @ ${bucket ?? '(total)'}`;
            if (planMetricRoute(query, filters, windows90) !== 'rollup') continue;
            routed += 1;
            assertEquivalent(query, filters, windows90, label);
          }
        }
      }
    }
    expect(routed).toBeGreaterThan(30);
  }, 120_000);

  it('a limited breakdown cuts at the same row from both stores', () => {
    // `ORDER BY metric DESC, 1` breaks ties on the dim value, so a dim-only
    // limited breakdown is fully deterministic — LIMIT must not change which
    // rows the two stores agree on.
    const query: CompilableMetricQuery = {
      id: 'q',
      metrics: ['pageviews', 'events'],
      dim: 'path',
      limit: 5,
    };
    expect(planMetricRoute(query, [], windows90)).toBe('rollup');
    assertEquivalent(query, [], windows90, 'path breakdown, limit 5');
  });
});

// ---------------------------------------------------------------------------
// Planner decisions — the shapes whose routing IS the contract
// ---------------------------------------------------------------------------

describe('planner decisions', () => {
  const plan = (
    query: Omit<CompilableMetricQuery, 'id'>,
    filters: FilterNode[] = [],
    windows: SiteWindow[] = windows90,
  ) => planMetricRoute({ id: 'q', ...query }, filters, windows);

  it('routes the distinct metrics by the day rule — never a cross-day sum', () => {
    expect(plan({ metrics: ['visitors'], bucket: 'day' })).toBe('rollup');
    expect(plan({ metrics: ['visitors'], bucket: 'week' })).toBe('raw');
    expect(plan({ metrics: ['visitors'], bucket: 'month' })).toBe('raw');
    expect(plan({ metrics: ['visitors'] })).toBe('raw'); // multi-day total
    expect(plan({ metrics: ['visitors'] }, [], windowsOneDay)).toBe('rollup');
    // The additive metrics do not care.
    expect(plan({ metrics: ['pageviews'], bucket: 'month' })).toBe('rollup');
  });

  it('keeps the hour grain undimensioned', () => {
    expect(plan({ metrics: ['pageviews'], bucket: 'hour' })).toBe('rollup');
    expect(plan({ metrics: ['pageviews'], bucket: 'hour', dim: 'path' })).toBe('raw');
    expect(plan({ metrics: ['visitors'], bucket: 'hour' })).toBe('raw');
    expect(plan({ metrics: ['pageviews'], dim: 'local_hour' })).toBe('rollup');
  });

  it('refuses joints — at most one rolled dimension across grouping and filters', () => {
    expect(
      plan({ metrics: ['pageviews'], dim: 'path' }, [{ dim: 'country', op: 'eq', value: 'US' }]),
    ).toBe('raw');
    expect(
      plan({ metrics: ['pageviews'], dim: 'path' }, [{ dim: 'path', op: 'eq', value: P }]),
    ).toBe('rollup');
    expect(plan({ metrics: ['pageviews'], dim: 'path', dim2: 'country' })).toBe('raw');
  });

  it('sends raw-only dims, session scope, and rolling windows to raw', () => {
    expect(plan({ metrics: ['pageviews'], dim: 'title' })).toBe('raw');
    expect(
      plan({ metrics: ['pageviews'] }, [{ dim: 'path', op: 'eq', value: P, scope: 'session' }]),
    ).toBe('raw');
    const rolling = windows90.map((w) => ({ ...w, fromTs: NOW - DAY_MS, toTs: NOW }));
    expect(plan({ metrics: ['pageviews'] }, [], rolling)).toBe('raw');
    // An unknown-to-ROLLUP_DIMS dimension string falls to raw, fail-safe.
    expect(plan({ metrics: ['pageviews'], dim: 'prop:plan' as Dimension })).toBe('raw');
  });

  it('suspends the session side while rollup_meta says needs_rebuild', () => {
    const stale = { sessionRollupsStale: true };
    expect(planMetricRoute({ id: 'q', metrics: ['bounce_rate'] }, [], windows90, stale)).toBe(
      'raw',
    );
    expect(planMetricRoute({ id: 'q', metrics: ['pageviews'] }, [], windows90, stale)).toBe(
      'rollup',
    );
  });
});

// ---------------------------------------------------------------------------
// The uid-stable visitor: the reason the day rule can never be "optimized"
// ---------------------------------------------------------------------------

describe('uid-stable visitors across days', () => {
  it('a rollup sum over days counts the returning visitor twice — raw does not', () => {
    const uidDb = openDb(':memory:');
    withWriteTransaction(uidDb, () => {
      createSite(uidDb, { id: 1, name: 'one', domains: ['one.test'] });
      // One visitor (uid-style stable id) acting on two consecutive days.
      const days = ['2023-11-14', '2023-11-15'];
      insertEvents(
        uidDb,
        days.map((local_date, i) =>
          event({
            local_date,
            ts: 1_700_000_000_000 + i * DAY_MS,
            session_id: binId(i + 1),
            seq: 1,
          }),
        ),
      );
      upsertSessions(
        uidDb,
        days.map((local_date, i) =>
          session({ id: binId(i + 1), local_date, started_at: 1_700_000_000_000 + i * DAY_MS }),
        ),
      );
      for (const local_date of days) rebuildRollupDay(uidDb, 1, local_date);
    });

    const uidWindows: SiteWindow[] = [
      { siteId: 1, timezone: 'UTC', from: '2023-11-14', to: '2023-11-15' },
    ];
    const query: CompilableMetricQuery = { id: 'q', metrics: ['visitors'] };

    // The planner refuses the rollup route for the range total…
    expect(planMetricRoute(query, [], uidWindows)).toBe('raw');

    // …and it must, because the two stores genuinely disagree here: the raw
    // distinct sees ONE visitor, a sum of exact per-day distincts sees two.
    const raw = compileMetricQuery(query, [], uidWindows);
    if (isQueryError(raw)) throw new Error('raw refused');
    const forcedRollup = compileRollupMetricQuery(query, [], uidWindows);
    expect(runCompiled(uidDb, raw, uidWindows)).toEqual([{ visitors: 1 }]);
    expect(runCompiled(uidDb, forcedRollup, uidWindows)).toEqual([{ visitors: 2 }]);
    uidDb.close();
  });
});
