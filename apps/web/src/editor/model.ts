import {
  type Dashboard,
  DashboardSchema,
  type Dimension,
  dashboardBatchIssue,
  MAX_WIDGETS_PER_DASHBOARD,
  type Metric,
  upgradeDashboard,
  type VizType,
  type WidgetSpec,
  withKpiCompanions,
} from '@featherstat/shared';

/**
 * The editor's pure half (docs/05 § Widgets): every mutation of the draft
 * dashboard, the add-widget factory over the shared query vocabulary, and the
 * import parser. All immutable — the Svelte components own the draft `$state`
 * and replace it with what these return.
 */

/** The resize vocabulary — grid spans the layout CSS actually distinguishes. */
export const WIDTH_PRESETS = [4, 6, 12] as const;

/** Full-row widget frames (mirrors the registry): resizing them would lie. */
const WIDE_VIZ = new Set<VizType>(['kpi-row', 'site-cards']);
/** Charts that need horizontal room for their axes; 4 columns smears them. */
const HALF_MIN_VIZ = new Set<VizType>(['timeseries', 'heatmap']);

export function allowedWidths(viz: VizType): number[] {
  if (WIDE_VIZ.has(viz)) return [12];
  if (HALF_MIN_VIZ.has(viz)) return [6, 12];
  return [...WIDTH_PRESETS];
}

export function reorder(grid: readonly WidgetSpec[], from: number, to: number): WidgetSpec[] {
  const next = [...grid];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export function resizeWidget(grid: readonly WidgetSpec[], id: string, w: number): WidgetSpec[] {
  return grid.map((spec) =>
    spec.id === id && allowedWidths(spec.viz).includes(w) ? { ...spec, w } : spec,
  );
}

export function removeWidget(grid: readonly WidgetSpec[], id: string): WidgetSpec[] {
  return grid.filter((spec) => spec.id !== id);
}

export function updateWidget(grid: readonly WidgetSpec[], next: WidgetSpec): WidgetSpec[] {
  return grid.map((spec) => (spec.id === next.id ? next : spec));
}

export function atWidgetCap(dashboard: Dashboard): boolean {
  return dashboard.grid.length >= MAX_WIDGETS_PER_DASHBOARD;
}

/**
 * First free `w<n>` id. Checked against widget AND query ids: a built widget
 * uses one string for both, and batch slots key off the query id.
 */
export function nextWidgetId(grid: readonly WidgetSpec[]): string {
  const used = new Set<string>();
  for (const spec of grid) {
    used.add(spec.id);
    if (spec.query !== undefined) used.add(spec.query.id);
  }
  for (let n = 1; ; n++) {
    const id = `w${n}`;
    if (!used.has(id)) return id;
  }
}

/** What the add-widget picker collects — selects over the shared vocabulary. */
export interface WidgetDraft {
  viz: VizType;
  title: string;
  metrics: Metric[];
  /** '' = no breakdown (totals / bucketed only). */
  dim: Dimension | '';
  limit: number | undefined;
}

/** KPI tiles derivable from a metric pick (kpi.ts catalog names). */
const METRIC_TILES: Partial<Record<Metric, string>> = {
  visitors: 'visitors',
  pageviews: 'pageviews',
  visits: 'visits',
  events: 'events',
  engaged_ms: 'avg_engagement',
  avg_engagement: 'avg_engagement',
  bounce_rate: 'bounce_rate',
};

/**
 * A schema-valid widget from the picker state. Viz types with a fixed shape
 * (heatmap's hour × weekday, the devices pair, site cards) pin their own query;
 * the free-form ones take the picked metrics/dim/limit as-is.
 */
export function buildWidget(draft: WidgetDraft, id: string): WidgetSpec {
  const metrics: Metric[] = draft.metrics.length > 0 ? [...new Set(draft.metrics)] : ['visitors'];
  const first = metrics[0] ?? 'visitors';
  const title = draft.title.trim();
  const base = {
    id,
    ...(title === '' ? {} : { title }),
    h: 2,
    options: {},
  };
  switch (draft.viz) {
    case 'kpi-row': {
      // Engagement tiles need companions the picker does not offer: bounce's
      // `visits` denominator here, and the engagement pair the shared layout
      // steps apply — so a new widget is born at the current vocabulary rather
      // than being upgraded into it on its first read.
      const all = [...metrics];
      if (metrics.includes('engaged_ms') || metrics.includes('bounce_rate')) {
        if (!all.includes('visits')) all.push('visits');
      }
      const tiles = metrics
        .map((metric) => METRIC_TILES[metric])
        .filter((tile): tile is string => tile !== undefined);
      return withKpiCompanions(
        parseSpec({
          ...base,
          viz: draft.viz,
          w: 12,
          h: 1,
          query: { id, metrics: all },
          options: tiles.length > 0 ? { tiles } : {},
        }),
      );
    }
    case 'timeseries':
      // docs/05 caps shared-axis charts at 4 series.
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 12,
        query: { id, metrics: metrics.slice(0, 4), bucket: 'day' },
      });
    case 'heatmap':
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 12,
        query: { id, metrics: [first], dim: 'local_hour', dim2: 'weekday' },
      });
    case 'devices':
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 4,
        query: { id, metrics: [first], dim: 'device_type' },
      });
    case 'site-cards':
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 12,
        h: 3,
        query: { id, metrics: ['visitors'], bucket: 'day', dim: 'site' },
      });
    case 'active-now':
    case 'visitor-tally':
    case 'realtime-countries':
    case 'feed':
      // No query at all: the live feed rides the SSE stream the view holds.
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 6,
        options: draft.limit === undefined ? {} : { limit: draft.limit },
      });
    case 'dwell':
      // Its own query kind, not metric × dimension: the shape IS the answer,
      // and the schema's default ranking depth is the only knob (docs/04 § 3).
      return parseSpec({ ...base, viz: draft.viz, w: 6, query: { id, kind: 'dwell' } });
    case 'changes':
      // The changes kind's defaults (visits, all four dims) are the widget.
      return parseSpec({ ...base, viz: draft.viz, w: 12, query: { id, kind: 'changes' } });
    default:
      // bar-list and the not-yet-implemented vizzes (placeholder cards).
      return parseSpec({
        ...base,
        viz: draft.viz,
        w: 6,
        query: {
          id,
          metrics,
          ...(draft.dim === '' ? {} : { dim: draft.dim }),
          ...(draft.limit === undefined ? {} : { limit: draft.limit }),
        },
      });
  }
}

/** The widget half of DashboardSchema — keeps the factory honest by parsing, not casting. */
function parseSpec(raw: unknown): WidgetSpec {
  return DashboardSchema.shape.grid.element.parse(raw);
}

export function exportJson(dashboard: Dashboard): string {
  return JSON.stringify(dashboard, null, 2);
}

export type ParsedDashboard = { ok: true; dashboard: Dashboard } | { ok: false; errors: string[] };

/**
 * Import = paste the JSON back (docs/05: export/import is copy the JSON).
 * Errors are readable `path: message` lines, and the batch invariants
 * (duplicate query ids, the derived-query count against the batch cap) are
 * checked here — the schema alone can't see them. Pasted JSON is a stored
 * layout like any other: an export taken before a vocabulary change is carried
 * forward by the same shared steps the read paths run.
 */
export function parseDashboardJson(text: string): ParsedDashboard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { ok: false, errors: [`not JSON: ${cause instanceof Error ? cause.message : cause}`] };
  }
  const parsed = DashboardSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) =>
          `${issue.path.join('.') === '' ? 'dashboard' : issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }
  const dashboard = upgradeDashboard(parsed.data);
  const issue = dashboardBatchIssue(dashboard);
  if (issue !== undefined) return { ok: false, errors: [issue] };
  return { ok: true, dashboard };
}
