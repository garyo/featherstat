import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/**
 * The stacked device bar (mockup "Devices & browsers"): at most three segments
 * (docs/05 series discipline — all-pairs forms cap at 3). More distinct types
 * than that fold into "Other", and the null group (unknown device) always
 * lands there. Slots are categorical palette positions assigned by rank.
 */

const MAX_SEGMENTS = 3;
const OTHER = 'Other';

export interface DeviceSegment {
  /** Capitalized display name (`Desktop`); `Other` for the fold. */
  name: string;
  value: number;
  /** Exact share of the total, 0–100 — the segment width. */
  share: number;
  /** Rounded percent for labels and tooltips. */
  pct: number;
  /** Categorical palette slot, 0-based rank order. */
  slot: number;
  /** eq-filter value (raw dimension value); undefined for the unfilterable fold. */
  filterValue: string | undefined;
}

export function deviceSegments(rows: readonly ResultRow[], metric: string): DeviceSegment[] {
  const named: Array<{ raw: string; value: number }> = [];
  let other = 0;
  for (const row of rows) {
    const raw = row.device_type;
    const value = num(row[metric]);
    if (value <= 0) continue;
    if (raw === null || raw === undefined || String(raw) === 'other') other += value;
    else named.push({ raw: String(raw), value });
  }
  named.sort((a, b) => b.value - a.value);

  const keep = other > 0 || named.length > MAX_SEGMENTS ? MAX_SEGMENTS - 1 : MAX_SEGMENTS;
  const folded = named.slice(keep).reduce((total, entry) => total + entry.value, other);
  const segments = named.slice(0, keep).map((entry) => ({
    name: entry.raw.charAt(0).toUpperCase() + entry.raw.slice(1),
    value: entry.value,
    filterValue: entry.raw as string | undefined,
  }));
  if (folded > 0) segments.push({ name: OTHER, value: folded, filterValue: undefined });

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return segments.map((segment, slot) => ({
    ...segment,
    share: (segment.value / total) * 100,
    pct: Math.round((segment.value / total) * 100),
    slot,
  }));
}
