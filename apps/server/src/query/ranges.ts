import { DAY_MS, type Range } from '@analytics/shared';
import { localParts } from '../pipeline/sessionizer.ts';

/**
 * Range presets resolve to inclusive `local_date` bounds in one site's timezone
 * (docs/03 § Timezones: the tz math happened at ingest, so date windows are plain
 * indexed string comparisons). `site: "all"` resolves a window per site.
 */
export interface DateWindow {
  from: string;
  to: string;
}

/** Days a rolling preset covers, counting today. */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

export function resolveWindow(range: Range, timezone: string, now: number): DateWindow {
  if ('from' in range) return { from: range.from, to: range.to };
  const today = localParts(timezone, now).date;
  if (range.preset === 'today') return { from: today, to: today };
  if (range.preset === 'mtd') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDays(today, 1 - PRESET_DAYS[range.preset]), to: today };
}

/** `previous` = the same-length window immediately before; `year` = the same window one year back. */
export function compareWindow(window: DateWindow, mode: 'previous' | 'year'): DateWindow {
  if (mode === 'year') return { from: addYears(window.from, -1), to: addYears(window.to, -1) };
  const days = daysBetween(window.from, window.to) + 1;
  return { from: addDays(window.from, -days), to: addDays(window.from, -1) };
}

function addDays(date: string, days: number): string {
  return isoDate(parseIso(date) + days * DAY_MS);
}

function addYears(date: string, years: number): string {
  const shifted = new Date(parseIso(date));
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return isoDate(shifted.getTime());
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to) - parseIso(from)) / DAY_MS);
}

function parseIso(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
