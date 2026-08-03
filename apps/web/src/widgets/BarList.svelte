<script lang="ts">
import type { BaseDimension } from '@featherstat/shared';
import { dimLabel } from '../lib/filters.ts';
import { isPivotable, pivotDims } from '../lib/pivots.ts';
import BarRows from './BarRows.svelte';
import { barRows } from './bar-rows.ts';
import { metricLabel } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const query = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query : undefined,
);
/** An `adjacency` result renders through the same rows: label × sessions. */
const adjacency = $derived(
  spec.query !== undefined && 'kind' in spec.query && spec.query.kind === 'adjacency',
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
const unit = $derived(
  adjacency ? 'sessions' : metric === undefined ? '' : metricLabel(metric).toLowerCase(),
);
const extraUnit = $derived(
  extraMetric === undefined ? undefined : metricLabel(extraMetric).toLowerCase(),
);

/** The pivot control (docs/05 § Pivots): the title becomes a breakdown picker. */
const pivotable = $derived(env.onpivot !== null && isPivotable(spec) && query?.dim !== undefined);

const rows = $derived.by(() => {
  if (slice.kind !== 'ready') return [];
  if (adjacency) return barRows(slice.result.rows, 'sessions', 'label', '(none)');
  if (metric === undefined || dim === undefined) return [];
  const merged = barRows(slice.result.rows, metric, dim, nullLabel, {
    dim2: query?.dim2,
    extraMetric,
  });
  // Path queries over-fetch for the variant merge (queries.ts) — trim back to
  // the widget's intended count so Top pages shows 8 rows, like Referrers.
  return query?.limit === undefined ? merged : merged.slice(0, query.limit);
});
</script>

<!-- Untitled + pivotable is a PIVOTED spec (applyPivots stripped the title):
     the picker is the whole heading, so no stale title contradicts the rows. -->
<h2 class="pivot-head">
  {#if pivotable && query !== undefined}
    {#if spec.title !== undefined}{spec.title}
      ·
    {/if}
    <select
      aria-label="Breakdown"
      value={query.dim}
      onchange={(event) => env.onpivot?.(spec.id, event.currentTarget.value as BaseDimension)}
    >
      {#each pivotDims(query.metrics) as option (option)}
        <option value={option}>{dimLabel(option)}</option>
      {/each}
    </select>
  {:else}
    {spec.title ?? spec.id}
  {/if}
</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if rows.length === 0}
    <p class="widget-note">No data in this range.</p>
  {:else if adjacency}
    <BarRows {rows} {unit} onfilter={null} />
  {:else}
    <BarRows {rows} {unit} {extraUnit} {flags} {dim} onfilter={env.onfilter} ondrill={env.ondrill} />
  {/if}
</div>
