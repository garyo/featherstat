import {
  type BaseDimension,
  BaseDimensionSchema,
  type Compare,
  type DetailDimension,
  elapsedThrough,
  type FilterNode,
  isDetailDimension,
  type QueryRequest,
  type Range,
  RangeSchema,
} from '@featherstat/shared';
import { parseFilters, sameFilters, serializeFilter } from './filters.ts';

/**
 * The view state lives in the URL (docs/05): every dashboard state is linkable
 * and the back button moves between states rather than out of the app. This
 * module is the pure half — parsing and serialization, no DOM; `state.svelte.ts`
 * binds it to `history`.
 *
 * The full docs/05 state: site + range (preset or explicit dates) + compare
 * mode + which dashboard from the library (`dash`) + filter chips (`f` params,
 * see filters.ts) + which top-level view is up (`view=realtime`) + which
 * Settings section is open (`section=access`).
 */

/** `all` is the overview; a number is one site — the same scope the query API takes. */
export type SiteScope = QueryRequest['site'];
export type RangePreset = Extract<Range, { preset: string }>['preset'];
/** An explicit inclusive site-local date range — the query API's `{from, to}` form. */
export type CustomRange = Extract<Range, { from: string }>;
/** What the range pill row can select: a preset, or explicit dates. */
export type ViewRange = RangePreset | CustomRange;
/**
 * The compare control's vocabulary: the API's `previous`/`year`, an explicit
 * window, or `off` — which the API spells by omitting `compare` entirely.
 */
export type CompareChoice = 'previous' | 'year' | 'off' | CustomRange;
/**
 * Which dashboard of the scope's library is up (docs/05 § The dashboard
 * library): a stored row id, or `t:<id>` naming a shipped template. Absent
 * (undefined) means the scope's default.
 */
export type DashRef = number | `t:${string}`;
/** `dash` is the all-sites/site pair; `journeys` the per-site sankey view (M2);
 * `realtime` the SSE tab; `settings` the admin view (WP13); `detail` one
 * entity's drill-in (docs/05 § Detail views), named by the `d` param. */
export type ViewName = 'dash' | 'journeys' | 'realtime' | 'settings' | 'detail';

/** The Settings view's sections (docs/05 § Settings), in nav order. */
const SETTINGS_SECTIONS = [
  'sites',
  'access',
  'users',
  'query',
  'campaigns',
  'notify',
  'data',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The entity a detail view is about: a drillable dimension and its value. */
export interface DetailRef {
  dim: DetailDimension;
  value: string;
}

/** One widget's transient breakdown override (docs/05 § Pivots): `pv=<id>:<dim>`. */
export interface PivotChoice {
  widget: string;
  dim: BaseDimension;
}

export interface ViewState {
  site: SiteScope;
  range: ViewRange;
  /** Compare mode; `previous` is the default and stays out of the URL. */
  cmp: CompareChoice;
  /** Library selection; undefined = the scope's default dashboard. */
  dash: DashRef | undefined;
  view: ViewName;
  /** The entity on screen when `view` is `detail`; undefined everywhere else. */
  detail: DetailRef | undefined;
  /** The open Settings section when `view` is `settings`; undefined = the first. */
  section: SettingsSection | undefined;
  filters: FilterNode[];
  /** Transient per-widget breakdown overrides; they name widgets of `dash`. */
  pivots: PivotChoice[];
}

/** What a control changes: one axis of the view state at a time. */
export type ViewStatePatch = Partial<ViewState>;

/**
 * The nav rules of the Scope x View header (docs/05): scope changes keep the
 * view and view changes keep the scope, except the undefined cells — Journeys
 * and the detail views have no All-sites rendering, so entering one at All
 * coerces the scope to the last-visited site (the picker then truthfully wears
 * it), and choosing All while on one lands on the overview. A scope change
 * also drops the library selection (`dash` names a dashboard of the OLD
 * scope), and a scope or library change drops the pivots, which name widgets
 * of the old document. Naming an entity IS entering its detail view; leaving
 * the detail view forgets the entity, as leaving Settings forgets its section.
 */
export function resolveNav(
  current: ViewState,
  patch: ViewStatePatch,
  siteTab: number,
): ViewStatePatch {
  const next = { ...patch };
  if (next.detail !== undefined) next.view = 'detail';
  const view = next.view ?? current.view;
  const site = next.site ?? current.site;
  // Present-but-undefined, so the `{ ...current, ...patch }` merge still clears it.
  if (next.site !== undefined && next.site !== current.site && !('dash' in next)) {
    next.dash = undefined;
  }
  if (
    ((next.site !== undefined && next.site !== current.site) || 'dash' in next) &&
    !('pivots' in next) &&
    current.pivots.length > 0
  ) {
    next.pivots = [];
  }
  if ((view === 'journeys' || view === 'detail') && site === 'all') {
    if (next.site === 'all') next.view = 'dash';
    else next.site = siteTab;
  }
  if (
    (next.view ?? current.view) !== 'detail' &&
    !('detail' in next) &&
    current.detail !== undefined
  ) {
    next.detail = undefined;
  }
  if (
    (next.view ?? current.view) !== 'settings' &&
    !('section' in next) &&
    current.section !== undefined
  ) {
    next.section = undefined;
  }
  return next;
}

/**
 * Whether moving between two states takes away the dashboard an editor draft
 * belongs to: the page leaves the Dashboard view, or the scope or library
 * selection under it changes. Range, compare, filter and pivot moves keep the
 * document, so an open draft survives them (it previews in the new context).
 */
export function discardsDraft(from: ViewState, to: ViewState): boolean {
  return (
    from.view === 'dash' && (to.view !== 'dash' || to.site !== from.site || to.dash !== from.dash)
  );
}

/**
 * Whether moving between two states takes the open Settings section — and any
 * unsaved form in it — off screen: the page leaves Settings, or history moves
 * it to another section. (The section nav asks for itself before it moves.)
 */
export function leavesSettingsSection(from: ViewState, to: ViewState): boolean {
  return from.view === 'settings' && (to.view !== 'settings' || to.section !== from.section);
}

/** Exhaustive by construction: a new preset in `packages/shared` fails to compile until it is labeled. */
export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  '24h': 'Last 24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  mtd: 'Month to date',
};

/**
 * A key that changes when any site rolls into a new local day. `today` and
 * `mtd` are resolved server-side per site, so their data changes at each
 * site's own midnight — not the reader's, and not on a data tick. An explicit
 * range touching today moves the same way (its `windowTag` clips to the site's
 * local today). Watching this is what makes a dashboard left open overnight
 * correct in the morning.
 */
export function localDayKey(zones: readonly string[], now: Date): string {
  return [...new Set(zones)]
    .sort()
    .map((zone) => elapsedThrough('day', zone, now.getTime()))
    .join('|');
}

/**
 * The latest calendar date any of these zones has reached — the most a date
 * picker may offer, since a site ahead of the reader is already on tomorrow.
 * With no zones, the reader's own date.
 */
export function latestLocalDay(zones: readonly string[], now: number): string {
  const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (zones.length === 0 ? [reader] : zones)
    .map((zone) => elapsedThrough('day', zone, now))
    .reduce((latest, day) => (day > latest ? day : latest));
}

/** Widget-title qualifier (mockup: "Traffic by hour · last 30 days"). */
const RANGE_QUALIFIER: Record<RangePreset, string> = {
  today: 'today',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  mtd: 'month to date',
};

/** Display order of the filter row, taken from the labels so the two cannot drift. */
export const RANGE_PRESETS = Object.keys(RANGE_LABELS) as readonly RangePreset[];

export const DEFAULT_VIEW_STATE: ViewState = {
  site: 'all',
  range: '30d',
  cmp: 'previous',
  dash: undefined,
  view: 'dash',
  detail: undefined,
  section: undefined,
  filters: [],
  pivots: [],
};

// ---------------------------------------------------------------------------
// Range & compare helpers — the one place the URL forms, the API forms and the
// human labels for both are written, so a control, a request and a widget
// subtitle can never disagree about what a range is.
// ---------------------------------------------------------------------------

/** The wire form: what `QueryRequest.range` takes. */
export function toRange(range: ViewRange): Range {
  return typeof range === 'string' ? { preset: range } : range;
}

/** The wire form of the compare control; undefined means "send no compare". */
export function compareParam(cmp: CompareChoice): Compare | undefined {
  return cmp === 'off' ? undefined : cmp;
}

function sameRange(a: ViewRange, b: ViewRange): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.from === b.from && a.to === b.to;
}

function sameCompare(a: CompareChoice, b: CompareChoice): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.from === b.from && a.to === b.to;
}

/** Inclusive length of an explicit range in whole days. */
export function rangeDays(range: CustomRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };

function utcDay(date: string, withYear: boolean): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    ...DAY,
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/**
 * An explicit range as a human reads it: "Jun 1 – Jun 30, 2026", the year said
 * once when both ends share it, twice when they straddle a new year.
 */
export function formatDayRange(range: CustomRange): string {
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  if (range.from === range.to) return utcDay(range.from, true);
  return sameYear
    ? `${utcDay(range.from, false)} – ${utcDay(range.to, true)}`
    : `${utcDay(range.from, true)} – ${utcDay(range.to, true)}`;
}

/** Filter-pill label: the preset table, or the explicit dates. */
export function rangeLabel(range: ViewRange): string {
  return typeof range === 'string' ? RANGE_LABELS[range] : formatDayRange(range);
}

/** Widget-title qualifier ("last 30 days" / "Jun 1 – Jun 30, 2026"). */
export function rangeQualifier(range: ViewRange): string {
  return typeof range === 'string' ? RANGE_QUALIFIER[range] : formatDayRange(range);
}

/**
 * Compare wording per preset (mockup: "compared with previous 30 days"). Only
 * `24h` is like-for-like: a partial period is compared against a complete one,
 * which is how a calendar range reads everywhere, and why the rolling preset
 * exists beside it (docs/04 § 3).
 */
const PREVIOUS_NOTE: Record<RangePreset, string> = {
  today: 'compared with all of yesterday',
  '24h': 'compared with the previous 24 hours',
  '7d': 'compared with the previous 7 days',
  '30d': 'compared with the previous 30 days',
  '90d': 'compared with the previous 90 days',
  mtd: 'compared with the previous period',
};

/**
 * The compare sentence for a view state, or undefined when comparison is off.
 * An explicit compare window of a DIFFERENT length still aligns by index from
 * the start (docs/04 § 3) — the label states both lengths, because that
 * labeled mismatch is the contract that makes the alignment honest.
 */
export function compareNote(range: ViewRange, cmp: CompareChoice): string | undefined {
  if (cmp === 'off') return undefined;
  if (cmp === 'year') return 'compared with the same period last year';
  if (cmp === 'previous') {
    if (typeof range === 'string') return PREVIOUS_NOTE[range];
    const days = rangeDays(range);
    return `compared with the previous ${days === 1 ? 'day' : `${days} days`}`;
  }
  const base = `compared with ${formatDayRange(cmp)}`;
  if (typeof range === 'string') return base;
  const current = rangeDays(range);
  const against = rangeDays(cmp);
  return current === against ? base : `${base} (${current} days vs ${against} days)`;
}

/**
 * The range the response on screen answers: the request it was fetched for,
 * or the pill's own while nothing has landed. Labels read this, not the pill,
 * so a refetch or a failed change can never caption held data with the range
 * being loaded.
 */
export function heldRange(held: QueryRequest | undefined, range: ViewRange): ViewRange {
  if (held === undefined) return range;
  return 'preset' in held.range ? held.range.preset : held.range;
}

/**
 * What a failed batch leaves on screen, in the filter row's words. A change the
 * reader asked for that never landed (`stale`) says what is shown instead; a
 * live revalidation that failed still shows the state asked for.
 */
export function failureNote(stale: boolean, range: ViewRange, held: ViewRange): string {
  return stale
    ? `Couldn't load ${rangeQualifier(range)} — showing ${rangeQualifier(held)}`
    : 'Live update failed — showing the last good result';
}

/** Only used to parse relative hrefs; never appears in anything this module returns. */
const RELATIVE_BASE = 'http://view.invalid';

export function parseViewState(href: string): ViewState {
  const params = new URL(href, RELATIVE_BASE).searchParams;
  const detail = parseDetailRef(params.get('d'));
  const view = parseView(params.get('view'));
  return {
    site: parseSite(params.get('site')),
    range: parseRange(params.get('range')),
    cmp: parseCompare(params.get('cmp')),
    dash: parseDashRef(params.get('dash')),
    // A detail view without its entity is nothing to show — open the dashboard.
    view: view === 'detail' && detail === undefined ? 'dash' : view,
    detail: view === 'detail' ? detail : undefined,
    section: view === 'settings' ? parseSection(params.get('section')) : undefined,
    filters: parseFilters(params.getAll('f')),
    pivots: parsePivots(params.getAll('pv')),
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
  set(
    url.searchParams,
    'range',
    sameRange(state.range, fallback.range) ? undefined : serializeRange(state.range),
  );
  set(
    url.searchParams,
    'cmp',
    sameCompare(state.cmp, fallback.cmp) ? undefined : serializeCompare(state.cmp),
  );
  set(url.searchParams, 'dash', state.dash);
  set(url.searchParams, 'view', state.view === fallback.view ? undefined : state.view);
  set(
    url.searchParams,
    'd',
    state.view === 'detail' && state.detail !== undefined
      ? serializeDetailRef(state.detail)
      : undefined,
  );
  set(url.searchParams, 'section', state.view === 'settings' ? state.section : undefined);
  url.searchParams.delete('f');
  for (const filter of state.filters) url.searchParams.append('f', serializeFilter(filter));
  url.searchParams.delete('pv');
  for (const pivot of state.pivots) {
    url.searchParams.append('pv', `${pivot.widget}:${pivot.dim}`);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sameViewState(a: ViewState, b: ViewState): boolean {
  return (
    a.site === b.site &&
    sameRange(a.range, b.range) &&
    sameCompare(a.cmp, b.cmp) &&
    a.dash === b.dash &&
    a.view === b.view &&
    sameDetailRef(a.detail, b.detail) &&
    a.section === b.section &&
    sameFilters(a.filters, b.filters) &&
    a.pivots.length === b.pivots.length &&
    a.pivots.every((p, i) => p.widget === b.pivots[i]?.widget && p.dim === b.pivots[i]?.dim)
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

/** `2026-06-01..2026-06-30` — real calendar dates, in order, or nothing. */
const CUSTOM_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** An explicit range the query API would accept, or undefined. */
function parseCustomRange(raw: string): CustomRange | undefined {
  const match = CUSTOM_RANGE_RE.exec(raw);
  if (match === null) return undefined;
  const candidate = { from: match[1] as string, to: match[2] as string };
  if (candidate.from > candidate.to) return undefined;
  return RangeSchema.safeParse(candidate).success ? candidate : undefined;
}

function serializeRange(range: ViewRange): string {
  return typeof range === 'string' ? range : `${range.from}..${range.to}`;
}

function parseRange(raw: string | null): ViewRange {
  if (raw === null) return DEFAULT_VIEW_STATE.range;
  if (raw in RANGE_LABELS) return raw as RangePreset;
  return parseCustomRange(raw) ?? DEFAULT_VIEW_STATE.range;
}

function serializeCompare(cmp: CompareChoice): string {
  return typeof cmp === 'string' ? cmp : `${cmp.from}..${cmp.to}`;
}

function parseCompare(raw: string | null): CompareChoice {
  if (raw === null) return DEFAULT_VIEW_STATE.cmp;
  if (raw === 'previous' || raw === 'year' || raw === 'off') return raw;
  return parseCustomRange(raw) ?? DEFAULT_VIEW_STATE.cmp;
}

/** A template ref's id charset — the shared registry's ids all fit it. */
const TEMPLATE_REF_RE = /^t:[a-z0-9-]{1,64}$/;

export function parseDashRef(raw: string | null): DashRef | undefined {
  if (raw === null) return undefined;
  if (TEMPLATE_REF_RE.test(raw)) return raw as DashRef;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function parseView(raw: string | null): ViewName {
  return raw === 'journeys' || raw === 'realtime' || raw === 'settings' || raw === 'detail'
    ? raw
    : DEFAULT_VIEW_STATE.view;
}

function parseSection(raw: string | null): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section === raw);
}

/**
 * `d=<dim>:<encoded value>` — the same dim:value serialization the filter
 * chips use (`lib/filters.ts`), restricted to the dimensions that have a
 * detail template. The value is component-encoded, so a path carrying `:` can
 * never split the ref.
 */
function serializeDetailRef(detail: DetailRef): string {
  return `${detail.dim}:${encodeURIComponent(detail.value)}`;
}

export function parseDetailRef(raw: string | null): DetailRef | undefined {
  if (raw === null) return undefined;
  const cut = raw.indexOf(':');
  if (cut === -1) return undefined;
  const dim = raw.slice(0, cut);
  if (!isDetailDimension(dim)) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw.slice(cut + 1));
  } catch {
    return undefined;
  }
  return value === '' ? undefined : { dim, value };
}

function sameDetailRef(a: DetailRef | undefined, b: DetailRef | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.dim === b.dim && a.value === b.value;
}

/** `pv=<widgetId>:<dim>`, repeatable; the dim anchors the split from the right
 * because a widget id may itself carry a `:`. Junk entries are dropped, and a
 * widget named twice keeps its last pivot — the one clicked most recently. */
function parsePivots(raw: readonly string[]): PivotChoice[] {
  const byWidget = new Map<string, BaseDimension>();
  for (const entry of raw) {
    const cut = entry.lastIndexOf(':');
    if (cut <= 0) continue;
    const dim = BaseDimensionSchema.safeParse(entry.slice(cut + 1));
    if (dim.success) byWidget.set(entry.slice(0, cut), dim.data);
  }
  return [...byWidget.entries()].map(([widget, dim]) => ({ widget, dim }));
}
