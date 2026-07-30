import {
  type Filter,
  isQueryError,
  type QueryErrorResult,
  type QueryResult,
  type RealtimeEngagement,
  type RealtimeHit,
  type SiteInfo,
  type SiteWindow,
  type WidgetSpec,
} from '@featherstat/shared';
import type { SiteScope } from '../lib/state.ts';

/** A widget's share of the view batch, keyed by the slots `widgetQueries` declared. */
export interface WidgetData {
  phase: 'loading' | 'error' | 'ready';
  /** The batch-level failure, when phase is 'error'. */
  message?: string;
  results: Record<string, QueryResult | QueryErrorResult | undefined>;
}

/**
 * The live stream's state — ONE capability, because a page either has the SSE
 * stream or has none of it. As three separate props each view remembered a
 * different subset: a site dashboard passed the feed and neither the counts nor
 * the engaged times, so `active-now` read 0 forever and the tally never showed
 * a duration.
 */
export interface RealtimeEnv {
  /** Distinct active visitors by site id (SSE `snapshot`/`active`). */
  active: Record<number, number>;
  /** The feed ring the page already holds, newest first. */
  recent: readonly RealtimeHit[];
  /** Engaged time per visitor, recounted by the server every 10 s. */
  visitorTimes: readonly RealtimeEngagement[];
}

/** A highlight a composing page shares between its realtime widgets (tally ↔ feed). */
export interface Highlight {
  /** The alias under the cursor, if any. */
  name: string | undefined;
  onhover: (name: string | undefined) => void;
}

/**
 * Everything a widget renders from besides its own spec: the environment the
 * page around it provides.
 *
 * Every member is REQUIRED and nullable — `recent: Recent | null`, never
 * `recent?: Recent`. A caller that cannot supply a capability has to write
 * `null` and say so out loud; with optional members it could omit the key and
 * type-check clean, which is how three defects shipped (a site dashboard's
 * `active-now` stuck at 0, a tally with no engaged time, share cards claiming
 * "no visitors" when the truth was "no live stream"). What a viz cannot do
 * without is declared in `env.ts` `NEEDS`, and the grid renders one honest
 * placeholder for the rest.
 *
 * `data` is the view's one batch, routed here — never a query of the widget's
 * own (CLAUDE.md invariant 1).
 */
export interface WidgetEnv {
  /** This widget's share of the view's batch; null on a page that batches nothing. */
  data: WidgetData | null;
  /**
   * The windows the SERVER resolved this response's range to, one per site
   * (`meta.windows`). Charts read their axis off the result and these; nothing
   * in the browser resolves a preset or enumerates a bucket (widgets/axis.ts).
   */
  windows: readonly SiteWindow[] | null;
  /** Range qualifier for titles ("last 30 days"); null where there is no range. */
  rangeLabel: string | null;
  /** The scope on screen — realtime widgets filter by it and badge at 'all'. */
  scope: SiteScope;
  /** Shared clock for relative labels and for trimming an axis to the reader. */
  now: number;
  /** The SSE stream, or null on a page that carries none (a share link). */
  realtime: RealtimeEnv | null;
  /** The site directory (`/api/sites`); null where the page has none. */
  sites: ReadonlyMap<number, SiteInfo> | null;
  /** Opens the full Realtime view; null where there is nowhere to navigate. */
  onopenrealtime: (() => void) | null;
  onselectsite: ((site: number) => void) | null;
  /** Click-to-filter (docs/05); null on a page with no filter row. */
  onfilter: ((filter: Filter) => void) | null;
  /** A composing page supplies the heading itself; the widget then omits its own. */
  headless: boolean;
  /** Highlight shared with the page's other realtime widgets; null on a grid. */
  highlight: Highlight | null;
}

/**
 * What a view hands the grid: everything but the per-widget batch share the grid
 * routes itself, and the composition state only a page that arranges widgets by
 * hand (the Realtime view) ever sets.
 */
export type GridEnv = Omit<WidgetEnv, 'data' | 'headless' | 'highlight'>;

/**
 * What a view assembles — a `GridEnv` minus the windows, which are filled in by
 * whichever component holds the response (`gridEnv`), so a widget's axis always
 * belongs to the answer beside it.
 */
export type ViewEnv = Omit<GridEnv, 'windows'>;

/**
 * What the authenticated app offers every view: the one SSE stream, the one
 * site directory, the one clock, and the navigation only a session can perform.
 * One value, so a view cannot take the feed and leave the counts behind.
 */
export type AppEnv = Pick<
  WidgetEnv,
  'now' | 'realtime' | 'sites' | 'onopenrealtime' | 'onselectsite'
>;

/**
 * A capability a viz can declare it cannot do without: the name of a nullable
 * `WidgetEnv` member, so `NEEDS` and the environment cannot drift apart.
 */
export type Capability = 'data' | 'realtime';

/** The uniform contract every registered widget component renders from. */
export interface WidgetProps {
  spec: WidgetSpec;
  env: WidgetEnv;
}

export type Slice =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: QueryResult };

/** One slot of a widget's results, folded to the three states a renderer needs. */
export function sliceOf(data: WidgetData | null, slot = 'main'): Slice {
  if (data === null) return { kind: 'error', message: 'This widget was given no query results.' };
  if (data.phase === 'loading') return { kind: 'loading' };
  if (data.phase === 'error') {
    return { kind: 'error', message: data.message ?? 'The query batch failed.' };
  }
  const entry = data.results[slot];
  if (entry === undefined) return { kind: 'error', message: 'No result for this widget.' };
  if (isQueryError(entry)) return { kind: 'error', message: entry.error.message };
  return { kind: 'ready', result: entry };
}
