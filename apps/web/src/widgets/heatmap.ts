import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/**
 * Hour × weekday heatmap shaping (docs/05, mockup): a `dim: local_hour` ×
 * `dim2: weekday` result becomes a dense 7 × 24 grid in display order
 * (Mon → Sun rows, 0–23 columns). Levels are quantile buckets of the non-zero
 * values — 5 sequential steps on the `--hm` ramp — and zero stays level 0 so
 * empty cells recede to the surface. Quantiles rather than a linear scale:
 * one hot HN hour must not wash every ordinary evening into the same band.
 */

export const HEATMAP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const HEATMAP_HOURS = 24;

/** Quantile cut points of the non-zero distribution; the top step is deliberately rare. */
const QUANTILES = [0.2, 0.4, 0.6, 0.8, 0.93] as const;

export interface HeatmapCell {
  /** Display row, 0 = Monday … 6 = Sunday. */
  day: number;
  hour: number;
  value: number;
  /** 0 (zero, recedes) … 5 (hottest --hm step). */
  level: number;
}

/** Rows → 168 cells in render order (day-major). Unparseable rows are ignored. */
export function heatmapCells(rows: readonly ResultRow[], metric: string): HeatmapCell[] {
  const values = new Array<number>(7 * HEATMAP_HOURS).fill(0);
  for (const row of rows) {
    const hour = asIndex(row.local_hour, HEATMAP_HOURS);
    // The query vocabulary's weekday is strftime('%w'): 0 = Sunday … 6 = Saturday.
    const weekday = asIndex(row.weekday, 7);
    if (hour === undefined || weekday === undefined) continue;
    const day = (weekday + 6) % 7; // display rows start on Monday
    const index = day * HEATMAP_HOURS + hour;
    values[index] = (values[index] ?? 0) + num(row[metric]);
  }

  const thresholds = quantileThresholds(values);
  return values.map((value, index) => ({
    day: Math.floor(index / HEATMAP_HOURS),
    hour: index % HEATMAP_HOURS,
    value,
    // Non-zero cells never recede: the faintest traffic still lands on --hm1.
    level: value === 0 ? 0 : Math.max(1, thresholds.filter((t) => value >= t).length),
  }));
}

/** `Mon 13:00–13:59` — the tooltip title for a cell. */
export function cellTitle(cell: HeatmapCell): string {
  const hh = String(cell.hour).padStart(2, '0');
  return `${HEATMAP_DAYS[cell.day]} ${hh}:00–${hh}:59`;
}

function quantileThresholds(values: readonly number[]): number[] {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  return QUANTILES.map((q) => sorted[Math.floor(q * (sorted.length - 1))] as number);
}

function asIndex(raw: unknown, bound: number): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < bound
    ? raw
    : undefined;
}
