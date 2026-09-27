<script lang="ts">
import type { Filter, FilterNode, Query, QueryRequest } from '@featherstat/shared';
import { DETAIL_TEMPLATES } from '@featherstat/shared/detail-templates';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import { dimLabel, sameFilter } from '../lib/filters.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import {
  type CompareChoice,
  compareNote,
  compareParam,
  type DetailRef,
  localDayKey,
  toRange,
  type ViewRange,
} from '../lib/state.ts';
import { dashboardEnv } from '../widgets/env.ts';
import { windowLabel } from '../widgets/format.ts';
import type { AppEnv } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';
import {
  collectBatch,
  hourlyWhenIntraday,
  wantsAnnotations,
  withoutBlockedMetrics,
} from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

/**
 * One entity's detail view (docs/05 § Detail views): a `DashboardGrid` over
 * the entity template for the drilled dimension — ordinary widgets, one batch
 * (invariants 1 & 7). The entity binding is baked into the template's widget
 * queries and shown as a LOCKED chip; the view's own removable chips compose
 * on top and ride the request's `filters`. Back is `history.back()` — the
 * drill that opened this pushed a history entry.
 */
interface Props {
  app: AppEnv;
  client: QueryClient;
  live: LiveStream;
  site: number;
  timezone: string | undefined;
  detail: DetailRef;
  range: ViewRange;
  cmp: CompareChoice;
  filters: FilterNode[];
  segmentNames?: ReadonlyMap<number, string>;
  onselectrange: (range: ViewRange) => void;
  onselectcmp: (cmp: CompareChoice) => void;
  onfilters: (filters: FilterNode[]) => void;
  /** Opens the shared expression editor (docs/05 § Filters). */
  oneditfilters?: () => void;
  /** Drill sideways (an "After this page" row → that page's own detail view). */
  onopendetail: (detail: DetailRef) => void;
}

let {
  app,
  client,
  live,
  site,
  timezone,
  detail,
  range,
  cmp,
  filters,
  segmentNames,
  onselectrange,
  onselectcmp,
  onfilters,
  oneditfilters,
  onopendetail,
}: Props = $props();

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

/** The entity template, built fresh at the current vocabulary on every visit. */
const template = $derived(DETAIL_TEMPLATES[detail.dim]);
const dashboard = $derived(template.build(site, detail.value));

const request = $derived.by<QueryRequest>(() => {
  const compare = compareParam(cmp);
  const queries: readonly Query[] = collectBatch(dashboard).queries;
  return {
    site,
    range: toRange(range),
    ...(compare === undefined ? {} : { compare }),
    ...(filters.length > 0 ? { filters } : {}),
    ...(wantsAnnotations(dashboard) ? { annotations: true as const } : {}),
    queries: withoutBlockedMetrics(hourlyWhenIntraday(queries, range), filters),
  };
});

$effect(() => {
  void dayKey;
  runner.run(request);
});
$effect(() =>
  createRevalidator(live, () => runner.refresh(), { site: () => site, key: () => request }),
);
const dayKey = $derived(localDayKey(timezone === undefined ? [] : [timezone], new Date(app.now)));

/** Click-to-filter composes ON TOP of the locked entity binding. */
function addFilter(filter: Filter): void {
  if (filters.some((existing) => sameFilter(existing, filter))) return;
  onfilters([...filters, filter]);
}

const heldRange = $derived.by<ViewRange>(() => {
  if (runner.held === undefined) return range;
  return 'preset' in runner.held.range ? runner.held.range.preset : runner.held.range;
});
const env = $derived(
  dashboardEnv(app, {
    scope: site,
    range: heldRange,
    onfilter: addFilter,
    ondrill: (dim, value) => onopendetail({ dim, value }),
    onpivot: null,
  }),
);
const span = $derived(windowLabel(runner.response?.meta.windows));
const note = $derived.by(() => {
  if (runner.error !== undefined && runner.response !== undefined) {
    return 'Live update failed — showing the last good result';
  }
  const compared = compareNote(heldRange, cmp) ?? 'no comparison';
  return span === undefined ? compared : `${span} · ${compared}`;
});
</script>

<div class="detail-head">
  <button class="btn slim" type="button" onclick={() => history.back()}>← Back</button>
  <h1 class="detail-title">{template.label} detail<span class="detail-value">{detail.value}</span></h1>
</div>
<FilterRow
  {range}
  {cmp}
  locked={[`${dimLabel(detail.dim)}: ${detail.value}`]}
  {filters}
  {segmentNames}
  {oneditfilters}
  {note}
  onselect={onselectrange}
  oncompare={onselectcmp}
  onremovefilter={(index) => onfilters(filters.filter((_, i) => i !== index))}
  onretry={runner.error === undefined ? undefined : () => runner.refresh()}
/>
<DashboardGrid
  {dashboard}
  response={runner.response}
  error={runner.error}
  refetching={runner.refetching}
  {env}
/>

<style>
  .detail-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding-top: 10px;
  }

  .detail-title {
    font-size: 16px;
    font-weight: 650;
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-value {
    margin-left: 8px;
    font-weight: 500;
    color: var(--ink-2);
  }
</style>
