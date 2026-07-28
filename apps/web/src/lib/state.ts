import type { Filter, QueryRequest, Range } from '@featherstat/shared';
import { parseFilters, sameFilters, serializeFilter } from './filters.ts';

/**
 * The view state lives in the URL (docs/05): every dashboard state is linkable
 * and the back button moves between states rather than out of the app. This
 * module is the pure half — parsing and serialization, no DOM; `state.svelte.ts`
 * binds it to `history`.
 *
 * WP12 grew the shape to the full docs/05 state: site + range preset + filter
 * chips (`f` params, see filters.ts) + which top-level view is up (`view=realtime`).
 */

/** `all` is the overview; a number is one site — the same scope the query API takes. */
export type SiteScope = QueryRequest['site'];
export type RangePreset = Extract<Range, { preset: string }>['preset'];
/** `dash` is the all-sites/site pair; `journeys` the per-site sankey view (M2);
 * `realtime` the SSE tab; `settings` the admin view (WP13). */
export type ViewName = 'dash' | 'journeys' | 'realtime' | 'settings';

export interface ViewState {
  site: SiteScope;
  range: RangePreset;
  view: ViewName;
  filters: Filter[];
}

/** What a control changes: one axis of the view state at a time. */
export type ViewStatePatch = Partial<ViewState>;

/**
 * The nav rules of the Scope x View header (docs/05): scope changes keep the
 * view and view changes keep the scope, except the one undefined cell —
 * Journeys has no All-sites rendering, so entering it at All coerces the
 * scope to the last-visited site (the picker then truthfully wears it), and
 * choosing All while on Journeys lands on the overview.
 */
export function resolveNav(
  current: ViewState,
  patch: ViewStatePatch,
  siteTab: number,
): ViewStatePatch {
  const next = { ...patch };
  const view = next.view ?? current.view;
  const site = next.site ?? current.site;
  if (view === 'journeys' && site === 'all') {
    if (next.site === 'all') next.view = 'dash';
    else next.site = siteTab;
  }
  return next;
}

/** Exhaustive by construction: a new preset in `packages/shared` fails to compile until it is labeled. */
export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  mtd: 'Month to date',
};

/** Display order of the filter row, taken from the labels so the two cannot drift. */
export const RANGE_PRESETS = Object.keys(RANGE_LABELS) as readonly RangePreset[];

export const DEFAULT_VIEW_STATE: ViewState = {
  site: 'all',
  range: '30d',
  view: 'dash',
  filters: [],
};

/** Only used to parse relative hrefs; never appears in anything this module returns. */
const RELATIVE_BASE = 'http://view.invalid';

export function parseViewState(href: string): ViewState {
  const params = new URL(href, RELATIVE_BASE).searchParams;
  return {
    site: parseSite(params.get('site')),
    range: parseRange(params.get('range')),
    view: parseView(params.get('view')),
    filters: parseFilters(params.getAll('f')),
  };
}

/**
 * `href` in, href out: unrelated query params and the hash survive, and params at
 * their default are dropped so the canonical dashboard URL stays clean.
 */
export function applyViewState(state: ViewState, href: string): string {
  const url = new URL(href, RELATIVE_BASE);
  const fallback = DEFAULT_VIEW_STATE;
  set(url.searchParams, 'site', state.site === fallback.site ? undefined : state.site);
  set(url.searchParams, 'range', state.range === fallback.range ? undefined : state.range);
  set(url.searchParams, 'view', state.view === fallback.view ? undefined : state.view);
  url.searchParams.delete('f');
  for (const filter of state.filters) url.searchParams.append('f', serializeFilter(filter));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sameViewState(a: ViewState, b: ViewState): boolean {
  return (
    a.site === b.site &&
    a.range === b.range &&
    a.view === b.view &&
    sameFilters(a.filters, b.filters)
  );
}

function set(params: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value === undefined) params.delete(key);
  else params.set(key, String(value));
}

/** Anything unparseable falls back to the default — a bad link opens the dashboard, not an error. */
function parseSite(raw: string | null): SiteScope {
  if (raw === null) return DEFAULT_VIEW_STATE.site;
  if (raw === 'all') return 'all';
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : DEFAULT_VIEW_STATE.site;
}

function parseRange(raw: string | null): RangePreset {
  return raw !== null && raw in RANGE_LABELS ? (raw as RangePreset) : DEFAULT_VIEW_STATE.range;
}

function parseView(raw: string | null): ViewName {
  return raw === 'journeys' || raw === 'realtime' || raw === 'settings'
    ? raw
    : DEFAULT_VIEW_STATE.view;
}
