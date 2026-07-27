<script lang="ts">
import { barRows } from './bar-rows.ts';
import { compactNumber, exactNumber, METRIC_LABELS } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, data }: WidgetProps = $props();

const slice = $derived(sliceOf(data, 'main'));
const query = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query : undefined,
);
const metric = $derived(query?.metrics[0]);
const dim = $derived(query?.dim);
/** Label for the NULL group a breakdown can return (e.g. `Direct` under ref_domain). */
const nullLabel = $derived(
  typeof spec.options.nullLabel === 'string' ? spec.options.nullLabel : '(none)',
);
const unit = $derived(metric === undefined ? '' : METRIC_LABELS[metric].toLowerCase());

const rows = $derived(
  slice.kind === 'ready' && metric !== undefined && dim !== undefined
    ? barRows(slice.result.rows, metric, dim, nullLabel)
    : [],
);

/** docs/05: per-mark tooltips from the same designed hover layer as the chart's. */
let tip = $state<{ index: number; x: number; y: number } | undefined>();
let pane: HTMLDivElement | undefined = $state();

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

function showTip(row: HTMLElement, index: number, clientX?: number): void {
  if (pane === undefined) return;
  const rect = pane.getBoundingClientRect();
  // Pointer-led when hovering, centered when reached by keyboard focus.
  const x =
    clientX === undefined ? rect.width / 2 : clamp(clientX - rect.left, 40, rect.width - 40);
  tip = { index, x, y: row.offsetTop - 6 };
}

const tipRow = $derived(tip === undefined ? undefined : rows[tip.index]);
</script>

<h2>{spec.title ?? spec.id}</h2>
<div class="list-pane" bind:this={pane}>
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if rows.length === 0}
    <p class="widget-note">No data in this range.</p>
  {:else}
    <div class="bar-list">
      {#each rows as row, i (row.name)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions --
             docs/05 accessibility: every mark keyboard-reachable, with a focus/hover
             tooltip for the exact value; rows become interactive with click-to-filter (WP12) -->
        <div
          class="bar-row"
          tabindex="0"
          onpointermove={(event) => showTip(event.currentTarget, i, event.clientX)}
          onpointerleave={() => (tip = undefined)}
          onfocus={(event) => showTip(event.currentTarget, i)}
          onblur={() => (tip = undefined)}
        >
          <span class="bar" style="width: {row.pct}%"></span>
          <span class="name">{row.name}</span>
          <span class="num">{compactNumber(row.value)}</span>
        </div>
      {/each}
    </div>
    {#if tip !== undefined && tipRow !== undefined}
      <div
        class="chart-tip"
        style="left: {tip.x}px; top: {tip.y}px; transform: translate(-50%, -100%);"
      >
        <div class="tip-row">
          <span class="tip-val">{exactNumber(tipRow.value)}</span>
          <span class="tip-name">{unit}</span>
        </div>
      </div>
    {/if}
  {/if}
</div>
