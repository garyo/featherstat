import {
  type Aggregate,
  type Filter,
  type Metric,
  MetricSchema,
  type QueryRequest,
  type ResultRow,
} from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { measureOf, preferredTable } from '../../src/query/compiler.ts';
import { executeQueryRequest } from '../../src/query/executor.ts';
import { resultOf } from '../rows.ts';
import { generateCorpus } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * Invariants over the replay corpus: statements that must hold for ANY corpus and
 * ANY implementation, so they keep their grip while the metric, window and widget
 * layers are rebuilt underneath them.
 *
 * The sibling suites (replay, query, dwell, journeys) assert *values* — this one
 * asserts *impossible states*. That is the whole point: an expected-value test
 * re-derives the implementation and moves with it, so a metric bug that is wrong
 * in both the code and the fixture is invisible to it. Nothing here knows what
 * the right number is; it only knows which orderings, sums and bounds cannot be
 * violated without the answer being nonsense.
 *
 * Two rules keep it hard to fool:
 *
 * - Every check runs over a sweep of sites × windows (a day, a week, a month, the
 *   whole corpus, each site and `site: "all"`), never one hand-picked scope.
 * - Where a bound could pass vacuously — an inequality that is always an
 *   equality, a filter that never removes anything — the suite also asserts that
 *   the slack was exercised somewhere in the sweep.
 */

const corpus = generateCorpus();

let db: Db;

beforeAll(() => {
  db = openReplayDb(corpus);
}, 120_000);

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

interface Scope {
  label: string;
  site: number | 'all';
  from: string;
  to: string;
  /** The window that holds the entire corpus — where the rarer slack is guaranteed to appear. */
  whole: boolean;
}

/**
 * Explicit windows, never presets: a preset resolves per site timezone, so an
 * all-sites query would compare six different windows and the independent SQL
 * check below would have no single window to reproduce. `full` is wide enough to
 * hold every local date the corpus can produce, in any site timezone.
 */
const WINDOWS = [
  { label: 'day', from: '2026-03-11', to: '2026-03-11', whole: false },
  { label: '7d', from: '2026-03-09', to: '2026-03-15', whole: false },
  { label: '30d', from: '2026-03-01', to: '2026-03-30', whole: false },
  { label: 'full', from: '2026-02-14', to: '2026-05-17', whole: true },
] as const;

/** A window the corpus cannot reach — the empty-denominator case. */
const EMPTY_WINDOW = { from: '2026-01-01', to: '2026-01-31' } as const;

const SCOPES: Scope[] = WINDOWS.flatMap((window) =>
  [...corpus.sites.map((site) => site.id), 'all' as const].map((site) => ({
    label: `site ${site} / ${window.label}`,
    site,
    from: window.from,
    to: window.to,
    whole: window.whole,
  })),
);

function ask(scope: Scope, queries: QueryRequest['queries']) {
  return executeQueryRequest(db, {
    site: scope.site,
    range: { from: scope.from, to: scope.to },
    queries,
  });
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The countable things a visitor did. A ping is not one of them: it reports that a page is still open. */
const ACTIONS = [
  'pageviews',
  'events',
  'outlinks',
  'downloads',
] as const satisfies readonly Metric[];

/**
 * How each metric composes across buckets. This used to be a hand-written table
 * beside a note that a later phase would move it into the metric definitions and
 * that this suite would prove the move correct. That phase landed (P2): the
 * knowledge now lives in the compiler's own declarations and rides the wire as
 * each result's `measures` header, and what remains here is the proof — the
 * declared aggregate, asserted against the real engine over the whole sweep.
 *
 * The names moved with it (`additive` → `sum`, the vocabulary the header speaks):
 *
 * - `sum`: the ungrouped total is exactly the sum over `bucket: 'day'` rows.
 * - `distinct`: a distinct count. The total is at most the bucket sum (one person
 *   active on two days is one visitor overall but two across buckets) and at
 *   least any single bucket.
 * - `ratio`: a quotient. It neither sums nor bounds a bucket — averaging averages
 *   is a lie — so additivity says nothing about it and invariant 6 owns its range.
 *
 * `visits` is the entry worth reading twice. It is declared `sum` over
 * `sessions`, where a visit belongs to exactly one local date, and `distinct`
 * over `events`, where a visit crossing local midnight lands in two buckets. The
 * additivity queries below carry no event-level dimension, so `preferredTable`
 * is the routing they actually get — and the header would have said so either
 * way.
 */
const AGGREGATE = Object.fromEntries(
  MetricSchema.options.map((metric) => [
    metric,
    measureOf(metric, preferredTable(metric)).aggregate,
  ]),
) as Record<Metric, Aggregate>;

const ADDITIVE = MetricSchema.options.filter((metric) => AGGREGATE[metric] === 'sum');

/** Additive metrics the events table answers — the breakdown side of invariant 8. */
const EVENT_ADDITIVE = [
  'pageviews',
  'events',
  'outlinks',
  'downloads',
  'event_value_sum',
] as const satisfies readonly Metric[];

/** Additive metrics the sessions table answers. */
const SESSION_ADDITIVE = [
  'visits',
  'engaged_ms',
  'engaged_sessions',
] as const satisfies readonly Metric[];

const EVENT_METRICS = [
  'visitors',
  ...ACTIONS,
  'event_value_sum',
] as const satisfies readonly Metric[];

// ---------------------------------------------------------------------------
// Row accessors — a metric that comes back the wrong shape is itself a failure
// ---------------------------------------------------------------------------

function num(row: ResultRow | undefined, metric: string, label: string): number {
  const value = row?.[metric];
  if (typeof value !== 'number') {
    throw new Error(`${label}: '${metric}' should be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A ratio metric: a number, or `null` when its denominator was empty. Never anything else. */
function ratio(row: ResultRow | undefined, metric: string, label: string): number | null {
  const value = row?.[metric];
  if (value === null) return null;
  if (typeof value !== 'number') {
    throw new Error(
      `${label}: '${metric}' should be a number or null, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function actionsOf(row: ResultRow | undefined, label: string): number {
  return ACTIONS.reduce((sum, metric) => sum + num(row, metric, label), 0);
}

function sumOf(rows: readonly ResultRow[], metric: string, label: string): number {
  return rows.reduce((sum, row) => sum + num(row, metric, label), 0);
}

// ---------------------------------------------------------------------------

describe('replay corpus invariants', () => {
  it('1. a population never exceeds the actions it was counted from', () => {
    // A distinct-visitor count is drawn from rows that record something a person
    // did; it cannot exceed the number of those rows. If it does, the population
    // and the actions were counted over different row sets — which is precisely
    // how a heartbeat leaks into a headline number.
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'total', metrics: ['visitors', ...ACTIONS] },
        { id: 'days', metrics: ['visitors', ...ACTIONS], bucket: 'day' },
        { id: 'paths', metrics: ['visitors', ...ACTIONS], dim: 'path' },
      ]);
      for (const id of ['total', 'days', 'paths']) {
        for (const row of resultOf(response, id).rows) {
          const label = `${scope.label} ${id}`;
          expect(num(row, 'visitors', label), `${label} visitors <= actions`).toBeLessThanOrEqual(
            actionsOf(row, label),
          );
        }
      }
    }
  });

  it('1b. under an event-level dimension a visit has a visitor and an action', () => {
    // `visitors` and `visits` are both distinct counts over the SAME event rows
    // once an event-level dimension forces the query onto the events table. Every
    // session has exactly one visitor, so visitors <= visits; and neither can
    // exceed the actions in the group, because both are distinct counts over rows
    // that are themselves actions. A group reporting a visit with no visitor and
    // no action is an impossible state: it means the two populations were drawn
    // from different rows — the heartbeat set for one, the acting set for the other.
    for (const scope of SCOPES) {
      const response = ask(scope, [
        {
          id: 'hours',
          metrics: ['visitors', 'visits', ...ACTIONS],
          dim: 'local_hour',
          bucket: 'day',
        },
        { id: 'paths', metrics: ['visitors', 'visits', ...ACTIONS], dim: 'path', bucket: 'day' },
        { id: 'titles', metrics: ['visitors', 'visits', ...ACTIONS], dim: 'title' },
      ]);
      for (const id of ['hours', 'paths', 'titles']) {
        for (const row of resultOf(response, id).rows) {
          const label = `${scope.label} ${id} ${JSON.stringify(row)}`;
          const visits = num(row, 'visits', label);
          expect(num(row, 'visitors', label), `${label} visitors <= visits`).toBeLessThanOrEqual(
            visits,
          );
          expect(visits, `${label} visits <= actions`).toBeLessThanOrEqual(actionsOf(row, label));
        }
      }
    }
  });

  it('1c. every stored visit holds at least one action', () => {
    // The session-table side of the same idea, and the reason ungrouped `visits`
    // is not compared against actions above: a visit is dated by where it started,
    // an action by when it happened, so a visit that crosses local midnight would
    // legitimately break the comparison inside a window.
    //
    // What cannot happen in any window is a visit with no action ANYWHERE in it.
    // A heartbeat reports that a page is still open; it can continue a visit, so a
    // visit whose every row is a heartbeat is a visit nobody made. This counts
    // straight from the tables, with no compiler in the path.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) FROM sessions s
             WHERE NOT EXISTS (
               SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type != 'ping'
             )`,
        )
        .pluck()
        .get(),
      'a visit whose every row is a heartbeat',
    ).toBe(0);
    // And the corpus does contain heartbeats, so that is not vacuous.
    expect(
      db.prepare("SELECT COUNT(*) FROM events WHERE type = 'ping'").pluck().get(),
    ).toBeGreaterThan(0);
  });

  it('2. every visitor counted has at least one non-ping row', () => {
    // The honest form of the ordering. `pageviews >= visitors` is NOT asserted
    // and does not hold in general: a visit whose only action is an outlink or a
    // server-side event has a visitor and no pageview at all, so any window can
    // legitimately report more visitors than pageviews.
    //
    // What must hold is that the visitor population is drawn from rows that
    // record an action. This counts that population straight from the table, with
    // no compiler in the path, and asserts the engine never claims more.
    let sawTraffic = false;
    for (const scope of SCOPES) {
      const label = `${scope.label} visitors`;
      const reported = num(
        resultOf(ask(scope, [{ id: 'q', metrics: ['visitors'] }]), 'q').rows[0],
        'visitors',
        label,
      );
      expect(reported, label).toBeLessThanOrEqual(actingVisitors(scope));
      if (reported > 0) sawTraffic = true;
    }
    expect(sawTraffic, 'the sweep must contain visitors, or it proves nothing').toBe(true);
  });

  it('3. engaged_sessions never exceeds visits — a measurable visit is a visit', () => {
    // engaged_sessions is the subset of visits with time on the clock (docs/03);
    // a subset larger than its set means the two were counted over different rows.
    let sawUnmeasurable = false;
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'total', metrics: ['visits', 'engaged_sessions'] },
        { id: 'days', metrics: ['visits', 'engaged_sessions'], bucket: 'day' },
        { id: 'refs', metrics: ['visits', 'engaged_sessions'], dim: 'ref_type' },
      ]);
      for (const id of ['total', 'days', 'refs']) {
        for (const row of resultOf(response, id).rows) {
          const label = `${scope.label} ${id}`;
          const visits = num(row, 'visits', label);
          const engaged = num(row, 'engaged_sessions', label);
          expect(engaged, `${label} engaged_sessions <= visits`).toBeLessThanOrEqual(visits);
          if (engaged < visits) sawUnmeasurable = true;
        }
      }
    }
    // Unmeasurable visits exist, so the bound above is a real constraint and not
    // an identity that would hide a change making every visit "engaged".
    expect(sawUnmeasurable, 'no unmeasurable visit anywhere — the bound is vacuous').toBe(true);
  });

  it('4. dwell never times more page views than there were pageviews', () => {
    // views_measured counts page views the clock could actually reach. Timing
    // more of them than happened would mean the dwell envelope is picking up rows
    // the pageview count cannot see.
    const DEPTH = 200;
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'dwell', kind: 'dwell', limit: DEPTH },
        { id: 'pv', metrics: ['pageviews'] },
      ]);
      const rows = resultOf(response, 'dwell').rows;
      const label = `${scope.label} dwell`;
      // A truncated ranking would make the sum an underestimate and the bound
      // meaningless, so the sweep must never hit the depth limit.
      expect(rows.length, `${label} ranking truncated`).toBeLessThan(DEPTH);
      const measured = sumOf(rows, 'views_measured', label);
      const pageviews = num(resultOf(response, 'pv').rows[0], 'pageviews', label);
      expect(measured, `${label} views_measured <= pageviews`).toBeLessThanOrEqual(pageviews);
      // Over the whole corpus the gap is guaranteed: every visit that left
      // without a second hit has an untimeable page, and there are always some.
      if (scope.whole) {
        expect(measured, `${label} strictly fewer over the full window`).toBeLessThan(pageviews);
        expect(measured, `${label} measured something`).toBeGreaterThan(0);
      }
    }
  });

  it('5. additive metrics sum across day buckets; distinct counts only bound', () => {
    // The bound is asserted over WEEK buckets and over a dimension, not over day
    // buckets. A day bucket is the one grouping where a distinct visitor count is
    // exactly additive — that is invariant 10 below, and asserting `<=` here as
    // well would only re-state it more weakly. A week holds several days and each
    // is a fresh salt, so a reader who comes back on Thursday is two visitors in
    // it; a path is not a day at all, so one visitor reading two articles is
    // counted in both groups.
    let sawReturningVisitor = false;
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'total', metrics: ADDITIVE },
        { id: 'days', metrics: ADDITIVE, bucket: 'day' },
        { id: 'vTotal', metrics: ['visitors'] },
        { id: 'vWeeks', metrics: ['visitors'], bucket: 'week' },
        { id: 'vPaths', metrics: ['visitors'], dim: 'path' },
      ]);
      const total = resultOf(response, 'total').rows[0];
      const days = resultOf(response, 'days').rows;
      for (const metric of ADDITIVE) {
        const label = `${scope.label} ${metric}`;
        expect(num(total, metric, label), `${label} total = sum of days`).toBeCloseTo(
          sumOf(days, metric, label),
          6,
        );
      }

      const label = `${scope.label} visitors`;
      const overall = num(resultOf(response, 'vTotal').rows[0], 'visitors', label);
      for (const id of ['vWeeks', 'vPaths']) {
        const groups = resultOf(response, id).rows.map((row) => num(row, 'visitors', label));
        const summed = groups.reduce((sum, value) => sum + value, 0);
        expect(overall, `${label} ${id} total <= sum of groups`).toBeLessThanOrEqual(summed);
        for (const group of groups) {
          expect(overall, `${label} ${id} total >= any single group`).toBeGreaterThanOrEqual(group);
        }
        if (overall < summed) sawReturningVisitor = true;
      }
    }
    // Someone in the corpus came back in a second week, or read a second page.
    // Without that the `<=` above would be an equality everywhere and would not
    // distinguish a distinct count from an additive one at all.
    expect(sawReturningVisitor, 'no visitor spans two groups — the distinct bound is vacuous').toBe(
      true,
    );
  });

  it('6. ratios stay in range, and are null — never 0 — on an empty denominator', () => {
    const RATIOS = [
      'visits',
      'bounce_rate',
      'views_per_visit',
      'engaged_sessions',
      'avg_engagement',
    ] as const;
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'total', metrics: [...RATIOS] },
        { id: 'days', metrics: [...RATIOS], bucket: 'day' },
        { id: 'refs', metrics: [...RATIOS], dim: 'ref_type' },
      ]);
      for (const id of ['total', 'days', 'refs']) {
        for (const row of resultOf(response, id).rows) {
          const label = `${scope.label} ${id}`;
          const visits = num(row, 'visits', label);
          const bounce = ratio(row, 'bounce_rate', label);
          const perVisit = ratio(row, 'views_per_visit', label);
          // Each ratio is null exactly when ITS OWN denominator is empty — the
          // declared `of.denominator`, not just "no traffic": avg_engagement is
          // per MEASURED visit, so a group of unmeasurable visits has none.
          const engagement = ratio(row, 'avg_engagement', label);
          if (num(row, 'engaged_sessions', label) === 0) {
            expect(engagement, `${label} avg_engagement with no measured visit`).toBeNull();
          } else {
            expect(engagement, `${label} avg_engagement > 0`).toBeGreaterThan(0);
          }
          if (visits === 0) {
            expect(bounce, `${label} bounce_rate on no visits`).toBeNull();
            expect(perVisit, `${label} views_per_visit on no visits`).toBeNull();
            continue;
          }
          // A rate, never a percent: the client formats, the server does not
          // pre-scale. 0.42 here becoming 42 there is a whole class of bug.
          expect(bounce, `${label} bounce_rate >= 0`).toBeGreaterThanOrEqual(0);
          expect(bounce, `${label} bounce_rate <= 1`).toBeLessThanOrEqual(1);
          expect(perVisit, `${label} views_per_visit >= 0`).toBeGreaterThanOrEqual(0);
        }
      }
    }

    // The empty denominator itself. Zero would be a fabricated answer — the
    // padding the client once did for the server, and the reason this is asserted
    // rather than assumed.
    for (const site of corpus.sites) {
      const empty: Scope = {
        label: `site ${site.id} / empty`,
        site: site.id,
        whole: false,
        ...EMPTY_WINDOW,
      };
      const row = resultOf(ask(empty, [{ id: 'q', metrics: [...RATIOS] }]), 'q').rows[0];
      expect(num(row, 'visits', empty.label)).toBe(0);
      expect(row?.bounce_rate, `${empty.label} bounce_rate`).toBeNull();
      expect(row?.views_per_visit, `${empty.label} views_per_visit`).toBeNull();
      expect(row?.avg_engagement, `${empty.label} avg_engagement`).toBeNull();
    }
  });

  it('9. every result declares its measures, and a ratio really is its components', () => {
    // The measures header is the contract the client re-aggregates against
    // (docs/04 § 3), so two things have to hold of every answer: it declares one
    // measure per metric it returned, and where that measure claims components,
    // the components multiply back to the value. A ratio whose declared
    // numerator/denominator do NOT reproduce it would send every sparkline in
    // the app off on its own arithmetic again.
    let sawEngagement = false;
    for (const scope of SCOPES) {
      const metrics: Metric[] = ['visits', 'engaged_ms', 'engaged_sessions', 'avg_engagement'];
      const response = ask(scope, [
        { id: 'total', metrics },
        { id: 'days', metrics, bucket: 'day' },
        { id: 'refs', metrics, dim: 'ref_type' },
      ]);
      for (const id of ['total', 'days', 'refs']) {
        const result = resultOf(response, id);
        const measures = result.measures ?? {};
        expect(Object.keys(measures).sort(), `${scope.label} ${id} measures`).toEqual(
          [...metrics].sort(),
        );
        const of = measures.avg_engagement?.of;
        expect(of, `${scope.label} ${id} avg_engagement components`).toEqual({
          numerator: 'engaged_ms',
          denominator: 'engaged_sessions',
        });
        if (of === undefined) continue;
        for (const row of result.rows) {
          const label = `${scope.label} ${id}`;
          const value = ratio(row, 'avg_engagement', label);
          if (value === null) continue;
          sawEngagement = true;
          expect(
            value * num(row, of.denominator, label),
            `${label} avg_engagement × ${of.denominator} = ${of.numerator}`,
          ).toBeCloseTo(num(row, of.numerator ?? '', label), 3);
        }
      }
    }
    expect(sawEngagement, 'no group had measurable engagement — the check is vacuous').toBe(true);
  });

  it('7. a filter can only remove — it never adds', () => {
    /**
     * Both sides of every comparison stay on the same table. The cross-table case
     * (`visits` unfiltered from `sessions`, filtered onto `events` by an
     * event-only dimension) is deliberately NOT asserted: `sessions` dates a
     * visit by where it started and `events` by when each row happened, so a
     * visit that crosses local midnight is legitimately in one window and not the
     * other. That is a scoping difference, not a monotonicity break, and folding
     * it in here would make the invariant lie.
     */
    const EVENT_FILTERS: Filter[] = [
      { dim: 'path', op: 'starts', value: '/d' },
      { dim: 'lang', op: 'eq', value: 'en-us' },
      { dim: 'country', op: 'is_null' },
    ];
    const SESSION_FILTERS: Filter[] = [
      { dim: 'ref_type', op: 'eq', value: 'search' },
      { dim: 'device_type', op: 'eq', value: 'desktop' },
      { dim: 'country', op: 'is_null' },
    ];
    let sawRemoval = false;

    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'events', metrics: [...EVENT_METRICS] },
        { id: 'sessions', metrics: [...SESSION_ADDITIVE] },
        ...EVENT_FILTERS.map((filter, i) => ({
          id: `events${i}`,
          metrics: [...EVENT_METRICS],
          filters: [filter],
        })),
        ...SESSION_FILTERS.map((filter, i) => ({
          id: `sessions${i}`,
          metrics: [...SESSION_ADDITIVE],
          filters: [filter],
        })),
      ]);

      const compare = (base: string, id: string, metrics: readonly Metric[]): void => {
        const unfiltered = resultOf(response, base).rows[0];
        const filtered = resultOf(response, id).rows[0];
        for (const metric of metrics) {
          const label = `${scope.label} ${id} ${metric}`;
          const before = num(unfiltered, metric, label);
          const after = num(filtered, metric, label);
          expect(after, `${label} filtered <= unfiltered`).toBeLessThanOrEqual(before);
          if (after < before) sawRemoval = true;
        }
      };
      EVENT_FILTERS.forEach((_, i) => {
        compare('events', `events${i}`, EVENT_METRICS);
      });
      SESSION_FILTERS.forEach((_, i) => {
        compare('sessions', `sessions${i}`, SESSION_ADDITIVE);
      });
    }
    expect(sawRemoval, 'no filter removed anything — the bound is vacuous').toBe(true);
  });

  it('8. a full breakdown conserves an additive total', () => {
    // Every row belongs to exactly one group of a single dimension, including the
    // NULL group, so the breakdown must add back up to the ungrouped total.
    // Losing the NULL group is the classic way a breakdown quietly under-reports.
    let sawNullGroup = false;
    for (const scope of SCOPES) {
      const response = ask(scope, [
        { id: 'eTotal', metrics: [...EVENT_ADDITIVE] },
        { id: 'byPath', metrics: [...EVENT_ADDITIVE], dim: 'path' },
        { id: 'byCountry', metrics: [...EVENT_ADDITIVE], dim: 'country' },
        { id: 'bySite', metrics: [...EVENT_ADDITIVE], dim: 'site' },
        { id: 'sTotal', metrics: [...SESSION_ADDITIVE] },
        { id: 'byRefType', metrics: [...SESSION_ADDITIVE], dim: 'ref_type' },
      ]);

      const conserves = (
        totalId: string,
        breakdownId: string,
        metrics: readonly Metric[],
      ): void => {
        const total = resultOf(response, totalId).rows[0];
        const rows = resultOf(response, breakdownId).rows;
        for (const metric of metrics) {
          const label = `${scope.label} ${breakdownId} ${metric}`;
          expect(num(total, metric, label), `${label} breakdown = total`).toBeCloseTo(
            sumOf(rows, metric, label),
            6,
          );
        }
      };
      conserves('eTotal', 'byPath', EVENT_ADDITIVE);
      conserves('eTotal', 'byCountry', EVENT_ADDITIVE);
      conserves('eTotal', 'bySite', EVENT_ADDITIVE);
      conserves('sTotal', 'byRefType', SESSION_ADDITIVE);

      const dims = ['byPath', 'byCountry'];
      for (const id of dims) {
        const key = id === 'byPath' ? 'path' : 'country';
        if (resultOf(response, id).rows.some((row) => row[key] === null)) sawNullGroup = true;
      }
    }
    // A NULL group really occurs in the sweep, so "conserves the total" is
    // actually testing that the breakdown keeps it.
    expect(sawNullGroup, 'no NULL group in any breakdown — conservation proves less').toBe(true);
  });

  it('10. a range of visitors is exactly the sum of its local days', () => {
    /**
     * The alignment invariant. `visitor_id` is minted under a salt that rotates
     * at SITE-LOCAL midnight (docs/03), the same boundary `local_date` is
     * bucketed on, so every id belongs to exactly one of the days a dashboard
     * draws — and the range total and the day-by-day breakdown of the same
     * distinct count have to agree to the visitor.
     *
     * This is the strongest available statement that the boundary really moved.
     * A `<=` bound holds under any rotation whatsoever, so it could not tell an
     * aligned boundary from a misaligned one; equality can only hold if no id
     * ever appears under two dates. Both the engine's answer and a plain SQL
     * count are checked, because a compiler that grouped on something other than
     * `local_date` would satisfy one and not the other.
     *
     * (Sites that opt into `uid` hashing get a stable per-site salt and are the
     * documented exception — their ids deliberately span days. No corpus site
     * opts in, and the KPI's approximation mark exists for that case.)
     */
    for (const scope of SCOPES) {
      const label = `${scope.label} visitors`;
      const response = ask(scope, [
        { id: 'total', metrics: ['visitors'] },
        { id: 'days', metrics: ['visitors'], bucket: 'day' },
      ]);
      const overall = num(resultOf(response, 'total').rows[0], 'visitors', label);
      const summed = sumOf(resultOf(response, 'days').rows, 'visitors', label);
      expect(overall, `${label} total = sum of local days`).toBe(summed);
      expect(overall, `${label} engine agrees with the table`).toBe(actingVisitors(scope));
    }

    // Anti-vacuity, and the sharpest form of it available: the SAME corpus is NOT
    // additive over UTC days. Visitors really do straddle midnight here — the
    // equality above is the boundary being aligned, not a corpus where nobody
    // spans a day. `local_date BETWEEN` scopes both sums to the same rows, so the
    // only thing that differs is which midnight groups them.
    const total = actingVisitors(WHOLE_CORPUS);
    expect(total, 'the corpus has visitors, or none of this proves anything').toBeGreaterThan(0);
    expect(
      sumOverUtcDays(WHOLE_CORPUS),
      'UTC days over-count — the boundary matters',
    ).toBeGreaterThan(total);
  });
});

/** The full window across every site — where the day-straddling traffic is guaranteed. */
const WHOLE_CORPUS: Scope = { ...WINDOWS[3], label: 'all sites / full', site: 'all', whole: true };

/**
 * The same distinct count as `actingVisitors`, grouped on the UTC date of `ts`
 * instead of the site-local date, and summed. Over the same rows: only the
 * grouping changes.
 */
function sumOverUtcDays(scope: Scope): number {
  const sql = `SELECT COALESCE(SUM(n), 0) FROM (
       SELECT COUNT(DISTINCT visitor_id) AS n FROM events
        WHERE type != 'ping' AND local_date BETWEEN ? AND ?${scope.site === 'all' ? '' : ' AND site_id = ?'}
        GROUP BY strftime('%Y-%m-%d', ts / 1000, 'unixepoch'))`;
  const params: (string | number)[] = [scope.from, scope.to];
  if (scope.site !== 'all') params.push(scope.site);
  return db
    .prepare(sql)
    .pluck()
    .get(...params) as number;
}

/**
 * The visitor population, counted straight from the rows with no compiler in the
 * path: distinct visitors across the window's non-ping rows. Every window in the
 * sweep is explicit, so one date pair scopes every site the same way.
 */
function actingVisitors(scope: Scope): number {
  const sql = `SELECT COUNT(DISTINCT visitor_id) FROM events
     WHERE type != 'ping' AND local_date BETWEEN ? AND ?${scope.site === 'all' ? '' : ' AND site_id = ?'}`;
  const params: (string | number)[] = [scope.from, scope.to];
  if (scope.site !== 'all') params.push(scope.site);
  return db
    .prepare(sql)
    .pluck()
    .get(...params) as number;
}
