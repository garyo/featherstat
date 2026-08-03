import {
  type BucketValues,
  type Measure,
  type Measures,
  type Metric,
  measurePerBucket,
  type ResultRow,
  type Unit,
} from '@featherstat/shared';
import { exactNumber, formatDuration, formatMeasure } from './format.ts';
import { type SeriesPoint, sliceRanges } from './series.ts';

/**
 * The KPI tile catalog: which metric each stat reads, how its delta vs the
 * compare row is worded, and how its 12-point sparkline is reduced from the
 * companion bucketed series.
 *
 * A tile knows three things — its metric, its label, and whether up is good.
 * Everything else comes off the result's `measures` header (docs/04 § 3): the
 * unit decides how the number is written and how a delta reads, and the
 * aggregate decides how a run of buckets reduces to one spark point. That is
 * deliberate. The tile used to carry its own arithmetic, and it carried it
 * twice — two avg-engagement divisions ten lines apart with different null
 * semantics, and a bounce rate the tile wrote as 0–1 while its own sparkline
 * computed 0–100.
 *
 * Deltas are signed with an arrow glyph and toned by direction × goodness
 * (docs/05 § Numbers: bounce-rate down is green), so color never carries the
 * sign alone.
 */

export type Tone = 'up' | 'down' | 'muted';

export interface TileModel {
  name: string;
  label: string;
  value: string;
  /** Exact value for the tooltip when `value` is compacted. */
  exact: string | undefined;
  delta: { text: string; tone: Tone };
  spark: number[];
  /**
   * True when the measure is a distinct count, which is exact within a day and
   * an approximation over a longer range (docs/03 § Visitor identity). Derived
   * from the declaration, so it follows the aggregate rather than a metric name.
   */
  approximate: boolean;
}

interface TileDef {
  label: string;
  metric: Metric;
  goodWhenUp: boolean;
}

const MINUS = '−';
const sign = (value: number): string => (value < 0 ? MINUS : '+');

interface Delta {
  text: string;
  dir: number;
}

/** How a change reads, per unit — a count moves by percent, a duration by time. */
const DELTAS: Record<Unit, (cur: number, prev: number) => Delta> = {
  count: percentDelta,
  value: percentDelta,
  ms: (cur, prev) => {
    const diff = cur - prev;
    if (Math.round(Math.abs(diff) / 1000) === 0) return { text: '±0s', dir: 0 };
    return { text: `${sign(diff)}${formatDuration(Math.abs(diff))}`, dir: Math.sign(diff) };
  },
  // A rate moves by percentage POINTS, which is why the server keeps it in 0–1:
  // the difference of two fractions is meaningless once each has been scaled.
  rate: (cur, prev) => {
    const pt = (cur - prev) * 100;
    if (Math.abs(pt) < 0.05) return { text: '±0 pt', dir: 0 };
    return { text: `${sign(pt)}${Math.abs(pt).toFixed(1)} pt`, dir: Math.sign(pt) };
  },
};

function percentDelta(cur: number, prev: number): Delta {
  // cur === 0 is "no traffic YET" on partial days (today) — a red −100% there is
  // noise; a delta needs both sides (site cards use the same rule).
  if (prev <= 0 || cur === 0) return { text: '—', dir: 0 };
  const pct = ((cur - prev) / prev) * 100;
  return { text: `${sign(pct)}${Math.abs(pct).toFixed(1)}%`, dir: Math.sign(pct) };
}

const TILES: Record<string, TileDef> = {
  visitors: { label: 'Visitors', metric: 'visitors', goodWhenUp: true },
  pageviews: { label: 'Pageviews', metric: 'pageviews', goodWhenUp: true },
  visits: { label: 'Visits', metric: 'visits', goodWhenUp: true },
  events: { label: 'Events', metric: 'events', goodWhenUp: true },
  avg_engagement: { label: 'Avg engagement', metric: 'avg_engagement', goodWhenUp: true },
  views_per_visit: { label: 'Views / visit', metric: 'views_per_visit', goodWhenUp: true },
  bounce_rate: { label: 'Bounce rate', metric: 'bounce_rate', goodWhenUp: false },
};

const DEFAULT_TILES = ['visitors', 'pageviews', 'avg_engagement', 'bounce_rate'];

/** Tile names from widget options, unknown names dropped; the docs/05 quartet by default. */
export function tileNames(options: Record<string, unknown>): string[] {
  const raw = options.tiles;
  const names = Array.isArray(raw)
    ? raw.filter((name): name is string => typeof name === 'string' && name in TILES)
    : [];
  return names.length > 0 ? names : DEFAULT_TILES;
}

export function tileLabel(name: string): string {
  return TILES[name]?.label ?? name;
}

export interface TileInput {
  totals: ResultRow | undefined;
  compare: ResultRow | undefined;
  /** The bucketed companion, for the sparklines. */
  series: readonly SeriesPoint[];
  /** What the result said its columns mean; without it a tile cannot read one. */
  measures: Measures | undefined;
}

export function tileModels(names: readonly string[], input: TileInput): TileModel[] {
  const slices = sliceRanges(input.series.length, 12).map(([from, to]) =>
    input.series.slice(from, to).map((point) => point.values),
  );
  const models: TileModel[] = [];
  for (const name of names) {
    const def = TILES[name];
    if (def === undefined) continue;
    const measure = input.measures?.[def.metric];
    models.push(
      measure === undefined ? blank(name, def) : model(name, def, measure, input, slices),
    );
  }
  return models;
}

function model(
  name: string,
  def: TileDef,
  measure: Measure,
  input: TileInput,
  slices: readonly (readonly BucketValues[])[],
): TileModel {
  const cur = answered(input.totals, def.metric);
  const prev = answered(input.compare, def.metric);
  const delta =
    cur !== undefined && prev !== undefined ? DELTAS[measure.unit](cur, prev) : undefined;
  return {
    name,
    label: def.label,
    value: cur === undefined ? '—' : formatMeasure(measure.unit, cur),
    exact: cur !== undefined && measure.unit === 'count' ? exactNumber(cur) : undefined,
    delta:
      delta === undefined || delta.dir === 0
        ? { text: delta?.text ?? '—', tone: 'muted' }
        : {
            text: `${delta.dir > 0 ? '▴' : '▾'} ${delta.text}`,
            tone: delta.dir > 0 === def.goodWhenUp ? 'up' : 'down',
          },
    spark: sparkOf(def.metric, measure, slices),
    approximate: measure.aggregate === 'distinct',
  };
}

/**
 * The sparkline: one point per slice, each the measure's value for ONE bucket of
 * that slice, never the slice's total. That is what makes the reduction legal
 * for every aggregate — a distinct count has no total across buckets at all
 * (defect 13), and a rate re-divides its declared components rather than
 * averaging averages.
 *
 * A slice the measure cannot reduce drops the whole sparkline rather than
 * drawing a hole: a line with a fabricated point in it is worse than no line.
 */
function sparkOf(
  metric: Metric,
  measure: Measure,
  slices: readonly (readonly BucketValues[])[],
): number[] {
  const points: number[] = [];
  for (const slice of slices) {
    const point = measurePerBucket(metric, measure, slice);
    if (point === undefined) return [];
    points.push(point);
  }
  return points;
}

/**
 * A tile whose metric the result did not answer — an event-level filter trimmed
 * it (docs/04 § 3), or a stored layout predates it. '—' is the honest reading;
 * a 0 would claim the traffic was measured and found empty.
 */
function blank(name: string, def: TileDef): TileModel {
  return {
    name,
    label: def.label,
    value: '—',
    exact: undefined,
    delta: { text: '—', tone: 'muted' },
    spark: [],
    approximate: false,
  };
}

/** A metric the row did not answer is unknown, never 0. */
function answered(row: ResultRow | undefined, metric: Metric): number | undefined {
  const value = row?.[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
