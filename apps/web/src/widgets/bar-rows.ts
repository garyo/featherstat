import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/** One labeled line of a row's tooltip; the value arrives already written. */
export interface TipLine {
  value: string;
  label: string;
}

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
  /** The untrimmed value when display shortened it (an outbound URL's protocol). */
  full?: string;
  /**
   * The number as printed, when a plain count is the wrong writing of it — the
   * time-on-page card prints a duration. A count when omitted.
   */
  text?: string;
  /** A quieter second line: the dwell card's longest view and measured count. */
  sub?: string;
  /**
   * The tooltip, in order. Omitted, the rows build the ordinary one from the
   * list's own units (`BarRows`) — a row states its tooltip only when its
   * numbers are not the metric and its second metric.
   */
  tips?: readonly TipLine[];
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
 * only through another hit type — noise in a ranking). Merging makes names
 * unique by construction, so a null-group label colliding with a real
 * dimension value can never produce duplicate render keys.
 *
 * A `path` row is shown whole, query string included: the query is page
 * identity (docs/03 § Page identity), and ingest has already stripped the
 * tracking params that would otherwise fragment one page into many.
 */
export function barRows(
  rows: readonly ResultRow[],
  metric: string,
  dim: string,
  nullLabel: string,
  options: BarRowOptions = {},
): BarRow[] {
  const byName = new Map<
    string,
    { value: number; extra: number; filterValue: string | null; full: string | undefined }
  >();
  for (const row of rows) {
    const raw = row[dim];
    const stored = raw === null || raw === undefined ? undefined : String(raw);
    const primary = stored === undefined ? nullLabel : displayName(stored, dim);
    const name = options.dim2 === undefined ? primary : composite(primary, row[options.dim2]);
    const filterValue = stored ?? null;
    // Trimmed-for-display rows keep their stored value reachable in the tooltip.
    const full = stored !== undefined && stored !== primary ? stored : undefined;
    const entry = byName.get(name) ?? { value: 0, extra: 0, filterValue, full };
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

/**
 * Outbound targets are full URLs and eat the row: the scheme carries no
 * information a reader of a ranking wants, so it goes. Nothing else is dropped —
 * the host, path and query are what tell two links apart — and the raw value
 * still travels as the row's filter payload and tooltip.
 */
function displayTarget(value: string): string {
  return value.replace(/^https?:\/\//i, '');
}

function displayName(value: string, dim: string): string {
  return dim === 'target_url' ? displayTarget(value) : value;
}
