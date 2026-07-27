<script lang="ts">
import type { Dashboard, Filter, QueryResponse, SiteInfo, WidgetSpec } from '@analytics/shared';
import { REGISTRY, spanClass } from '../widgets/registry.ts';
import type { WidgetData } from '../widgets/types.ts';
import { collectBatch } from './batch.ts';

interface Props {
  dashboard: Dashboard;
  response: QueryResponse | undefined;
  /** Batch-level failure — widgets surface it when there is nothing older to show. */
  error: string | undefined;
  refetching: boolean;
  /** The requested site-local window, for charts to pad their series out to. */
  window?: { from: string; to: string };
  /** Range qualifier for widget titles ("last 30 days"). */
  rangeLabel?: string;
  active?: Record<number, number>;
  sites?: ReadonlyMap<number, SiteInfo>;
  onselectsite?: (site: number) => void;
  onfilter?: (filter: Filter) => void;
}

let {
  dashboard,
  response,
  error,
  refetching,
  window,
  rangeLabel,
  active,
  sites,
  onselectsite,
  onfilter,
}: Props = $props();

const slots = $derived(collectBatch(dashboard).slots);

function dataFor(spec: WidgetSpec): WidgetData {
  if (response === undefined) {
    return { phase: error === undefined ? 'loading' : 'error', message: error, results: {} };
  }
  const ids = slots.get(spec.id) ?? {};
  const results: WidgetData['results'] = {};
  for (const [slot, id] of Object.entries(ids)) results[slot] = response.results[id];
  return { phase: 'ready', results };
}
</script>

<div class="grid" class:refetching>
  {#each dashboard.grid as spec (spec.id)}
    {@const entry = REGISTRY[spec.viz]}
    {#if entry === undefined}
      <div class="card {spanClass(spec.w)}">
        <h2>{spec.title ?? spec.viz}</h2>
        <p class="widget-note">The “{spec.viz}” widget isn’t available yet.</p>
      </div>
    {:else}
      {@const Widget = entry.component}
      {#if entry.frame === 'card'}
        <div class="card {spanClass(spec.w)}">
          <Widget
            {spec}
            data={dataFor(spec)}
            {window}
            {rangeLabel}
            {active}
            {sites}
            {onselectsite}
            {onfilter}
          />
        </div>
      {:else}
        <div class="wide">
          <Widget
            {spec}
            data={dataFor(spec)}
            {window}
            {rangeLabel}
            {active}
            {sites}
            {onselectsite}
            {onfilter}
          />
        </div>
      {/if}
    {/if}
  {/each}
</div>

<style>
  /* The refetch hold (docs/05): previous render stays, dimmed — never a skeleton. */
  .grid {
    transition: opacity 0.15s linear;
  }

  .grid.refetching {
    opacity: 0.6;
  }

  .wide {
    grid-column: 1 / -1;
    min-width: 0;
  }
</style>
