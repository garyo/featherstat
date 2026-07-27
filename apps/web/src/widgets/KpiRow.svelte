<script lang="ts">
import { tileLabel, tileModels, tileNames } from './kpi.ts';
import Sparkline from './Sparkline.svelte';
import { fillBuckets } from './series.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, data, window }: WidgetProps = $props();

const names = $derived(tileNames(spec.options));
const main = $derived(sliceOf(data, 'main'));
const spark = $derived(sliceOf(data, 'spark'));
const metrics = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query.metrics : [],
);

const tiles = $derived.by(() => {
  if (main.kind !== 'ready') return undefined;
  // A per-query error on the companion series only costs the sparklines.
  const series = spark.kind === 'ready' ? fillBuckets(spark.result.rows, metrics, window) : [];
  return tileModels(names, main.result.rows[0], main.result.compare?.[0], series);
});
</script>

{#if main.kind === 'error'}
  <div class="kpis"><p class="widget-note">{main.message}</p></div>
{:else if tiles === undefined}
  <div class="kpis">
    {#each names as name (name)}
      <div class="tile">
        <div class="label">{tileLabel(name)}</div>
        <div class="row"><div class="value loading">—</div></div>
        <div class="spark"></div>
      </div>
    {/each}
  </div>
{:else}
  <div class="kpis">
    {#each tiles as tile (tile.name)}
      <div class="tile">
        <div class="label">{tile.label}</div>
        <div class="row">
          <div class="value" class:na={tile.value === '—'} title={tile.exact}>{tile.value}</div>
          <div class="delta {tile.delta.tone}">{tile.delta.text}</div>
        </div>
        <!-- A one-point series (e.g. the day-bucketed spark under "today") draws
             nothing, so the box collapses rather than leaving a hole. -->
        {#if tile.spark.length > 1}
          <div class="spark">
            <Sparkline data={tile.spark} width={150} height={34} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .value.loading,
  .value.na {
    /* An empty tile must read as "no data", not as a redaction bar of full ink. */
    color: var(--muted);
  }
</style>
