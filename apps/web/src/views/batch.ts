import type { Dashboard, Query } from '@analytics/shared';
import type { RangePreset } from '../lib/state.ts';
import { isSparkCompanion, widgetQueries } from '../widgets/queries.ts';

/**
 * The collection half of the one-fetch rule (CLAUDE.md invariant 1): widgets
 * declare queries, the view gathers them here into the body of its single
 * `/api/query` request and routes each answer back by widget id + slot.
 */
export interface CollectedBatch {
  /** Every widget's queries in grid order — the whole batch. */
  queries: Query[];
  /** widget id → result slot → query id within the batch. */
  slots: Map<string, Record<string, string>>;
}

export function collectBatch(dashboard: Dashboard): CollectedBatch {
  const queries: Query[] = [];
  const slots = new Map<string, Record<string, string>>();
  const seen = new Set<string>();
  for (const spec of dashboard.grid) {
    const ids: Record<string, string> = {};
    for (const [slot, query] of Object.entries(widgetQueries(spec))) {
      if (seen.has(query.id)) {
        throw new Error(`dashboard '${dashboard.name}': duplicate query id '${query.id}'`);
      }
      seen.add(query.id);
      queries.push(query);
      ids[slot] = query.id;
    }
    slots.set(spec.id, ids);
  }
  return { queries, slots };
}

/**
 * `today` resolves to a single local day, where day buckets collapse to one
 * point — serve hours instead. Bucketing stays a widget concern for every
 * other preset.
 *
 * KPI spark companions are exempt: they mix session-level metrics (engaged_ms,
 * bounce_rate) that the vocabulary cannot bucket by hour, so rewriting them
 * turns the whole companion into a compile error. They keep day buckets and
 * collapse to a single point, which KpiRow renders sparkless.
 */
export function hourlyWhenToday(queries: readonly Query[], range: RangePreset): Query[] {
  if (range !== 'today') return [...queries];
  return queries.map((query) =>
    'kind' in query || query.bucket !== 'day' || isSparkCompanion(query.id)
      ? query
      : { ...query, bucket: 'hour' },
  );
}
