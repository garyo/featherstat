import type { VizType } from '@featherstat/shared';

/** What a reader calls each visualization — exhaustive, so a new viz cannot ship unnamed. */
export const VIZ_LABELS: Record<VizType, string> = {
  'kpi-row': 'KPI row',
  timeseries: 'Time series',
  'bar-list': 'Ranked list',
  table: 'Table',
  heatmap: 'Hour × weekday heatmap',
  devices: 'Devices',
  dwell: 'Time on page',
  histogram: 'Histogram',
  changes: 'What changed',
  map: 'Map',
  feed: 'Live feed',
  'active-now': 'Active now',
  'visitor-tally': 'Visitor tally',
  'realtime-countries': 'Live countries',
  'site-cards': 'Site cards',
};
