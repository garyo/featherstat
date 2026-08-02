import type { BaseDimension, ResultRow } from '@featherstat/shared';
import { dimLabel, nullLabelFor } from '../lib/filters.ts';

/** One mover of a `changes` section, ready to draw. */
export interface ChangeRow {
  name: string;
  current: number;
  delta: number;
  /** |delta| as a share of the section's largest, 0–100 — the bar width. */
  pct: string;
  /** This row's slice of the dimension's net change, written, or ''. */
  share: string;
}

export interface ChangeSection {
  dim: string;
  label: string;
  rows: ChangeRow[];
}

/**
 * `changes` result rows → per-dimension sections, in the order the server
 * ranked them (top movers by |delta| — the client re-orders nothing). Rows the
 * server answered for a dimension with no movement at all are dropped.
 */
export function changeSections(rows: readonly ResultRow[]): ChangeSection[] {
  const byDim = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const dim = String(row.dim);
    const delta = num(row.delta);
    const current = num(row.current);
    if (delta === 0 && current === 0) continue;
    const share = row.share;
    const list = byDim.get(dim) ?? [];
    list.push({
      name: row.value === null ? nullLabelFor(dim as BaseDimension) : String(row.value),
      current,
      delta,
      pct: '0',
      share: typeof share === 'number' ? `${Math.round(Math.abs(share) * 100)}%` : '',
    });
    byDim.set(dim, list);
  }
  return [...byDim.entries()].flatMap(([dim, list]) => {
    const kept = list.filter((row) => row.delta !== 0);
    if (kept.length === 0) return [];
    const max = Math.max(1, ...kept.map((row) => Math.abs(row.delta)));
    for (const row of kept) row.pct = ((Math.abs(row.delta) / max) * 100).toFixed(1);
    return [{ dim, label: dimLabel(dim as BaseDimension), rows: kept }];
  });
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
