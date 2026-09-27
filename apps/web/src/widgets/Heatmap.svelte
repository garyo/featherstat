<script lang="ts">
import DataTable from './DataTable.svelte';
import { exactNumber, metricLabel } from './format.ts';
import { cellTitle, HEATMAP_DAYS, type HeatmapCell, heatmapCells } from './heatmap.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * Hour × weekday heatmap (docs/05, mockup "Traffic by hour"): sequential --hm
 * steps, zero cells receding to the surface, a per-cell tooltip with the exact
 * value. Pure CSS grid — no chart engine.
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const metric = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query.metrics[0] : undefined,
);
const unit = $derived(metric === undefined ? '' : metricLabel(metric).toLowerCase());
const cells = $derived(
  slice.kind === 'ready' && metric !== undefined ? heatmapCells(slice.result.rows, metric) : [],
);
const empty = $derived(cells.every((cell) => cell.value === 0));

let tip = $state<{ cell: HeatmapCell; x: number; y: number } | undefined>();
let pane: HTMLDivElement | undefined = $state();

function showTip(cell: HeatmapCell, event: PointerEvent): void {
  if (pane === undefined) return;
  const rect = pane.getBoundingClientRect();
  const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
  tip = {
    cell,
    x: Math.max(48, Math.min(event.clientX - rect.left, rect.width - 48)),
    y: target.top - rect.top - 6,
  };
}
</script>

<h2>{spec.title ?? 'Traffic by hour'}{env.rangeLabel === null ? '' : ` · ${env.rangeLabel}`}</h2>
{#if slice.kind === 'loading'}
  <p class="widget-note">Loading…</p>
{:else if slice.kind === 'error'}
  <p class="widget-note">{slice.message}</p>
{:else if empty}
  <p class="widget-note">No data in this range.</p>
{:else}
  <!-- The grid scrolls inside its own pane on narrow screens instead of
       smearing 24 columns into unreadable dots (docs/05 responsive). -->
  <div class="heatmap-scroll">
    <div class="heatmap" bind:this={pane}>
      <div class="hm-days">
        {#each HEATMAP_DAYS as day (day)}<span>{day}</span>{/each}
      </div>
      <div class="hm-cells">
        {#each cells as cell (cell.day * 24 + cell.hour)}
          <!-- svelte-ignore a11y_no_static_element_interactions --
               tooltips enhance, never gate (docs/05): the exact values live in the
               cells' sequential fills, this hover layer, and the visually-hidden
               table below for keyboard/screen-reader users; cells are not controls -->
          <div
            class="hm-cell {cell.level > 0 ? `b${cell.level}` : ''}"
            onpointermove={(event) => showTip(cell, event)}
            onpointerleave={() => (tip = undefined)}
          ></div>
        {/each}
      </div>
      <div class="hm-hours">
        {#each { length: 24 }, hour}
          <span>{hour % 4 === 0 ? hour : ''}</span>
        {/each}
      </div>
      {#if tip !== undefined}
        <div
          class="chart-tip"
          style="left: {tip.x}px; top: {tip.y}px; transform: translate(-50%, -100%);"
        >
          <div class="tip-title">{cellTitle(tip.cell)}</div>
          <div class="tip-row">
            <span class="tip-val">{exactNumber(tip.cell.value)}</span>
            <span class="tip-name">{unit}</span>
          </div>
        </div>
      {/if}
    </div>
  </div>
  <DataTable
    caption="{spec.title ?? 'Traffic by hour'} — exact {unit} per hour and weekday"
    rows={HEATMAP_DAYS.map((day, dayIndex) => ({
      key: day,
      label: day,
      cells: cells
        .filter((cell) => cell.day === dayIndex)
        .map((cell) => `${cell.hour}:00 — ${exactNumber(cell.value)}`),
    }))}
  />
{/if}
