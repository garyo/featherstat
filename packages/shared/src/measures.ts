import type { HitType } from './index.ts';

/**
 * What a number in a result actually counts, and how it may be recombined
 * (docs/03 § Derived metrics, docs/04 § 3).
 *
 * Two ideas, both of which used to live as prose inside a SQL string:
 *
 * - A **population** is the set of stored rows a metric is drawn from. Naming
 *   populations does something subtler than deduplicating a predicate: it turns
 *   an accidental difference into a deliberate one. Realtime's "active now"
 *   counts `presence` — a reader holding a tab open is here — while the
 *   `visitors` KPI counts `actions`, because that reader did not *do* anything
 *   today. Same person, two honest answers; declared, a reviewer can check that
 *   the difference was meant.
 * - An **aggregate** says how the metric composes across buckets. It is the
 *   load-bearing half: a chart that reduces 90 daily points into 12 slices
 *   re-aggregates whatever the server sent, and you cannot average an average.
 *   Sums add, ratios re-weight on their denominator, and distinct counts refuse
 *   to produce a total at all (see `measureTotal`).
 */

// ---------------------------------------------------------------------------
// Heartbeats — the one hit type that is not an action
// ---------------------------------------------------------------------------

/**
 * A heartbeat: a continuation signal reporting that a page is still open, not
 * something a visitor did. Every consumer that used to spell `'ping'` by hand —
 * the query compiler, the sequence and dwell kinds, the realtime hub, the ntfy
 * notifier — reads the definition from here, so "which rows are actions" has
 * exactly one answer in the tree.
 */
export const HEARTBEAT_HIT_TYPE: HitType = 'ping';

export function isHeartbeat(type: HitType): boolean {
  return type === HEARTBEAT_HIT_TYPE;
}

/**
 * Every hit type that records something a visitor did — `HitTypeSchema.options`
 * minus the heartbeat, spelled out because this module must not import a VALUE
 * from `index.ts` (which re-exports it, so the cycle would evaluate this first).
 * `measures.test.ts` holds the two in step.
 */
export const ACTION_HIT_TYPES = [
  'pageview',
  'event',
  'outlink',
  'download',
] as const satisfies readonly HitType[];

// ---------------------------------------------------------------------------
// Populations
// ---------------------------------------------------------------------------

/**
 * Never parsed, only emitted: a measure is the server describing its own answer,
 * so these are plain unions and the `Record`s below are what keeps them
 * exhaustive. Nothing here is a request boundary needing a zod schema.
 */
export type Population =
  | 'presence'
  | 'actions'
  | 'pageviews'
  | 'events'
  | 'outlinks'
  | 'downloads'
  | 'sessions'
  | 'measured_sessions'
  | 'measured_pageviews';

export interface PopulationSpec {
  /** Which stored rows it draws from: hit rows (`events`) or visits (`sessions`). */
  rows: 'hits' | 'visits';
  /**
   * The hit types in it, or `null` for every stored hit. Always `null` for a
   * `visits` population, which has no type of its own.
   */
  hitTypes: readonly HitType[] | null;
  /**
   * True when the population is narrowed further to rows the clock could
   * actually reach: a visit with engaged time on it, a page view something
   * followed. *How* that is selected belongs to whichever query draws the rows
   * (a predicate for visits, a window function for page legs) — naming it here
   * is what lets a reader see that two metrics over "the same" rows are not
   * counting the same thing.
   */
  measured: boolean;
  /** One line a reviewer can hold a metric's definition against. */
  describes: string;
}

export const POPULATIONS: Record<Population, PopulationSpec> = {
  presence: {
    rows: 'hits',
    hitTypes: null,
    measured: false,
    describes: 'every stored hit, heartbeats included — the visitor was here',
  },
  actions: {
    rows: 'hits',
    hitTypes: ACTION_HIT_TYPES,
    measured: false,
    describes: 'every hit that is not a heartbeat — the visitor did something',
  },
  pageviews: { rows: 'hits', hitTypes: ['pageview'], measured: false, describes: 'page views' },
  events: { rows: 'hits', hitTypes: ['event'], measured: false, describes: 'custom events' },
  outlinks: { rows: 'hits', hitTypes: ['outlink'], measured: false, describes: 'outbound clicks' },
  downloads: { rows: 'hits', hitTypes: ['download'], measured: false, describes: 'file downloads' },
  sessions: { rows: 'visits', hitTypes: null, measured: false, describes: 'every stored visit' },
  measured_sessions: {
    rows: 'visits',
    hitTypes: null,
    measured: true,
    describes: 'visits with time on the clock — a single-hit visit is unmeasurable, not 0 s',
  },
  measured_pageviews: {
    rows: 'hits',
    hitTypes: ['pageview'],
    measured: true,
    describes: 'page views something followed, so the gap to it could be timed',
  },
};

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/**
 * What the number is, which decides how it is written and how a delta reads.
 * `rate` is always a fraction in 0–1: the server never pre-scales a percentage,
 * so a tile and its own sparkline cannot end up on different scales.
 */
export type Unit = 'count' | 'ms' | 'rate' | 'value';

/**
 * How the measure composes across buckets.
 *
 * - `sum` — additive: the total is the sum of its buckets.
 * - `distinct` — a distinct count. NOT additive: one person active on two days
 *   is one visitor overall and two across buckets, and the visitor id is salted
 *   per UTC day besides (docs/03 § Visitor identity). It has no total to
 *   recombine, so `measureTotal` refuses to invent one.
 * - `ratio` — a quotient; re-aggregates by re-weighting on `of.denominator`.
 * - `max` — an extremum; the max of the bucket maxima.
 */
export type Aggregate = 'sum' | 'distinct' | 'ratio' | 'max';

/**
 * A ratio's components, named as columns of the SAME result.
 *
 * `denominator` is the load-bearing one: re-aggregating a ratio over buckets is
 * `Σ(vᵢ·dᵢ) / Σdᵢ`, which reconstructs the true numerator whatever it was drawn
 * from. `numerator` names the column that IS the numerator when the result
 * carries one — an exact `Σn/Σd` then avoids the reconstruction — and is absent
 * for a rate whose numerator is not itself in the vocabulary (`bounce_rate`
 * counts bounced visits, which no metric names).
 */
export interface MeasureComponents {
  numerator?: string;
  denominator: string;
}

/** Everything a consumer needs to read one column of a result honestly. */
export interface Measure {
  unit: Unit;
  population: Population;
  aggregate: Aggregate;
  /** Present exactly when `aggregate` is `ratio`. */
  of?: MeasureComponents;
}

/**
 * A result's measures, keyed by column name — declared once per result, never
 * per row: a 1000-row breakdown must not carry 1000 copies of its own schema.
 */
export type Measures = Record<string, Measure>;

/** One bucket's values, as a chart holds them. */
export type BucketValues = Readonly<Record<string, number>>;

/**
 * The measure's value over several buckets, or `undefined` when it HAS none.
 *
 * The undefined is the point. A distinct count cannot be summed across buckets,
 * and the caller has to say what it does about that instead of quietly shipping
 * a number that disagrees with the same label one screen over — which is how
 * the all-sites cards and the KPI tile came to report two different visitor
 * counts (defect 13).
 */
export function measureTotal(
  column: string,
  measure: Measure,
  buckets: readonly BucketValues[],
): number | undefined {
  switch (measure.aggregate) {
    case 'sum':
      return sumOf(column, buckets);
    case 'distinct':
      return undefined;
    case 'max':
      return buckets.length === 0 ? undefined : Math.max(...buckets.map((b) => cellOf(b, column)));
    case 'ratio':
      return ratioOf(column, measure, buckets);
  }
}

/**
 * The measure's typical value for ONE bucket of the run — what a sparkline
 * slice draws.
 *
 * A sparkline shows shape, not a total, so every measure reduces to a
 * per-bucket figure: additive and distinct counts to their mean over the run
 * (average visitors per day, average pageviews per day), rates to their
 * denominator-weighted rate, extrema to the extremum. That makes the reduction
 * legal for `distinct` too — a mean of daily distincts claims nothing about the
 * range — and it drops the sawtooth that summing produced when 90 days split
 * into 12 slices of alternating length.
 */
export function measurePerBucket(
  column: string,
  measure: Measure,
  buckets: readonly BucketValues[],
): number | undefined {
  if (buckets.length === 0) return undefined;
  switch (measure.aggregate) {
    case 'sum':
    case 'distinct':
      return sumOf(column, buckets) / buckets.length;
    case 'max':
    case 'ratio':
      return measureTotal(column, measure, buckets);
  }
}

function ratioOf(
  column: string,
  measure: Measure,
  buckets: readonly BucketValues[],
): number | undefined {
  const of = measure.of;
  if (of === undefined) return undefined;
  const denominator = sumOf(of.denominator, buckets);
  if (denominator === 0) return undefined;
  // Exact when the result carries the numerator; otherwise reconstruct it as
  // value × denominator, which is the same number one multiplication later.
  const numerator = of.numerator;
  if (numerator !== undefined && buckets.every((bucket) => numerator in bucket)) {
    return sumOf(numerator, buckets) / denominator;
  }
  const weighted = buckets.reduce(
    (total, bucket) => total + cellOf(bucket, column) * cellOf(bucket, of.denominator),
    0,
  );
  return weighted / denominator;
}

function sumOf(column: string, buckets: readonly BucketValues[]): number {
  return buckets.reduce((total, bucket) => total + cellOf(bucket, column), 0);
}

/** A missing or non-finite cell contributes nothing — never NaN downstream. */
function cellOf(bucket: BucketValues, column: string): number {
  const value = bucket[column];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
