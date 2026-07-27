import {
  type Filter,
  isQueryError,
  type QueryErrorResult,
  type QueryResult,
  type SiteInfo,
  type WidgetSpec,
} from '@analytics/shared';

/** A widget's share of the view batch, keyed by the slots `widgetQueries` declared. */
export interface WidgetData {
  phase: 'loading' | 'error' | 'ready';
  /** The batch-level failure, when phase is 'error'. */
  message?: string;
  results: Record<string, QueryResult | QueryErrorResult | undefined>;
}

/** The uniform contract every registered widget component renders from. */
export interface WidgetProps {
  spec: WidgetSpec;
  data: WidgetData;
  /** The requested site-local date window — charts pad their series out to it. */
  window?: { from: string; to: string };
  /** Range qualifier for titles (mockup: "Traffic by hour · last 30 days"). */
  rangeLabel?: string;
  /** Live active-visitor counts by site id (SSE `snapshot`/`active`); site-cards reads it. */
  active?: Record<number, number>;
  /** The site directory (`/api/sites`); site-cards names its cards from it. */
  sites?: ReadonlyMap<number, SiteInfo>;
  onselectsite?: (site: number) => void;
  /** Click-to-filter (docs/05): a breakdown row adds one chip to the view's filter row. */
  onfilter?: (filter: Filter) => void;
}

export type Slice =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: QueryResult };

/** One slot of a widget's results, folded to the three states a renderer needs. */
export function sliceOf(data: WidgetData, slot = 'main'): Slice {
  if (data.phase === 'loading') return { kind: 'loading' };
  if (data.phase === 'error') {
    return { kind: 'error', message: data.message ?? 'The query batch failed.' };
  }
  const entry = data.results[slot];
  if (entry === undefined) return { kind: 'error', message: 'No result for this widget.' };
  if (isQueryError(entry)) return { kind: 'error', message: entry.error.message };
  return { kind: 'ready', result: entry };
}
