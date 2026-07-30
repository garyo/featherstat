import type { ResultRow } from '@featherstat/shared';
import type { BarRow } from './bar-rows.ts';
import { compactNumber, exactNumber, formatDuration } from './format.ts';
import { num } from './series.ts';

/**
 * Pure shaping for the time-on-page card (docs/04 § 3 `dwell`). The server
 * already ranked the pages by average dwell; this module only makes the rows
 * renderable — and keeps the card's honesty visible: `views` is how many page
 * views the numbers actually rest on, because a view nothing followed was never
 * timed and is not in the answer at all.
 */

export interface DwellRow {
  /** A title-only pageview stores no URL and arrives as '' — never a blank cell. */
  path: string;
  avgMs: number;
  maxMs: number;
  /** Page views the average rests on; never zero. */
  views: number;
  /** Share of the longest row, 0–100 with one decimal — the wash bar width. */
  pct: string;
}

const UNTITLED = '(untitled)';

export function dwellRows(rows: readonly ResultRow[]): DwellRow[] {
  const parsed: Array<Omit<DwellRow, 'pct'>> = [];
  for (const row of rows) {
    const views = num(row.views_measured);
    if (views <= 0) continue; // nothing was measured: the row would say nothing
    parsed.push({
      path: row.path === '' || typeof row.path !== 'string' ? UNTITLED : row.path,
      avgMs: num(row.avg_page_ms),
      maxMs: num(row.max_page_ms),
      views,
    });
  }
  parsed.sort((a, b) => b.avgMs - a.avgMs);
  const longest = Math.max(1, ...parsed.map((row) => row.avgMs));
  return parsed.map((row) => ({ ...row, pct: ((row.avgMs / longest) * 100).toFixed(1) }));
}

/**
 * The same rows as the shared bar rows draw them (`BarRows.svelte`). This card
 * forked that markup once and drifted: its rows were not keyboard-reachable and
 * carried a native `title` where every other ranking has the designed hover
 * layer. A dwell row is an ordinary bar row whose number is a duration and
 * whose aside says what the average rests on — nothing that warrants a second
 * implementation (CLAUDE.md invariant 7's corollary).
 *
 * Deliberately unfilterable: the query is session-scoped and cannot honestly
 * take a `path` filter, so `filterValue` stays undefined and no row acts as a
 * button.
 */
export function dwellBars(rows: readonly DwellRow[]): BarRow[] {
  return rows.map((row) => ({
    name: row.path,
    value: row.avgMs,
    extra: 0,
    pct: row.pct,
    filterValue: undefined,
    text: formatDuration(row.avgMs),
    sub: `max ${formatDuration(row.maxMs)} · ${compactNumber(row.views)} measured`,
    tips: [
      { value: `${exactNumber(Math.round(row.avgMs))} ms`, label: 'average' },
      { value: `${exactNumber(Math.round(row.maxMs))} ms`, label: 'longest' },
      { value: exactNumber(row.views), label: 'measured views' },
    ],
  }));
}
