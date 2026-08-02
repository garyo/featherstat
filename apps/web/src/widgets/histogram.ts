import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/**
 * Display rows for the `histogram` viz over a `distribution` result
 * (docs/04 § 3): dwell rows arrive as labeled duration bands in band order;
 * scroll rows arrive as decile indices 0–9 counting only MEASURED legs.
 *
 * Scroll deciles are filled to all ten: a histogram whose empty deciles vanish
 * reads as a different axis per response. Dwell bands stay as sent — the server
 * emits them in duration order and their labels are its own literals.
 */
export interface HistogramBar {
  label: string;
  value: number;
  /** Share of the tallest bar, 0–100 — the drawn height. */
  pct: number;
}

export function histogramBars(rows: readonly ResultRow[], of: 'dwell' | 'scroll'): HistogramBar[] {
  const raw =
    of === 'scroll'
      ? scrollDeciles(rows)
      : rows.map((row) => ({ label: String(row.bucket ?? ''), value: num(row.legs) }));
  const max = Math.max(...raw.map((bar) => bar.value), 1);
  return raw.map((bar) => ({ ...bar, pct: Math.round((bar.value / max) * 1000) / 10 }));
}

function scrollDeciles(rows: readonly ResultRow[]): { label: string; value: number }[] {
  const counts = new Array<number>(10).fill(0);
  for (const row of rows) {
    const decile = num(row.bucket);
    if (Number.isInteger(decile) && decile >= 0 && decile <= 9) {
      counts[decile] = num(row.legs);
    }
  }
  return counts.map((value, decile) => ({
    label: decile === 9 ? '90–100%' : `${decile * 10}–${decile * 10 + 10}%`,
    value,
  }));
}
