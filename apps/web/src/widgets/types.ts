import {
  type Filter,
  isQueryError,
  type QueryErrorResult,
  type QueryResult,
  type RealtimeEngagement,
  type RealtimeHit,
  type SiteInfo,
  type WidgetSpec,
} from '@featherstat/shared';
import type { RangePreset, SiteScope } from '../lib/state.ts';

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
  /**
   * The view's batch results. Optional because query-less widgets exist: the
   * realtime family renders from the SSE stream and asks the batch for nothing
   * (CLAUDE.md invariant 1 — a widget declares a query or it declares none).
   */
  data?: WidgetData;
  /** The requested site-local date window — charts pad their series out to it. */
  window?: { from: string; to: string };
  /** Range qualifier for titles (mockup: "Traffic by hour · last 30 days"). */
  rangeLabel?: string;
  /** The active preset — bucket clock for range-driven widgets (site cards). */
  range?: RangePreset;
  /** Live active-visitor counts by site id (SSE `snapshot`/`active`); site-cards reads it. */
  active?: Record<number, number>;
  /** The SSE live feed the view already holds; the `feed` widget reads it. */
  recent?: readonly RealtimeHit[];
  /** The view's scope — the feed widget filters by it and badges at 'all'. */
  scope?: SiteScope;
  /** Opens the full Realtime view; absent in the editor preview and shared views. */
  onopenrealtime?: () => void;
  /** Engaged time per visitor, recounted by the server every 10 s. */
  visitorTimes?: readonly RealtimeEngagement[];
  /** Shared clock for relative labels; widgets that tick supply their own. */
  now?: number;
  /** Highlight shared across a view's realtime widgets (tally ↔ feed). */
  hover?: string | undefined;
  onhover?: (name: string | undefined) => void;
  /** A composing view supplies the heading itself; the widget then omits its own. */
  headless?: boolean;
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
export function sliceOf(data: WidgetData | undefined, slot = 'main'): Slice {
  if (data === undefined) return { kind: 'error', message: 'This widget was given no data.' };
  if (data.phase === 'loading') return { kind: 'loading' };
  if (data.phase === 'error') {
    return { kind: 'error', message: data.message ?? 'The query batch failed.' };
  }
  const entry = data.results[slot];
  if (entry === undefined) return { kind: 'error', message: 'No result for this widget.' };
  if (isQueryError(entry)) return { kind: 'error', message: entry.error.message };
  return { kind: 'ready', result: entry };
}
