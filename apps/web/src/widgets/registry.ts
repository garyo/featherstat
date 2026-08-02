import type { VizType } from '@featherstat/shared';
import type { Component } from 'svelte';
import ActiveNow from './ActiveNow.svelte';
import BarList from './BarList.svelte';
import Devices from './Devices.svelte';
import Dwell from './Dwell.svelte';
import Feed from './Feed.svelte';
import Heatmap from './Heatmap.svelte';
import Histogram from './Histogram.svelte';
import KpiRow from './KpiRow.svelte';
import RealtimeCountries from './RealtimeCountries.svelte';
import SiteCards from './SiteCards.svelte';
import Timeseries from './Timeseries.svelte';
import type { WidgetProps } from './types.ts';
import VisitorTally from './VisitorTally.svelte';
import './widgets.css';

/**
 * viz type → renderer, instantiated from dashboard JSON (docs/05: a registry is
 * how the view is built even without editability). Unregistered viz types render
 * as a placeholder card, never break the dashboard — as does a viz whose
 * environment cannot feed it (`env.ts` NEEDS, which is where each viz declares
 * what it reads; it lives beside this table rather than in it because this
 * module imports every component and so cannot be read by a test).
 *
 * SECURITY BOUNDARY: everything a widget prints — paths, page titles, referrer
 * domains, event names — is visitor-controlled text straight from tracked
 * traffic. Components under this registry render those strings through Svelte
 * text interpolation ONLY: never {@html}, never innerHTML. Svelte's escaping is
 * the XSS defense here.
 */
export interface RegistryEntry {
  component: Component<WidgetProps>;
  /** 'card': the grid wraps it in a spanned `.card`; 'wide': full row, frames itself. */
  frame: 'card' | 'wide';
}

export const REGISTRY: Partial<Record<VizType, RegistryEntry>> = {
  'kpi-row': { component: KpiRow, frame: 'wide' },
  timeseries: { component: Timeseries, frame: 'card' },
  'bar-list': { component: BarList, frame: 'card' },
  feed: { component: Feed, frame: 'card' },
  'active-now': { component: ActiveNow, frame: 'card' },
  'visitor-tally': { component: VisitorTally, frame: 'card' },
  'realtime-countries': { component: RealtimeCountries, frame: 'card' },
  heatmap: { component: Heatmap, frame: 'card' },
  devices: { component: Devices, frame: 'card' },
  dwell: { component: Dwell, frame: 'card' },
  histogram: { component: Histogram, frame: 'card' },
  'site-cards': { component: SiteCards, frame: 'wide' },
};

/** Span class in the 12-column grid vocabulary (layout.css); wider spans fill the row. */
export function spanClass(w: number): string {
  if (w <= 3) return 'c3';
  if (w <= 4) return 'c4';
  if (w <= 6) return 'c6';
  return '';
}
