import type { ResultRow } from '@featherstat/shared';
import { compactNumber, exactNumber, formatDuration } from './format.ts';
import { num, type SeriesPoint, sliceRanges } from './series.ts';

/**
 * The KPI tile catalog: how each stat is derived from the widget's totals row,
 * how its delta vs the compare row is worded, and how its 12-point sparkline is
 * reduced from the companion bucketed series. Deltas are signed with an arrow
 * glyph and toned by direction × goodness (docs/05 § Numbers: bounce-rate down
 * is green), so color never carries the sign alone.
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
}

interface TileDef {
  label: string;
  goodWhenUp: boolean;
  raw(row: ResultRow): number | null;
  format(value: number): string;
  exact?(value: number): string;
  delta(cur: number, prev: number): { text: string; dir: number };
  reduce(slice: readonly SeriesPoint[]): number;
}

const MINUS = '−';
const sign = (value: number): string => (value < 0 ? MINUS : '+');

const sum = (slice: readonly SeriesPoint[], metric: string): number =>
  slice.reduce((total, point) => total + num(point.values[metric]), 0);

function countTile(metric: string, label: string): TileDef {
  return {
    label,
    goodWhenUp: true,
    raw: (row) => num(row[metric]),
    format: compactNumber,
    exact: exactNumber,
    delta: (cur, prev) => {
      // cur === 0 is "no traffic YET" on partial days (today) — a red −100%
      // there is noise; a delta needs both sides (site cards use the same rule).
      if (prev <= 0 || cur === 0) return { text: '—', dir: 0 };
      const pct = ((cur - prev) / prev) * 100;
      return { text: `${sign(pct)}${Math.abs(pct).toFixed(1)}%`, dir: Math.sign(pct) };
    },
    reduce: (slice) => sum(slice, metric),
  };
}

const avgEngagement: TileDef = {
  label: 'Avg engagement',
  goodWhenUp: true,
  raw: (row) => {
    // engaged_ms may be absent entirely (trimmed under an event-level filter,
    // docs/04 § 3) — that is "no answer", never "0s".
    if (typeof row.engaged_ms !== 'number') return null;
    // Over MEASURED visits, not all of them: a single-hit visit has no gap to
    // accrue, and counting it as 0s reports the measurement gap as brevity
    // (the same rule the time-on-page card follows).
    const measured = num(row.engaged_sessions);
    return measured > 0 ? row.engaged_ms / measured : null;
  },
  format: formatDuration,
  delta: (cur, prev) => {
    const diff = cur - prev;
    if (Math.round(Math.abs(diff) / 1000) === 0) return { text: '±0s', dir: 0 };
    return { text: `${sign(diff)}${formatDuration(Math.abs(diff))}`, dir: Math.sign(diff) };
  },
  reduce: (slice) => {
    const measured = sum(slice, 'engaged_sessions');
    return measured > 0 ? sum(slice, 'engaged_ms') / measured : 0;
  },
};

const bounceRate: TileDef = {
  label: 'Bounce rate',
  goodWhenUp: false,
  raw: (row) => (typeof row.bounce_rate === 'number' ? row.bounce_rate : null),
  format: (value) => `${Math.round(value * 100)}%`,
  delta: (cur, prev) => {
    const pt = (cur - prev) * 100;
    if (Math.abs(pt) < 0.05) return { text: '±0 pt', dir: 0 };
    return { text: `${sign(pt)}${Math.abs(pt).toFixed(1)} pt`, dir: Math.sign(pt) };
  },
  // Weighted by visits: a quiet day's rate must not count like a busy one's.
  reduce: (slice) => {
    const visits = sum(slice, 'visits');
    if (visits === 0) return 0;
    const weighted = slice.reduce(
      (total, point) => total + num(point.values.bounce_rate) * num(point.values.visits),
      0,
    );
    return (weighted / visits) * 100;
  },
};

const TILES: Record<string, TileDef> = {
  visitors: countTile('visitors', 'Visitors'),
  pageviews: countTile('pageviews', 'Pageviews'),
  visits: countTile('visits', 'Visits'),
  events: countTile('events', 'Events'),
  avg_engagement: avgEngagement,
  bounce_rate: bounceRate,
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

export function tileModels(
  names: readonly string[],
  totals: ResultRow | undefined,
  compare: ResultRow | undefined,
  series: readonly SeriesPoint[],
): TileModel[] {
  const slices = sliceRanges(series.length, 12).map(([from, to]) => series.slice(from, to));
  const models: TileModel[] = [];
  for (const name of names) {
    const def = TILES[name];
    if (def === undefined) continue;
    const cur = totals === undefined ? null : def.raw(totals);
    const prev = compare === undefined ? null : def.raw(compare);
    const delta = cur !== null && prev !== null ? def.delta(cur, prev) : undefined;
    models.push({
      name,
      label: def.label,
      value: cur === null ? '—' : def.format(cur),
      exact: cur === null ? undefined : def.exact?.(cur),
      delta:
        delta === undefined || delta.dir === 0
          ? { text: delta?.text ?? '—', tone: 'muted' }
          : {
              text: `${delta.dir > 0 ? '▴' : '▾'} ${delta.text}`,
              tone: delta.dir > 0 === def.goodWhenUp ? 'up' : 'down',
            },
      spark: slices.map((slice) => def.reduce(slice)),
    });
  }
  return models;
}
