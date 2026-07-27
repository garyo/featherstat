import type { ResultRow } from '@analytics/shared';
import { num } from './series.ts';

/** One ranked display row of a bar-list. */
export interface BarRow {
  name: string;
  value: number;
  /** Share of the largest row, 0–100 with one decimal — the inline bar width. */
  pct: string;
}

/**
 * Result rows → ranked display rows, merged by displayed name.
 *
 * The merge earns two things at once. `path` keeps its query string in the data
 * model (the query is page identity, docs/03), but a bar-list is a ranking, so
 * campaign variants of one page (`/x?utm_source=…`) collapse onto `/x` for
 * display — approximate when the server's limit already truncated the list,
 * exact otherwise; a drill-in (WP12) will show the variants. And because names
 * end up unique by construction, a null-group label colliding with a real
 * dimension value can never produce duplicate render keys.
 */
export function barRows(
  rows: readonly ResultRow[],
  metric: string,
  dim: string,
  nullLabel: string,
): BarRow[] {
  const byName = new Map<string, number>();
  for (const row of rows) {
    const raw = row[dim];
    const name = raw === null || raw === undefined ? nullLabel : displayName(String(raw), dim);
    byName.set(name, (byName.get(name) ?? 0) + num(row[metric]));
  }
  const list = [...byName.entries()].map(([name, value]) => ({ name, value }));
  list.sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...list.map((row) => row.value));
  return list.map((row) => ({ ...row, pct: ((row.value / max) * 100).toFixed(1) }));
}

function displayName(value: string, dim: string): string {
  if (dim !== 'path') return value;
  const cut = value.indexOf('?');
  return cut === -1 ? value : cut === 0 ? '/' : value.slice(0, cut);
}
