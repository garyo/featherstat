<script lang="ts">
import BarRows from './BarRows.svelte';
import { barRows } from './bar-rows.ts';
import { METRIC_LABELS } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, data, onfilter }: WidgetProps = $props();

const slice = $derived(sliceOf(data, 'main'));
const query = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query : undefined,
);
const metric = $derived(query?.metrics[0]);
const extraMetric = $derived(query?.metrics[1]);
const dim = $derived(query?.dim);
/** Label for the NULL group a breakdown can return (e.g. `Direct` under ref_domain). */
const nullLabel = $derived(
  typeof spec.options.nullLabel === 'string' ? spec.options.nullLabel : '(none)',
);
/** Country-code rows get flag + display name (geo card). */
const flags = $derived(spec.options.flags === true);
const unit = $derived(metric === undefined ? '' : METRIC_LABELS[metric].toLowerCase());
const extraUnit = $derived(
  extraMetric === undefined ? undefined : METRIC_LABELS[extraMetric].toLowerCase(),
);

const rows = $derived.by(() => {
  if (slice.kind !== 'ready' || metric === undefined || dim === undefined) return [];
  const merged = barRows(slice.result.rows, metric, dim, nullLabel, {
    dim2: query?.dim2,
    extraMetric,
  });
  // Path queries over-fetch for the variant merge (queries.ts) — trim back to
  // the widget's intended count so Top pages shows 8 rows, like Referrers.
  return query?.limit === undefined ? merged : merged.slice(0, query.limit);
});
</script>

<h2>{spec.title ?? spec.id}</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if rows.length === 0}
    <p class="widget-note">No data in this range.</p>
  {:else}
    <BarRows {rows} {unit} {extraUnit} {flags} {dim} {onfilter} />
  {/if}
</div>
