<script lang="ts">
import ApproxMark from './ApproxMark.svelte';
import { resultAxes, sharedKeys } from './axis.ts';
import { tileLabel, tileModels, tileNames } from './kpi.ts';
import Sparkline from './Sparkline.svelte';
import { seriesOf } from './series.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, env }: WidgetProps = $props();

const names = $derived(tileNames(spec.options));
const main = $derived(sliceOf(env.data, 'main'));
const spark = $derived(sliceOf(env.data, 'spark'));
const metrics = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query.metrics : [],
);

const tiles = $derived.by(() => {
  if (main.kind !== 'ready') return undefined;
  // A per-query error on the companion series only costs the sparklines.
  const series =
    spark.kind === 'ready'
      ? seriesOf(
          spark.result.rows,
          metrics,
          sharedKeys(resultAxes(spark.result, env.windows ?? [], env.now)),
        )
      : [];
  return tileModels(names, {
    totals: main.result.rows[0],
    compare: main.result.compare?.[0],
    series,
    // The tile reads its unit and its aggregate off the answer it was handed,
    // so the number and its sparkline cannot end up on different scales.
    measures: main.result.measures,
    seriesMeasures: spark.kind === 'ready' ? spark.result.measures : undefined,
  });
});
</script>

<!-- Usually a bare strip; a titled row (the detail views' boundary KPIs —
     "Sessions entering here") says what its tiles are counting. -->
{#if spec.title !== undefined}
  <h2>{spec.title}</h2>
{/if}
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
        <div class="label">
          {tile.label}{#if tile.approximate}<ApproxMark />{/if}
        </div>
        <div class="row">
          <div class="value" class:na={tile.value === '—'} title={tile.exact}>{tile.value}</div>
          <div class="delta {tile.delta.tone}">{tile.delta.text}</div>
        </div>
        <!-- A one-point series draws nothing, so the box collapses rather than
             leaving a hole. The scale beside the line is what gives its shape
             a magnitude. -->
        {#if tile.spark.length > 1}
          <div class="spark">
            <Sparkline data={tile.spark} width={150} height={34} />
            {#if tile.scale !== undefined}
              <div class="scale" aria-label="range across the period">
                <span>{tile.scale.peak}</span>
                {#if tile.scale.floor !== undefined}<span>{tile.scale.floor}</span>{/if}
              </div>
            {/if}
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
