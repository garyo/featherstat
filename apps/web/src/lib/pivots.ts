import {
  type BaseDimension,
  BaseDimensionSchema,
  type Dashboard,
  EVENT_ONLY_DIMENSIONS,
  EVENT_ONLY_METRICS,
  SESSION_ONLY_DIMENSIONS,
  SESSION_ONLY_METRICS,
  type VizType,
  type WidgetSpec,
} from '@featherstat/shared';
import { NULL_LABELS } from './filters.ts';
import type { PivotChoice } from './state.ts';

/**
 * Pivots (docs/05 § Pivots): a transient overlay swapping one widget's
 * breakdown dimension. `applyPivots` derives the document BEFORE `collectBatch`
 * runs, so invariant 1 holds trivially — the view still collects one batch,
 * over the pivoted specs, and derived companions recompute because
 * `widgetQueries` runs on what this returns. The overlay lives in the URL
 * (`pv=` params) and is never stored; keeping a pivot is saving the pivoted
 * document through the editor. Share links ignore it — the share route
 * assembles its batch from the stored row.
 */

/** The vizzes whose breakdown is a free pick — the same set the add-widget flow
 * treats as free-form (its `map` has no rows to pivot yet). */
const PIVOTABLE = new Set<VizType>(['bar-list', 'table']);

export function isPivotable(spec: WidgetSpec): boolean {
  return (
    PIVOTABLE.has(spec.viz) &&
    spec.query !== undefined &&
    !('kind' in spec.query) &&
    spec.query.dim !== undefined
  );
}

/** Display options that follow the dimension, not the widget (docs/05). */
function pivotOptions(dim: BaseDimension): Record<string, unknown> {
  const nullLabel = NULL_LABELS[dim];
  return {
    ...(dim === 'country' ? { flags: true } : {}),
    ...(nullLabel === undefined ? {} : { nullLabel }),
  };
}

export function applyPivots(dashboard: Dashboard, pivots: readonly PivotChoice[]): Dashboard {
  if (pivots.length === 0) return dashboard;
  const byWidget = new Map(pivots.map((pivot) => [pivot.widget, pivot.dim]));
  let changed = false;
  const grid = dashboard.grid.map((spec) => {
    const dim = byWidget.get(spec.id);
    if (
      dim === undefined ||
      !isPivotable(spec) ||
      spec.query === undefined ||
      'kind' in spec.query ||
      spec.query.dim === dim
    ) {
      return spec;
    }
    changed = true;
    // dim2 composed labels for the ORIGINAL dim (events' category · action);
    // under a new one it would decorate rows with an unrelated second column.
    const { dim2: _dim2, ...query } = spec.query;
    const { flags: _flags, nullLabel: _nullLabel, ...options } = spec.options;
    // The saved title described the saved breakdown ("Top pages" over browsers
    // is a lie) — pivoted, the picker IS the heading (BarList).
    const { title: _title, ...rest } = spec;
    return { ...rest, query: { ...query, dim }, options: { ...options, ...pivotOptions(dim) } };
  });
  return changed ? { ...dashboard, grid } : dashboard;
}

const EVENT_DIMS = new Set<string>(EVENT_ONLY_DIMENSIONS);
const SESSION_DIMS = new Set<string>(SESSION_ONLY_DIMENSIONS);
const EVENT_METRICS = new Set<string>(EVENT_ONLY_METRICS);
const SESSION_METRICS = new Set<string>(SESSION_ONLY_METRICS);

/**
 * The dimensions a widget with these metrics can pivot to: the base enum minus
 * `site` (the scope picker owns that axis) and minus any dim whose blocked
 * combination (docs/04 § 3) would leave the widget NO answerable metric —
 * `withoutBlockedMetrics` trims a partial conflict, but a total one could only
 * render an error card, so it is not offered.
 */
export function pivotDims(metrics: readonly string[]): BaseDimension[] {
  return BaseDimensionSchema.options.filter((dim) => {
    if (dim === 'site') return false;
    const kept = metrics.filter(
      (metric) =>
        !(EVENT_DIMS.has(dim) && SESSION_METRICS.has(metric)) &&
        !(SESSION_DIMS.has(dim) && EVENT_METRICS.has(metric)),
    );
    return kept.length > 0;
  });
}
