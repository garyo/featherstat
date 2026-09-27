import type { Filter, QueryResponse, VizType } from '@featherstat/shared';
import { rangeQualifier, type SiteScope, type ViewRange } from '../lib/state.ts';
import type { AppEnv, Capability, GridEnv, ViewEnv, WidgetEnv } from './types.ts';

/**
 * What each viz requires of its environment (`WidgetEnv`), and what a page does
 * when it cannot provide it.
 *
 * Exhaustive over the shared `VizType` enum — a new viz cannot ship without
 * saying what it reads. It lives here rather than in `registry.ts` because that
 * module imports every widget component: a table beside them could not be read
 * by a test until something can render Svelte, and this one is checked by
 * `env.test.ts` today.
 *
 * `data` is also CLAUDE.md invariant 7's last sentence made machine-readable —
 * a widget declares a query or declares none; the realtime family asks the
 * batch for nothing.
 */
export const NEEDS: Record<VizType, readonly Capability[]> = {
  'kpi-row': ['data'],
  timeseries: ['data'],
  'bar-list': ['data'],
  table: ['data'],
  heatmap: ['data'],
  devices: ['data'],
  dwell: ['data'],
  histogram: ['data'],
  changes: ['data'],
  map: ['data'],
  'site-cards': ['data'],
  feed: ['realtime'],
  'active-now': ['realtime'],
  'visitor-tally': ['realtime'],
  'realtime-countries': ['realtime'],
};

/** The first capability this viz needs and this environment does not have. */
export function missingCapability(viz: VizType, env: WidgetEnv): Capability | undefined {
  return NEEDS[viz].find((need) => env[need] === null);
}

/**
 * Why a card is not drawing, said once, centrally (`WidgetGrid`). Per-widget
 * guards were the alternative and mostly did not exist: a shared page rendered
 * "No located visitors in the last 30 minutes" and an active-now hero reading 0
 * when the truth was that the page has no stream to read.
 */
export const CAPABILITY_NOTE: Record<Capability, string> = {
  data: 'No query results on this page — nothing here runs a batch.',
  realtime: 'No live stream on this page — realtime runs in the app, not behind a share link.',
};

/** What only the view knows: the scope and range on screen, and whether a
 *  breakdown row can add a filter chip, drill into a detail view, or pivot
 *  its widget's breakdown. */
export interface ViewContext {
  scope: SiteScope;
  range: ViewRange;
  onfilter: ((filter: Filter) => void) | null;
  ondrill: WidgetEnv['ondrill'];
  onpivot: WidgetEnv['onpivot'];
}

/**
 * The one place a dashboard's environment is assembled: what the app can offer,
 * plus what only the view knows. SiteView and AllSitesView hand the SAME value
 * to the dashboard grid and to the editor's preview, so the preview can no
 * longer render with fewer capabilities than the page behind it — it used to
 * lose the range, the filter callback and the realtime jump, because each was a
 * prop the caller had to remember twice.
 */
export function dashboardEnv(app: AppEnv, view: ViewContext): ViewEnv {
  return extendEnv(app, {
    scope: view.scope,
    rangeLabel: rangeQualifier(view.range),
    onfilter: view.onfilter,
    ondrill: view.ondrill,
    onpivot: view.onpivot,
  });
}

/**
 * The environment a grid renders from: the view's, plus the windows and
 * annotations of the response on screen — read here rather than passed, so the
 * axes and markers a widget draws always belong to the answer beside them.
 */
export function gridEnv(env: ViewEnv, response: QueryResponse | undefined): GridEnv {
  return extendEnv(env, {
    windows: response?.meta.windows ?? null,
    annotations: response?.meta.annotations ?? null,
  });
}

/**
 * `{ ...base, ...extra }` that keeps `base`'s getters as getters. The app's
 * clock and live stream are getters over reactive state (Shell.svelte), so a
 * widget subscribes to exactly the members it reads; a spread would read them
 * all while the env is built, and every hit and every clock tick would then
 * rebuild the env — and so re-derive every widget on the page.
 */
export function extendEnv<Base extends object, Extra extends object>(
  base: Base,
  extra: Extra,
): Omit<Base, keyof Extra> & Extra {
  return Object.defineProperties(
    {},
    { ...Object.getOwnPropertyDescriptors(base), ...Object.getOwnPropertyDescriptors(extra) },
  ) as Omit<Base, keyof Extra> & Extra;
}
