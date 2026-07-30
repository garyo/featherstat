<script lang="ts">
import BarRows from './BarRows.svelte';
import { barRows } from './bar-rows.ts';
import { type DeviceSegment, deviceSegments } from './devices.ts';
import { exactNumber, METRIC_LABELS } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * The mockup's "Devices & browsers" card: a stacked device bar (≤ 3 segments,
 * 2px surface gaps, inline labels only where they fit) over a browsers
 * bar-list below a divider. One widget, two queries in the same batch.
 */
let { spec, env }: WidgetProps = $props();

/** Categorical slots in fixed order, assigned by rank, never cycled (docs/05). */
const SLOT_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
/** Ink over each slot — the mockup's pairing, readable on both themes' steps. */
const LABEL_INKS = ['#fff', '#0b0b0b', '#fff'];
/** Below this share the inline label cannot fit (mockup: tablet at 6% goes bare);
 * a clipped label is worse than none — the legend still carries the name. */
const MIN_LABEL_SHARE = 22;

const main = $derived(sliceOf(env.data, 'main'));
const browsers = $derived(sliceOf(env.data, 'browsers'));
const metric = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query.metrics[0] : undefined,
);
const unit = $derived(metric === undefined ? '' : METRIC_LABELS[metric].toLowerCase());

const segments = $derived(
  main.kind === 'ready' && metric !== undefined ? deviceSegments(main.result.rows, metric) : [],
);
const browserRows = $derived(
  browsers.kind === 'ready' && metric !== undefined
    ? barRows(browsers.result.rows, metric, 'browser', '(unknown)')
    : [],
);

function activate(segment: DeviceSegment): void {
  if (env.onfilter === null || segment.filterValue === undefined) return;
  env.onfilter({ dim: 'device_type', op: 'eq', value: segment.filterValue });
}

function onKeydown(event: KeyboardEvent, segment: DeviceSegment): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate(segment);
  }
}

let tip = $state<{ segment: DeviceSegment; x: number } | undefined>();
let stackEl: HTMLDivElement | undefined = $state();

function showTip(segment: DeviceSegment, clientX?: number): void {
  if (stackEl === undefined) return;
  const rect = stackEl.getBoundingClientRect();
  const x =
    clientX === undefined
      ? rect.width / 2
      : Math.max(40, Math.min(clientX - rect.left, rect.width - 40));
  tip = { segment, x };
}
</script>

<h2>{spec.title ?? 'Devices & browsers'}</h2>
{#if main.kind === 'loading'}
  <p class="widget-note">Loading…</p>
{:else if main.kind === 'error'}
  <p class="widget-note">{main.message}</p>
{:else if segments.length === 0}
  <p class="widget-note">No data in this range.</p>
{:else}
  <div class="stack-wrap">
    <div class="stack" bind:this={stackEl}>
      {#each segments as segment (segment.name)}
        {@const clickable = env.onfilter !== null && segment.filterValue !== undefined}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions --
             every mark keyboard-reachable (docs/05); named segments click-to-filter -->
        <div
          class="seg"
          class:clickable
          role={clickable ? 'button' : undefined}
          tabindex="0"
          aria-label="{segment.name} {segment.pct}%"
          style="width: {segment.share}%; background: {SLOT_COLORS[segment.slot]};"
          onclick={clickable ? () => activate(segment) : undefined}
          onkeydown={clickable ? (event) => onKeydown(event, segment) : undefined}
          onpointermove={(event) => showTip(segment, event.clientX)}
          onpointerleave={() => (tip = undefined)}
          onfocus={() => showTip(segment)}
          onblur={() => (tip = undefined)}
        >
          {#if segment.share >= MIN_LABEL_SHARE}
            <span class="seg-label" style="color: {LABEL_INKS[segment.slot]};">
              {segment.name}
              {segment.pct}%
            </span>
          {/if}
        </div>
      {/each}
    </div>
    {#if tip !== undefined}
      <div class="chart-tip" style="left: {tip.x}px; top: -6px; transform: translate(-50%, -100%);">
        <div class="tip-row">
          <span class="tip-key" style="border-color: {SLOT_COLORS[tip.segment.slot]};"></span>
          <span class="tip-val">{tip.segment.pct}%</span>
          <span class="tip-name">{tip.segment.name} · {exactNumber(tip.segment.value)} {unit}</span>
        </div>
      </div>
    {/if}
  </div>
  <div class="legend">
    {#each segments as segment (segment.name)}
      <span class="key">
        <span class="swatch" style="background: {SLOT_COLORS[segment.slot]};"></span>{segment.name}
      </span>
    {/each}
  </div>
  <hr class="divider" />
  {#if browsers.kind === 'error'}
    <p class="widget-note">{browsers.message}</p>
  {:else if browserRows.length === 0}
    <p class="widget-note">No browser data.</p>
  {:else}
    <BarRows rows={browserRows} {unit} dim="browser" onfilter={env.onfilter} />
  {/if}
{/if}
