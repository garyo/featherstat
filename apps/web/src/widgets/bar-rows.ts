import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/** One ranked display row of a bar-list. */
export interface BarRow {
  name: string;
  value: number;
  /** Second-metric total (e.g. event value sum); 0 when none was asked for. */
  extra: number;
  /** Share of the largest row, 0–100 with one decimal — the inline bar width. */
  pct: string;
  /**
   * Click-to-filter payload for the row's primary dimension: a string filters
   * `eq` that value, `null` filters `is_null` (the Direct row), `undefined`
   * marks a row that cannot be filtered honestly (e.g. a folded "Other").
   */
  filterValue: string | null | undefined;
}

export interface BarRowOptions {
  /** Second grouping dimension — labels compose as `dim · dim2` (events card). */
  dim2?: string;
  /** Second metric summed per row alongside the primary (e.g. event_value_sum). */
  extraMetric?: string;
}

/**
 * Result rows → ranked display rows, merged by displayed name; rows whose
 * primary metric is 0 are dropped (a breakdown can return groups that exist
 * only through another hit type — noise in a ranking).
 *
 * The merge earns two things at once. `path` keeps its query string in the data
 * model (the query is page identity, docs/03), but a bar-list is a ranking, so
 * campaign variants of one page (`/x?utm_source=…`) collapse onto `/x` for
 * display — approximate when the server's limit already truncated the list,
 * exact otherwise; a drill-in (M2) will show the variants. And because names
 * end up unique by construction, a null-group label colliding with a real
 * dimension value can never produce duplicate render keys. Click-to-filter on a
 * merged path row filters `eq` the displayed path, so variants stay out — the
 * price of ranking by page rather than by URL.
 */
export function barRows(
  rows: readonly ResultRow[],
  metric: string,
  dim: string,
  nullLabel: string,
  options: BarRowOptions = {},
): BarRow[] {
  const byName = new Map<string, { value: number; extra: number; filterValue: string | null }>();
  for (const row of rows) {
    const raw = row[dim];
    const isNull = raw === null || raw === undefined;
    const primary = isNull ? nullLabel : displayName(String(raw), dim);
    const name = options.dim2 === undefined ? primary : composite(primary, row[options.dim2]);
    const filterValue = isNull ? null : dim === 'path' ? primary : String(raw);
    const entry = byName.get(name) ?? { value: 0, extra: 0, filterValue };
    entry.value += num(row[metric]);
    if (options.extraMetric !== undefined) entry.extra += num(row[options.extraMetric]);
    byName.set(name, entry);
  }
  const list = [...byName.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .filter((row) => row.value > 0);
  list.sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...list.map((row) => row.value));
  return list.map((row) => ({ ...row, pct: ((row.value / max) * 100).toFixed(1) }));
}

function composite(primary: string, second: unknown): string {
  return second === null || second === undefined ? primary : `${primary} · ${String(second)}`;
}

/** The page-merge rule: campaign variants (`/x?utm_source=…`) collapse onto `/x`. */
export function displayPath(value: string): string {
  const cut = value.indexOf('?');
  return cut === -1 ? value : cut === 0 ? '/' : value.slice(0, cut);
}

function displayName(value: string, dim: string): string {
  return dim === 'path' ? displayPath(value) : value;
}
